import json, sys, time, copy
import pandas as pd
import numpy as np
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
            rec[1]["__abs__"] = gb.get("__abs__")
            rec[1]["__lst__"] = gb.get("__lst__")
            rec[1]["__inj__"] = (gb.get("__inj__") or {}).get(rec[1].get("__gid__"), {})
            spr = gb.get("__spr__") or {}
            rec[1]["__sprm__"] = spr.get("model")
            rec[1]["__apm__"] = (spr.get("hist") or {}).get(rec[1].get("__gid__"))
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
            s1 = M.absence_adjust(s1, info_h, P)
            s1 = M.spread_adjust(s1, info_h, P)
            s1 = M.gbm_blend(s1, info_h, P)
            s1 = M.listed_adjust(s1, info_h, P)
            prev.append(M.stage1_obs(s1, actual, played))
        info = M.build_info(con, d, ctx, team, ctx["gameId"], ctx["tip"], inact)
        info["__gbm__"] = gb.get(str(ctx["gameId"]), {})
        info["__abs__"] = gb.get("__abs__")
        info["__lst__"] = gb.get("__lst__")
        info["__inj__"] = (gb.get("__inj__") or {}).get(str(ctx["gameId"]), {})
        spr = gb.get("__spr__") or {}
        info["__sprm__"] = spr.get("model")
        sp = ctx.get("spread")
        try:
            info["__apm__"] = abs(float(sp)) if sp is not None else spr.get("proxy_tonight")
        except Exception:
            info["__apm__"] = spr.get("proxy_tonight")
        log("spread", sp, "proxy", spr.get("proxy_tonight"), "apm_used", info["__apm__"])
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
                for nm, ov in [("norm0", {"norm_w": 0.0}), ("abs0", {"abs_w": 0.0}), ("w0", {"gbm_w": 0.0}),
                               ("nolineup", {"use_lineup": False})]:
                    v = dict(g0); v.update(ov); ev[nm] = v
                es = M.backtest(recs, ev, min_prev=0, tier_variants=("cur",))
                es.pop("_per", None); es.pop("_ref", None)
                log("EARLYBT", json.dumps(es))
            except Exception as ex:
                log("early backtest error", repr(ex))
        if RUN_BACKTEST and recs:
            try:
                # diagnostic: reference conditional median error by absence bucket
                try:
                    acc = {}
                    for refp, info_h, actual, played in recs:
                        gbh = info_h.get("__gbm__") or {}
                        for p in refp:
                            pid = str(p["playerId"])
                            g = gbh.get(pid)
                            if g is None or not played.get(pid) or g.get("np", 0) < 1 or p["minutes"][3] < 8:
                                continue
                            b = M.gap_bucket_m(g.get("gap", 0))
                            acc.setdefault(b, []).append(actual[pid] - p["minutes"][3])
                    log("REFERR_BY_GAP", json.dumps({k: [round(float(np.mean(v)), 2), len(v)] for k, v in sorted(acc.items())}))
                except Exception as ex:
                    log("referr error", repr(ex))
                g25 = dict(P); g25["gbm_w"] = 0.25
                variants = {"g25": g25}
                for nm, ov in [("lst1", {"lst_w": 1.0}), ("abs0", {"abs_w": 0.0}), ("w0", {"gbm_w": 0.0}),
                               ("nolineup", {"use_lineup": False}), ("norm0", {"norm_w": 0.0}),
                               ("norm50", {"norm_w": 0.5})]:
                    v = dict(g25); v.update(ov); variants[nm] = v
                t1 = time.time()
                try:
                    nl = {}
                    for refp, info_h, actual, played in recs:
                        for pid, s in (info_h.get("__inj__") or {}).items():
                            if s in M.LISTED and played.get(pid):
                                nl[s] = nl.get(s, 0) + 1
                    log("LISTED_PLAYED_HIST", json.dumps(nl))
                    # team minutes sum diagnostic: reference vs ours (median and 7-quantile mean) vs actual
                    rows = []
                    for i, (refp, info_h, actual, played) in enumerate(recs):
                        _, new = M.full_forecast(refp, info_h, g25, prev[:i])
                        def sums(pl):
                            return (sum(p["p_play"] * p["minutes"][3] for p in pl),
                                    sum(p["p_play"] * float(np.mean(p["minutes"])) for p in pl))
                        a = sum(actual.values())
                        rm, ra = sums(refp); om, oa = sums(new)
                        rows.append([a, rm, ra, om, oa])
                    R = np.array(rows)
                    log("MINSUM", json.dumps({"n": len(rows), "mean": [round(float(x), 1) for x in R.mean(0)],
                                              "sd_ref_med_err": round(float(np.std(R[:, 1] - R[:, 0])), 1),
                                              "last10": [round(float(x), 1) for x in R[-10:].mean(0)]}))
                except Exception as ex:
                    log("listed count error", repr(ex))
                summ = M.backtest(recs, variants, tier_variants=("g25", "norm0"))
                try:
                    # p_play Brier for uncertain bench players, g25 vs spr10
                    br = {}
                    for nm in ("g25",):
                        s = []; nn = 0
                        for refp, info_h, actual, played in recs[5:]:
                            s1 = M.adjust(refp, info_h, variants[nm])
                            s1 = M.absence_adjust(s1, info_h, variants[nm])
                            s1 = M.spread_adjust(s1, info_h, variants[nm])
                            for e in s1:
                                if 0.02 < e["p_play"] < 0.98:
                                    y = 1.0 if played.get(str(e["playerId"])) else 0.0
                                    s.append((e["p_play"] - y) ** 2)
                        br[nm] = [round(float(np.mean(s)), 4), len(s)] if s else None
                    summ["brier_unc"] = br
                except Exception as ex:
                    log("brier diag error", repr(ex))
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
