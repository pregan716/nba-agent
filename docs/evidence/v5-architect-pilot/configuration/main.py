"""
Main entry point for NBA forecast system.
Adjusts reference forecasts using:
1. Lineup announcements (starter identification)
2. Historical error analysis (per-player bias correction)
3. Injury report adjustments
4. Distribution width calibration
"""
import json
import sys
import math
import traceback

def run(ctx, arg):
    """Main entry point. Returns a forecast for one team-game."""
    try:
        forecast = build_forecast(ctx)
        forecast = validate_and_fix(forecast, ctx)
        writes = {}
        return {"type": "finish", "forecast": forecast, "writes": writes}
    except Exception as e:
        print(f"FATAL ERROR: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return {"type": "finish", "forecast": ctx["reference"]}


def build_forecast(ctx):
    """Build adjusted forecast from reference + signals."""
    import numpy as np
    
    ref = ctx["reference"]
    ref_history = ctx.get("referenceHistory") or []
    roster = ctx["roster"]
    scores = ctx.get("scores") or []
    
    roster_ids = set(p["playerId"] for p in roster)
    inactive_ids = set(p["playerId"] for p in roster if p.get("inactive"))
    ref_map = {p["playerId"]: p for p in ref["players"]}
    
    # 1. Analyze reference history for per-player patterns
    player_stats = analyze_reference_history(ref_history)
    print(f"History analyzed: {len(player_stats)} players from {len(ref_history)} games", file=sys.stderr)
    
    # 2. Read lineup announcement 
    announced_starters = read_lineups(ctx)
    print(f"Announced starters: {len(announced_starters)} players", file=sys.stderr)
    
    # 3. Read injury reports
    injury_info = read_injuries(ctx)
    print(f"Injury info: {len(injury_info)} players", file=sys.stderr)
    
    # 4. Compute reference error calibration (width adjustments)
    width_calibration = compute_width_calibration(ref_history)
    
    # 5. Identify truly absent players
    absent_players = set()
    for pid in inactive_ids:
        absent_players.add(pid)
    for pid, info in injury_info.items():
        if info.get('status') == 'Out':
            absent_players.add(pid)
    for pid, rp in ref_map.items():
        if rp.get('p_play', 0) < 0.02:
            absent_players.add(pid)
    
    # 6. Compute minutes freed by unexpected absences
    minutes_freed = 0.0
    for pid in absent_players:
        if pid in ref_map:
            rp = ref_map[pid]
            pp = rp.get('p_play', 0)
            med = rp.get('minutes', [0]*7)[3] if rp.get('minutes') else 0
            if pp > 0.3 and med > 3:
                minutes_freed += med * pp
    
    # 7. Build adjusted forecast
    active_pids = [p["playerId"] for p in roster 
                   if p["playerId"] not in absent_players and p["playerId"] not in inactive_ids]
    
    redistribution = compute_redistribution(
        active_pids, ref_map, player_stats, minutes_freed, announced_starters
    )
    
    players = []
    for rp in roster:
        pid = rp["playerId"]
        ref_p = ref_map.get(pid, make_default_player(pid, pid in inactive_ids))
        
        adjusted = adjust_player(
            ref_p=ref_p,
            stats=player_stats.get(pid, {}),
            is_inactive=(pid in inactive_ids),
            announced_starters=announced_starters,
            injury_info=injury_info.get(pid, {}),
            redistribution=redistribution.get(pid, 0),
            width_cal=width_calibration,
            ref_history=ref_history
        )
        players.append(adjusted)
    
    return {
        "version": "forecast-v1",
        "gameId": ctx["gameId"],
        "players": players
    }


def analyze_reference_history(ref_history):
    """Analyze per-player patterns from reference history.
    
    Returns dict of player_id -> stats dict with:
    - play rates (overall, recent, weighted)
    - minutes (conditional on playing, recent, overall)
    - start rates
    - reference error patterns
    """
    import numpy as np
    
    player_data = {}
    n_games = len(ref_history)
    
    for game_idx, game_entry in enumerate(ref_history):
        ref_forecast = game_entry.get("reference", {})
        actuals = game_entry.get("actuals")
        
        if not ref_forecast or not actuals:
            continue
        
        recency = (game_idx + 1) / max(n_games, 1)
        
        ref_players = {}
        if "players" in ref_forecast:
            for p in ref_forecast["players"]:
                ref_players[p["playerId"]] = p
        
        actual_map = {}
        if isinstance(actuals, list):
            for p in actuals:
                actual_map[p.get("playerId", "")] = p
        elif isinstance(actuals, dict):
            actual_map = actuals
        
        for pid, rp in ref_players.items():
            act = actual_map.get(pid)
            if not act:
                continue
            
            actual_min = act.get("minutes", 0) or 0
            played = 1 if actual_min > 0 else 0
            started = 1 if act.get("starter") else 0
            
            pred_p_play = rp.get("p_play", 0.5)
            pred_p_start = rp.get("p_start", 0.0)
            pred_mins = rp.get("minutes", [0]*7)
            pred_median = pred_mins[3] if len(pred_mins) >= 4 else 0
            
            if pid not in player_data:
                player_data[pid] = {
                    'actual_minutes': [], 'pred_median_minutes': [],
                    'actual_played': [], 'pred_p_play': [],
                    'actual_started': [], 'pred_p_start': [],
                    'recency_weights': [],
                    'ref_percentiles': [],
                    'names': set(),
                }
            
            d = player_data[pid]
            d['actual_minutes'].append(actual_min)
            d['pred_median_minutes'].append(pred_median)
            d['actual_played'].append(played)
            d['pred_p_play'].append(pred_p_play)
            d['actual_started'].append(started)
            d['pred_p_start'].append(pred_p_start)
            d['recency_weights'].append(recency)
            d['ref_percentiles'].append(pred_mins)
            if act.get("name"):
                d['names'].add(act["name"])
    
    results = {}
    for pid, d in player_data.items():
        n = len(d['actual_minutes'])
        if n == 0:
            continue
        
        weights = np.array(d['recency_weights'])
        weights = weights / weights.sum() if weights.sum() > 0 else np.ones(n) / n
        
        last5_played = d['actual_played'][-5:]
        last10_played = d['actual_played'][-10:]
        
        played_mins = [m for m, p in zip(d['actual_minutes'], d['actual_played']) if p]
        last5_mins_when_played = [m for m, p in zip(d['actual_minutes'][-5:], d['actual_played'][-5:]) if p]
        last10_mins_when_played = [m for m, p in zip(d['actual_minutes'][-10:], d['actual_played'][-10:]) if p]
        
        # Minutes prediction errors (when reference said they'd play and they did)
        min_errors = []
        for am, pm, pp, ap in zip(d['actual_minutes'], d['pred_median_minutes'], 
                                     d['pred_p_play'], d['actual_played']):
            if ap and pp > 0.3:
                min_errors.append(am - pm)
        
        results[pid] = {
            'games_seen': n,
            'play_rate': np.mean(d['actual_played']),
            'weighted_play_rate': float(np.average(d['actual_played'], weights=weights)),
            'avg_pred_p_play': np.mean(d['pred_p_play']),
            'start_rate': np.mean(d['actual_started']),
            'recent5_start_rate': np.mean(d['actual_started'][-5:]) if len(d['actual_started']) >= 5 else np.mean(d['actual_started']),
            'recent10_start_rate': np.mean(d['actual_started'][-10:]) if len(d['actual_started']) >= 5 else np.mean(d['actual_started']),
            'avg_pred_p_start': np.mean(d['pred_p_start']),
            'conditional_avg_minutes': np.mean(played_mins) if played_mins else 0,
            'conditional_std_minutes': np.std(played_mins) if len(played_mins) > 1 else 10,
            'n_played': len(played_mins),
            'recent5_play_rate': np.mean(last5_played) if last5_played else 0,
            'recent10_play_rate': np.mean(last10_played) if last10_played else 0,
            'recent5_minutes': np.mean(last5_mins_when_played) if last5_mins_when_played else 0,
            'recent10_minutes': np.mean(last10_mins_when_played) if last10_mins_when_played else 0,
            'minutes_bias': np.mean(min_errors) if min_errors else 0,
            'minutes_bias_n': len(min_errors),
            'names': d['names'],
        }
    
    return results


def read_lineups(ctx):
    """Read starting lineup announcement. Returns set of player IDs."""
    try:
        import nba_data
        session = nba_data.session()
        
        team_id = ctx["teamId"]
        game_id = ctx["gameId"]
        
        # Discover column names dynamically
        cols = discover_columns(session, "lineups")
        if not cols:
            print("No lineups table found", file=sys.stderr)
            return set()
        
        print(f"Lineups columns: {cols}", file=sys.stderr)
        
        # Find the lineup column (could be startingLineup, starting_lineup, etc.)
        lineup_col = None
        for c in cols:
            cl = c.lower()
            if 'lineup' in cl and 'starting' in cl:
                lineup_col = c
                break
            if cl == 'startinglineup':
                lineup_col = c
                break
        
        if not lineup_col:
            # Try to find any column that could have lineup data
            for c in cols:
                cl = c.lower()
                if 'lineup' in cl:
                    lineup_col = c
                    break
        
        if not lineup_col:
            print(f"No lineup column found in: {cols}", file=sys.stderr)
            return set()
        
        # Query for this game's lineup, newest first
        query = f'SELECT "{lineup_col}" FROM lineups WHERE team_id = ? AND game_id = ? ORDER BY available_at DESC LIMIT 1'
        cursor = session.execute(query, (team_id, game_id))
        row = cursor.fetchone()
        
        if not row or not row[0]:
            print("No lineup data for this game", file=sys.stderr)
            return set()
        
        # Parse lineup (could be JSON array or comma-separated)
        raw = row[0]
        try:
            lineup_names = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            lineup_names = [n.strip() for n in raw.split(',')]
        
        if not lineup_names or not isinstance(lineup_names, list):
            return set()
        
        print(f"Lineup names: {lineup_names}", file=sys.stderr)
        
        # Match names to player IDs
        name_to_id = build_name_map(ctx)
        
        starter_ids = set()
        for name in lineup_names:
            pid = match_player_name(name, name_to_id)
            if pid:
                starter_ids.add(pid)
        
        print(f"Matched {len(starter_ids)} of {len(lineup_names)} starters", file=sys.stderr)
        return starter_ids
        
    except Exception as e:
        print(f"Error reading lineups: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return set()


def read_injuries(ctx):
    """Read injury reports. Returns dict of player_id -> {status, reason}."""
    try:
        import nba_data
        session = nba_data.session()
        
        team_id = ctx["teamId"]
        game_id = ctx["gameId"]
        
        # Try multiple possible table names
        table_name = None
        for tn in ["injuries", "injury_players", "injury_team_snapshots"]:
            cols = discover_columns(session, tn)
            if cols:
                table_name = tn
                break
        
        if not table_name:
            print("No injury table found", file=sys.stderr)
            return {}
        
        print(f"Injury table: {table_name}, columns: {cols}", file=sys.stderr)
        
        # Find relevant columns
        name_col = find_column(cols, ['player_name', 'name', 'playerName', 'player'])
        status_col = find_column(cols, ['status', 'injury_status', 'designation'])
        game_col = find_column(cols, ['game_id', 'gameId'])
        team_col = find_column(cols, ['team_id', 'teamId'])
        avail_col = find_column(cols, ['available_at', 'availableAt', 'date', 'timestamp'])
        
        if not name_col or not status_col:
            print(f"Missing required columns: name={name_col}, status={status_col}", file=sys.stderr)
            return {}
        
        # Build query
        where_parts = []
        params = []
        if team_col:
            where_parts.append(f'"{team_col}" = ?')
            params.append(team_id)
        if game_col:
            where_parts.append(f'"{game_col}" = ?')
            params.append(game_id)
        
        where_clause = " AND ".join(where_parts) if where_parts else "1=1"
        order = f'ORDER BY "{avail_col}" DESC' if avail_col else ''
        
        query = f'SELECT "{name_col}", "{status_col}" FROM "{table_name}" WHERE {where_clause} {order}'
        cursor = session.execute(query, params)
        rows = cursor.fetchall()
        
        if not rows:
            return {}
        
        # Get latest status per player name
        latest = {}
        for name, status in rows:
            if name and name not in latest:
                latest[name] = status
        
        # Match names to player IDs
        name_to_id = build_name_map(ctx)
        
        result = {}
        for name, status in latest.items():
            # Parse "Last, First" format
            parts = name.split(', ')
            if len(parts) == 2:
                full_name = f"{parts[1]} {parts[0]}"
            else:
                full_name = name
            
            pid = match_player_name(full_name, name_to_id)
            if pid:
                result[pid] = {'status': status}
        
        return result
        
    except Exception as e:
        print(f"Error reading injuries: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return {}


def discover_columns(session, table_name):
    """Get column names for a table, or empty list if table doesn't exist."""
    try:
        cursor = session.execute(f'PRAGMA table_info("{table_name}")')
        rows = cursor.fetchall()
        return [r[1] for r in rows]
    except:
        return []


def find_column(cols, candidates):
    """Find a column by trying multiple possible names."""
    cols_lower = {c.lower(): c for c in cols}
    for cand in candidates:
        if cand.lower() in cols_lower:
            return cols_lower[cand.lower()]
    return None


def build_name_map(ctx):
    """Build player name -> ID mapping from multiple sources."""
    name_to_id = {}
    
    # Source 1: referenceHistory actuals (most reliable)
    ref_history = ctx.get("referenceHistory") or []
    for game_entry in ref_history:
        actuals = game_entry.get("actuals")
        if isinstance(actuals, list):
            for p in actuals:
                pid = p.get("playerId", "")
                name = p.get("name", "")
                if pid and name:
                    name_to_id[name.strip().lower()] = pid
        elif isinstance(actuals, dict):
            for pid, p in actuals.items():
                name = p.get("name", "")
                if pid and name:
                    name_to_id[name.strip().lower()] = pid
    
    # Source 2: reference forecast players (have IDs)
    ref = ctx.get("reference", {})
    for p in ref.get("players", []):
        pid = p.get("playerId", "")
        name = p.get("name", "")
        if pid and name:
            name_to_id[name.strip().lower()] = pid
    
    # Source 3: Try session tables
    try:
        import nba_data
        session = nba_data.session()
        team_id = ctx["teamId"]
        
        # Try player_reference
        for table in ["player_reference", "player_profiles"]:
            try:
                cols = discover_columns(session, table)
                if not cols:
                    continue
                pid_col = find_column(cols, ['player_id', 'playerId', 'id'])
                name_col = find_column(cols, ['display_name', 'displayName', 'name', 'full_name'])
                team_col = find_column(cols, ['team_id', 'teamId'])
                
                if pid_col and name_col:
                    if team_col:
                        cursor = session.execute(
                            f'SELECT "{pid_col}", "{name_col}" FROM "{table}" WHERE "{team_col}" = ?',
                            (team_id,)
                        )
                    else:
                        cursor = session.execute(f'SELECT "{pid_col}", "{name_col}" FROM "{table}"')
                    for row in cursor:
                        if row[0] and row[1]:
                            name_to_id[str(row[1]).strip().lower()] = str(row[0])
            except:
                pass
    except:
        pass
    
    # Source 4: scores from previous system forecasts
    scores = ctx.get("scores") or []
    for score_entry in scores:
        box = score_entry.get("box") if isinstance(score_entry, dict) else None
        if isinstance(box, list):
            for p in box:
                pid = p.get("playerId", "")
                name = p.get("name", "")
                if pid and name:
                    name_to_id[name.strip().lower()] = pid
    
    return name_to_id


def match_player_name(name, name_to_id):
    """Match a name to a player ID using fuzzy matching."""
    if not name:
        return None
    
    name_lower = name.strip().lower()
    
    # Direct match
    if name_lower in name_to_id:
        return name_to_id[name_lower]
    
    # Last name match
    parts = name_lower.split()
    if len(parts) >= 2:
        last = parts[-1]
        first = parts[0]
        
        # Exact last name + first initial
        matches = []
        for k, v in name_to_id.items():
            k_parts = k.split()
            if len(k_parts) >= 2:
                if k_parts[-1] == last and k_parts[0][0] == first[0]:
                    matches.append((k, v))
        
        if len(matches) == 1:
            return matches[0][1]
        
        # Just last name if unique
        last_matches = [(k, v) for k, v in name_to_id.items() if k.split()[-1] == last]
        if len(last_matches) == 1:
            return last_matches[0][1]
        
        # First 3 chars of first name + last name
        if len(matches) == 0:
            for k, v in name_to_id.items():
                k_parts = k.split()
                if len(k_parts) >= 2 and k_parts[-1] == last:
                    if k_parts[0][:3] == first[:3]:
                        return v
    
    return None


def compute_width_calibration(ref_history):
    """Compute how well-calibrated the reference's percentile ranges are.
    Returns a width multiplier (>1 means reference is too narrow, <1 means too wide).
    """
    import numpy as np
    
    if not ref_history or len(ref_history) < 5:
        return {'minutes': 1.0}
    
    # For each player who played, check if their actual minutes fell
    # within the reference's stated ranges
    in_50 = 0
    in_80 = 0
    total = 0
    
    for game_entry in ref_history:
        ref_forecast = game_entry.get("reference", {})
        actuals = game_entry.get("actuals")
        
        if not ref_forecast or not actuals:
            continue
        
        ref_players = {}
        if "players" in ref_forecast:
            for p in ref_forecast["players"]:
                ref_players[p["playerId"]] = p
        
        actual_map = {}
        if isinstance(actuals, list):
            for p in actuals:
                actual_map[p.get("playerId", "")] = p
        elif isinstance(actuals, dict):
            actual_map = actuals
        
        for pid, rp in ref_players.items():
            act = actual_map.get(pid)
            if not act:
                continue
            actual_min = act.get("minutes", 0) or 0
            if actual_min <= 0:
                continue
            
            mins = rp.get("minutes", [0]*7)
            if len(mins) < 7:
                continue
            
            p_play = rp.get("p_play", 0)
            if p_play < 0.3:
                continue
            
            # p25 = mins[2], p75 = mins[4] (50% interval)
            # p10 = mins[1], p90 = mins[5] (80% interval)
            if actual_min >= mins[2] and actual_min <= mins[4]:
                in_50 += 1
            if actual_min >= mins[1] and actual_min <= mins[5]:
                in_80 += 1
            total += 1
    
    if total < 10:
        return {'minutes': 1.0}
    
    coverage_50 = in_50 / total
    coverage_80 = in_80 / total
    
    # Target: 50% should be 50%, 80% should be 80%
    # If coverage is too low, reference is too narrow -> widen
    # If coverage is too high, reference is too wide -> narrow
    
    # Simple adjustment: if 50% coverage is at 40%, multiply width by ~1.1
    width_mult = 1.0
    if coverage_50 < 0.45:
        width_mult = max(width_mult, 1.1)
    elif coverage_50 > 0.60:
        width_mult = min(width_mult, 0.9)
    
    if coverage_80 < 0.70:
        width_mult = max(width_mult, 1.15)
    elif coverage_80 > 0.90:
        width_mult = min(width_mult, 0.85)
    
    print(f"Width calibration: 50%_coverage={coverage_50:.3f}, 80%_coverage={coverage_80:.3f}, mult={width_mult:.3f}", file=sys.stderr)
    return {'minutes': width_mult, 'coverage_50': coverage_50, 'coverage_80': coverage_80}


def compute_redistribution(active_pids, ref_map, player_stats, minutes_freed, announced_starters):
    """Redistribute freed minutes among active players."""
    import numpy as np
    
    if minutes_freed <= 0:
        return {}
    
    weights = {}
    total_weight = 0
    
    for pid in active_pids:
        rp = ref_map.get(pid, {})
        median_min = rp.get('minutes', [0]*7)[3] if rp.get('minutes') else 0
        p_play = rp.get('p_play', 0)
        
        # Starters get more of the freed minutes
        starter_boost = 1.3 if (pid in announced_starters or rp.get('p_start', 0) > 0.5) else 1.0
        
        w = median_min * p_play * starter_boost
        weights[pid] = w
        total_weight += w
    
    if total_weight == 0:
        return {}
    
    # Be conservative: only redistribute a fraction
    effective_freed = minutes_freed * 0.25
    
    result = {}
    for pid, w in weights.items():
        result[pid] = effective_freed * (w / total_weight)
    
    return result


def adjust_player(ref_p, stats, is_inactive, announced_starters, injury_info,
                  redistribution, width_cal, ref_history):
    """Adjust a single player's forecast."""
    import numpy as np
    
    pid = ref_p["playerId"]
    
    # Start from reference
    p_play = ref_p.get("p_play", 0.5)
    p_start = ref_p.get("p_start", 0.0)
    minutes = list(ref_p.get("minutes", [0]*7))
    points = list(ref_p.get("points", [0]*7))
    rebounds = list(ref_p.get("rebounds", [0]*7))
    assists = list(ref_p.get("assists", [0]*7))
    fantasy_points = list(ref_p.get("fantasy_points", [0]*7))
    
    # Inactive players
    if is_inactive:
        return make_player_output(pid, 0.0, 0.0, minutes, points, rebounds, assists, fantasy_points)
    
    # === ADJUST p_play ===
    
    # Injury status
    inj_status = injury_info.get('status', '') if injury_info else ''
    if inj_status == 'Out':
        p_play = 0.01
    elif inj_status == 'Doubtful':
        p_play = min(p_play, 0.15)
    elif inj_status == 'Questionable':
        if pid in announced_starters:
            p_play = max(p_play, 0.97)
        else:
            # Questionable players play ~75% of the time
            p_play = np.clip(0.4 * p_play + 0.6 * 0.75, 0, 1)
    elif inj_status == 'Probable':
        p_play = max(p_play, 0.92)
    elif inj_status == 'Available':
        p_play = max(p_play, 0.80)
    
    # Historical play rate adjustment (when no strong injury signal)
    if stats and stats.get('games_seen', 0) >= 5 and inj_status not in ('Out', 'Doubtful'):
        n = stats['games_seen']
        hist_rate = stats['weighted_play_rate']
        recent5 = stats.get('recent5_play_rate', hist_rate)
        recent10 = stats.get('recent10_play_rate', hist_rate)
        
        # Weight recent games more for detecting changes
        blended_rate = 0.45 * recent5 + 0.30 * recent10 + 0.25 * hist_rate
        
        # Correction strength based on sample size and disagreement
        strength = min(0.4, n / 40.0)
        
        if not inj_status:  # Only adjust if no injury info at all
            p_play = p_play * (1 - strength) + blended_rate * strength
    
    # Lineup announcement overrides
    if pid in announced_starters:
        p_play = max(p_play, 0.99)
    
    # === ADJUST p_start ===
    
    if pid in announced_starters:
        p_start = max(0.98, p_play - 0.01)
    elif len(announced_starters) >= 5:
        # We know all 5 starters and this player isn't one
        p_start = min(p_start, 0.02)
    elif len(announced_starters) >= 3:
        # Partial knowledge
        p_start = p_start * 0.3
    elif stats and stats.get('games_seen', 0) >= 5 and not announced_starters:
        # Use historical start rate
        recent_start = stats.get('recent5_start_rate', stats.get('start_rate', p_start))
        strength = min(0.35, stats['games_seen'] / 40.0)
        p_start = p_start * (1 - strength) + recent_start * strength
    
    # === ADJUST MINUTES ===
    
    ref_median = minutes[3]
    target_median = ref_median
    
    if stats and stats.get('n_played', 0) >= 3:
        # Historical conditional minutes
        hist_avg = stats.get('conditional_avg_minutes', ref_median)
        recent5 = stats.get('recent5_minutes', hist_avg)
        recent10 = stats.get('recent10_minutes', hist_avg)
        
        blended = 0.40 * recent5 + 0.35 * recent10 + 0.25 * hist_avg
        
        if ref_median > 0 and blended > 0:
            ratio = blended / ref_median
            ratio = np.clip(ratio, 0.7, 1.4)
            
            # Use reference bias if we have enough data
            bias = stats.get('minutes_bias', 0)
            bias_n = stats.get('minutes_bias_n', 0)
            
            if bias_n >= 5:
                # Direct bias correction: if reference consistently under/over-predicts
                bias_correction = np.clip(bias * 0.3, -5, 5)  # Cap at 5 minutes
                target_median = ref_median + bias_correction
            else:
                # Ratio-based correction
                strength = min(0.4, stats['n_played'] / 30.0)
                adj_ratio = 1.0 + (ratio - 1.0) * strength
                target_median = ref_median * adj_ratio
    
    # Starter/bench minutes adjustment based on lineup info
    if pid in announced_starters and p_start > 0.8:
        ref_p_start = ref_p.get("p_start", 0)
        if ref_p_start < 0.5:
            # Unexpected starter -> boost minutes
            target_median = max(target_median, target_median * 1.15, 20)
    elif len(announced_starters) >= 5 and pid not in announced_starters:
        ref_p_start = ref_p.get("p_start", 0)
        if ref_p_start > 0.5:
            # Unexpected non-starter -> reduce minutes
            target_median = min(target_median, target_median * 0.85)
    
    # Add redistributed minutes from absent players
    if redistribution > 0:
        target_median += redistribution
    
    # === APPLY MINUTES SCALING ===
    
    if ref_median > 0 and target_median > 0:
        scale = target_median / ref_median
        minutes = [m * scale for m in minutes]
        
        # Width adjustment from calibration
        width_mult = width_cal.get('minutes', 1.0)
        if width_mult != 1.0:
            median_new = minutes[3]
            for i in range(7):
                diff = minutes[i] - median_new
                minutes[i] = median_new + diff * width_mult
    
    # Scale other stats proportionally to minutes change
    original_median = ref_p.get("minutes", [0]*7)[3]
    new_median = minutes[3] if minutes else 0
    if original_median > 0 and new_median > 0:
        stat_ratio = new_median / original_median
        points = [max(0, p * stat_ratio) for p in points]
        rebounds = [max(0, r * stat_ratio) for r in rebounds]
        assists = [max(0, a * stat_ratio) for a in assists]
        fantasy_points = [fp * stat_ratio for fp in fantasy_points]
    
    return make_player_output(pid, p_play, p_start, minutes, points, rebounds, assists, fantasy_points)


def make_player_output(pid, p_play, p_start, minutes, points, rebounds, assists, fantasy_points):
    """Create a valid player forecast output."""
    import numpy as np
    
    p_play = float(np.clip(p_play, 0.0, 1.0))
    p_start = float(np.clip(p_start, 0.0, p_play))
    
    minutes = enforce_range(minutes, 0, 58)
    points = enforce_range(points, 0, 200)
    rebounds = enforce_range(rebounds, 0, 100)
    assists = enforce_range(assists, 0, 100)
    fantasy_points = enforce_range(fantasy_points, -10, 500)
    
    return {
        "playerId": pid,
        "p_play": round(p_play, 4),
        "p_start": round(p_start, 4),
        "minutes": [round(m, 2) for m in minutes],
        "points": [round(p, 2) for p in points],
        "rebounds": [round(r, 2) for r in rebounds],
        "assists": [round(a, 2) for a in assists],
        "fantasy_points": [round(f, 2) for f in fantasy_points],
    }


def enforce_range(values, min_val, max_val):
    """Ensure values are non-decreasing and within bounds."""
    result = []
    prev = min_val
    for v in values:
        v = float(max(prev, min(v, max_val)))
        result.append(v)
        prev = v
    return result


def make_default_player(pid, is_inactive):
    """Create a default player entry for someone not in the reference."""
    return {
        "playerId": pid,
        "p_play": 0.0 if is_inactive else 0.1,
        "p_start": 0.0,
        "minutes": [3, 5, 8, 12, 18, 24, 28],
        "points": [0, 1, 2, 4, 8, 12, 16],
        "rebounds": [0, 0, 1, 2, 4, 6, 8],
        "assists": [0, 0, 0, 1, 2, 3, 4],
        "fantasy_points": [-2, 0, 4, 10, 18, 28, 36],
    }


def validate_and_fix(forecast, ctx):
    """Validate forecast and fix minor issues. Fall back to reference if unfixable."""
    roster_ids = set(p["playerId"] for p in ctx["roster"])
    forecast_ids = set(p["playerId"] for p in forecast["players"])
    
    if forecast_ids != roster_ids:
        print(f"Roster mismatch: missing={roster_ids - forecast_ids}, extra={forecast_ids - roster_ids}", file=sys.stderr)
        return ctx["reference"]
    
    for p in forecast["players"]:
        try:
            # Fix p_start > p_play
            if p["p_start"] > p["p_play"]:
                p["p_start"] = p["p_play"]
            
            # Validate ranges
            for field in ["minutes", "points", "rebounds", "assists", "fantasy_points"]:
                vals = p[field]
                if len(vals) != 7:
                    print(f"Wrong length for {field}: {len(vals)}", file=sys.stderr)
                    return ctx["reference"]
            
            # Check minutes bounds
            for m in p["minutes"]:
                if m < 0 or m > 58:
                    print(f"Minutes out of range: {m}", file=sys.stderr)
                    return ctx["reference"]
            
            # Check non-negative stats
            for field in ["points", "rebounds", "assists"]:
                for v in p[field]:
                    if v < -0.01:
                        print(f"Negative {field}: {v}", file=sys.stderr)
                        return ctx["reference"]
            
            # Check fantasy points
            for v in p["fantasy_points"]:
                if v < -10:
                    print(f"Fantasy points too low: {v}", file=sys.stderr)
                    return ctx["reference"]
            
            # Check non-decreasing
            for field in ["minutes", "points", "rebounds", "assists", "fantasy_points"]:
                vals = p[field]
                for i in range(1, len(vals)):
                    if vals[i] < vals[i-1] - 0.01:
                        print(f"Non-monotonic {field} at {i}: {vals[i]} < {vals[i-1]}", file=sys.stderr)
                        return ctx["reference"]
                        
        except (KeyError, TypeError, IndexError) as e:
            print(f"Validation error: {e}", file=sys.stderr)
            return ctx["reference"]
    
    return forecast
