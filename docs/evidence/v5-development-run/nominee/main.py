import json, sys, time, copy
import pandas as pd
import model as M
import gbm as G

RUN_BACKTEST = True


def log(*a):
    print(*a, file=sys.stderr)


def run(ctx, arg):
    ref = ctx["reference"]
    roster_ids = [str(r["playerId"]) for r in ctx["roster"]]
    try:
        t0 = time.time()
        con, sch, dall = G.load_all()
        team = str(ctx["teamId"])
        pids = set(roster_ids)
        for g in ctx.get("referenceHistory") or []:
            for p in g["forecast"]["players"]:
                pids.add(str(p["playerId"]))
        sch2 = pd.read_sql("select game_id, season from schedule", con)
        sch2["game_id"] = sch2["game_id"].astype(str)
        cur = sch2[sch2.game_id == str(ctx["gameId"])]
        season = cur.iloc[0]["season"] if len(cur) else None
        d = dall
        if season is not None:
            d = d[d["season"] == season]
        d = d[d.player_id.isin(pids)].copy()
        log("load %.1fs rows_all %d rows %d season %s" % (time.time() - t0, len(dall), len(d), season))
        P = dict(M.DEFAULT_P)
        inact = {str(r["playerId"]): bool(r.get("inactive")) for r in ctx["roster"]}
        hist_gids = [str(g["gameId"]) for g in (ctx.get("referenceHistory") or [])]
        gb = {}
        try:
            gb = G.fit_and_predict(dall, ctx, inact, hist_gids)
        except Exception as ex:
            import traceback
            log("gbm error", repr(ex), traceback.format_exc()[-1200:])
        recs = []
        try:
            recs = M.history_records(ctx, con, d)
        except Exception as ex:
            log("history error", repr(ex))
        for rec in recs:
            rec[1]["__gbm__"] = gb.get(rec[1].get("__gid__"), {})
        # online choice of the GBM blend weight from this team's own earlier games
        WCHOICES = {"w0": 0.0, "w25": 0.25, "w50": 0.5}
        chosen = "w25"
        sel_summ = None
        if recs:
            try:
                t1 = time.time()
                variants = {}
                for nm, w in WCHOICES.items():
                    v = dict(P); v["gbm_w"] = w; variants[nm] = v
                sel_summ = M.backtest(recs, variants, tier_variants=())
                chosen, honest = M.online_select(sel_summ["_per"], sel_summ["_ref"], list(WCHOICES), "w25")
                log("SELECT", json.dumps({k: sel_summ.get(k) for k in ["n", "ref"] + list(WCHOICES)}),
                    "chosen", chosen, "honest_sel_ratio", None if honest is None else round(honest, 4),
                    "secs %.1f" % (time.time() - t1))
            except Exception as ex:
                log("select error", repr(ex))
        P["gbm_w"] = WCHOICES.get(chosen, 0.25)
        prev = []
        for refp, info_h, actual, played in recs:
            s1 = M.adjust(refp, info_h, P)
            s1 = M.gbm_blend(s1, info_h, P)
            prev.append(M.stage1_obs(s1, actual, played))
        info = M.build_info(con, d, ctx, team, ctx["gameId"], ctx["tip"], inact)
        info["__gbm__"] = gb.get(str(ctx["gameId"]), {})
        info["__n_inact__"] = sum(1 for v in inact.values() if v)
        lu = info.get("__lineup__")
        log("lineup", None if lu is None else len(lu["ids"]), "inactive", sum(inact.values()), "hist", len(recs),
            "gbm_players", len(info["__gbm__"]))
        notes = {}
        _, players = M.full_forecast(ref["players"], info, P, prev, notes)
        try:
            players = M.scale_production(ref["players"], players)
        except Exception as ex:
            log("scale_production error", repr(ex))
        log("notes", json.dumps(notes)[:1500])
        fc = {"version": "forecast-v1", "gameId": ctx["gameId"], "players": players}
        if RUN_BACKTEST and recs and len(recs) < 25:
            try:
                g0 = dict(P)
                ev = {"cur": g0}
                for nm, ov in [("w0", {"gbm_w": 0.0}), ("w50", {"gbm_w": 0.5}), ("ramp5", {"gbm_ramp": 5.0}),
                               ("imp", {"gbm_impute": True}), ("imp50", {"gbm_impute": True, "gbm_w": 0.5}),
                               ("red0", {"redistribute": 0.0}), ("red05", {"redistribute": 0.5}),
                               ("noshift", {"role_shift": False}), ("bump4", {"start_bump": 4.0}),
                               ("nolineup", {"use_lineup": False}), ("noqcal", {"use_qcal": False}),
                               ("nomed", {"med_w": 0.0})]:
                    v = dict(g0); v.update(ov); ev[nm] = v
                es = M.backtest(recs, ev, min_prev=0, tier_variants=("cur",))
                es.pop("_per", None); es.pop("_ref", None)
                log("EARLYBT", json.dumps(es))
            except Exception as ex:
                log("early backtest error", repr(ex))
        if RUN_BACKTEST and recs:
            try:
                base = dict(P)
                base["gbm_w"] = 0.0; base["gbm_pw"] = 0.0
                variants = {"base": base}
                g25 = dict(base); g25["gbm_w"] = 0.25
                variants["g25"] = g25
                for nm, ov in [("nolu", {"use_lineup": False}), ("w50", {"gbm_w": 0.5}),
                               ("ramp5", {"gbm_ramp": 5.0}), ("bump4", {"start_bump": 4.0})]:
                    v = dict(g25); v.update(ov); variants[nm] = v
                t1 = time.time()
                summ = M.backtest(recs, variants, tier_variants=("g25",))
                summ.pop("_per", None); summ.pop("_ref", None)
                summ["secs"] = round(time.time() - t1, 1)
                log("BACKTEST", json.dumps(summ))
            except Exception as ex:
                import traceback
                log("backtest error", repr(ex), traceback.format_exc()[-800:])
        if M.valid_forecast(fc, roster_ids):
            return {"type": "finish", "forecast": fc}
        log("invalid forecast; fallback")
    except Exception as ex:
        import traceback
        log("error", repr(ex), traceback.format_exc()[-1500:])
    return {"type": "finish", "forecast": ref}
