import sys
import json
import math
import traceback
import numpy as np

def run(ctx, arg):
    """Main entry point. Adjusts reference forecast based on systematic error analysis.
    
    Strategy: Only modify minutes percentiles and p_play/p_start based on 
    detected systematic bias in the reference's own history. Leave all other
    stats (points, rebounds, assists, fantasy_points) untouched from reference.
    """
    try:
        forecast = build_forecast(ctx)
        forecast = validate_and_fix(forecast, ctx)
        return {"type": "finish", "forecast": forecast}
    except Exception as e:
        print(f"Error in build_forecast, falling back to reference: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return {"type": "finish", "forecast": ctx["reference"]}


def build_forecast(ctx):
    ref = ctx["reference"]
    history = ctx.get("referenceHistory", [])
    roster = ctx["roster"]
    inactive_ids = set(p["playerId"] for p in roster if p.get("inactive", False))
    
    # Build player error histories
    player_data = build_player_histories(history)
    
    ref_players = {p["playerId"]: p for p in ref["players"]}
    new_players = []
    
    for roster_player in roster:
        pid = roster_player["playerId"]
        
        if pid in ref_players:
            rp = json_deepcopy(ref_players[pid])
        else:
            rp = make_default_player(pid)
        
        rp["playerId"] = pid
        
        if pid in inactive_ids:
            rp["p_play"] = 0.0
            rp["p_start"] = 0.0
            new_players.append(rp)
            continue
        
        pdata = player_data.get(pid, None)
        if pdata and len(pdata["errors"]) >= 3:
            rp = adjust_player(rp, pdata)
        
        new_players.append(rp)
    
    return {
        "version": "forecast-v1",
        "gameId": ctx["gameId"],
        "players": new_players
    }


def json_deepcopy(d):
    return json.loads(json.dumps(d))


def build_player_histories(history):
    player_data = {}
    for game_entry in history:
        errors = game_entry.get("errors", [])
        fc = game_entry.get("forecast", {})
        fc_players = {p["playerId"]: p for p in fc.get("players", [])} if fc else {}
        for err in errors:
            pid = err["playerId"]
            if pid not in player_data:
                player_data[pid] = {"errors": [], "forecasts": []}
            player_data[pid]["errors"].append(err)
            player_data[pid]["forecasts"].append(fc_players.get(pid))
    return player_data


def adjust_player(rp, pdata):
    """Adjust a player's forecast based on detected systematic errors in the reference."""
    errs = pdata["errors"]
    fcs = pdata["forecasts"]
    
    n_recent = min(15, len(errs))
    recent_errs = errs[-n_recent:]
    recent_fcs = fcs[-n_recent:]
    
    CORR = 0.3  # Correction strength
    
    # --- Adjust p_play ---
    play_errors = [e["playError"] for e in recent_errs if e.get("playError") is not None]
    if len(play_errors) >= 3:
        weights = exp_weights(len(play_errors))
        mean_err = float(np.average(play_errors, weights=weights))
        if abs(mean_err) > 0.03:
            rp["p_play"] = round(float(np.clip(rp["p_play"] + mean_err * CORR, 0.0, 1.0)), 6)
    
    # --- Adjust p_start ---
    start_errors = [e["startError"] for e in recent_errs if e.get("startError") is not None]
    if len(start_errors) >= 3:
        weights = exp_weights(len(start_errors))
        mean_err = float(np.average(start_errors, weights=weights))
        if abs(mean_err) > 0.03:
            new_ps = np.clip(rp["p_start"] + mean_err * CORR, 0.0, rp["p_play"])
            rp["p_start"] = round(float(new_ps), 6)
    
    # --- Adjust minutes percentiles ---
    minutes_data = []
    for i, e in enumerate(recent_errs):
        cme = e.get("conditionalMedianError")
        if cme is not None and cme.get("minutes") is not None:
            fc = recent_fcs[i]
            if fc is not None:
                minutes_data.append({
                    "error": cme["minutes"],
                    "actual": e["actual"]["minutes"],
                    "ref_p5": fc.get("minutes", [0]*7)[0],
                    "ref_p10": fc.get("minutes", [0]*7)[1],
                    "ref_p25": fc.get("minutes", [0]*7)[2],
                    "ref_median": fc.get("minutes", [0]*7)[3],
                    "ref_p75": fc.get("minutes", [0]*7)[4],
                    "ref_p90": fc.get("minutes", [0]*7)[5],
                    "ref_p95": fc.get("minutes", [0]*7)[6],
                })
    
    if len(minutes_data) >= 3:
        errors = [d["error"] for d in minutes_data]
        weights = exp_weights(len(errors))
        mean_error = float(np.average(errors, weights=weights))
        
        # Shift the entire distribution
        if abs(mean_error) > 0.3:
            shift = mean_error * CORR
            old_mins = rp["minutes"]
            new_mins = [max(0.0, round(m + shift, 2)) for m in old_mins]
            for i in range(1, len(new_mins)):
                if new_mins[i] < new_mins[i-1]:
                    new_mins[i] = new_mins[i-1]
            new_mins = [min(58.0, m) for m in new_mins]
            rp["minutes"] = new_mins
        
        # Width calibration
        if len(minutes_data) >= 5:
            calibrate_width(rp, minutes_data)
    
    return rp


def calibrate_width(rp, minutes_data):
    """Adjust distribution width based on historical calibration."""
    # Count results outside the reference 10-90 range (should be ~20%)
    outside = 0
    total = 0
    for d in minutes_data:
        p10, p90 = d["ref_p10"], d["ref_p90"]
        if p90 <= p10:
            continue
        actual = d["actual"]
        if actual < p10 or actual > p90:
            outside += 1
        total += 1
    
    if total < 5:
        return
    
    rate = outside / total
    median = rp["minutes"][3]
    
    if rate > 0.30:
        factor = 1.06
    elif rate < 0.12:
        factor = 0.96
    else:
        return
    
    new_mins = []
    for m in rp["minutes"]:
        diff = m - median
        new_mins.append(max(0.0, round(median + diff * factor, 2)))
    for i in range(1, len(new_mins)):
        if new_mins[i] < new_mins[i-1]:
            new_mins[i] = new_mins[i-1]
    new_mins = [min(58.0, m) for m in new_mins]
    rp["minutes"] = new_mins


def exp_weights(n, decay=0.9):
    w = np.array([decay**i for i in range(n-1, -1, -1)])
    return w / w.sum()


def make_default_player(pid):
    return {
        "playerId": pid,
        "p_play": 0.0,
        "p_start": 0.0,
        "minutes": [0, 0, 0, 0, 0, 0, 0],
        "points": [0, 0, 0, 0, 0, 0, 0],
        "rebounds": [0, 0, 0, 0, 0, 0, 0],
        "assists": [0, 0, 0, 0, 0, 0, 0],
        "fantasy_points": [0, 0, 0, 0, 0, 0, 0]
    }


def validate_and_fix(forecast, ctx):
    try:
        roster_ids = set(p["playerId"] for p in ctx["roster"])
        forecast_ids = set(p["playerId"] for p in forecast["players"])
        
        if roster_ids != forecast_ids:
            print(f"Roster mismatch", file=sys.stderr)
            return ctx["reference"]
        
        for p in forecast["players"]:
            p["p_play"] = max(0.0, min(1.0, float(p["p_play"])))
            p["p_start"] = max(0.0, min(float(p["p_play"]), float(p["p_start"])))
            
            mins = p["minutes"]
            if len(mins) != 7:
                return ctx["reference"]
            for i in range(7):
                mins[i] = max(0.0, min(58.0, float(mins[i])))
            for i in range(1, 7):
                if mins[i] < mins[i-1]:
                    mins[i] = mins[i-1]
            
            for stat in ["points", "rebounds", "assists"]:
                vals = p[stat]
                if len(vals) != 7:
                    return ctx["reference"]
                for i in range(7):
                    vals[i] = max(0.0, float(vals[i]))
                for i in range(1, 7):
                    if vals[i] < vals[i-1]:
                        vals[i] = vals[i-1]
            
            fp = p["fantasy_points"]
            if len(fp) != 7:
                return ctx["reference"]
            for i in range(7):
                fp[i] = max(-10.0, float(fp[i]))
            for i in range(1, 7):
                if fp[i] < fp[i-1]:
                    fp[i] = fp[i-1]
        
        return forecast
    except Exception as e:
        print(f"Validation error: {e}", file=sys.stderr)
        return ctx["reference"]
