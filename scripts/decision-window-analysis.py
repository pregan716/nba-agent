"""SPO-837 descriptive audit only: clock buckets are NOT a replay dataset."""
import collections as C
import itertools
import json
import pathlib
import re
import sys

ROOT = pathlib.Path('.cache/spo837')
OUT = pathlib.Path('docs/evidence/decision-windows')
OUT.mkdir(parents=True, exist_ok=True)
BOS = '1610612738'
SAMPLE = ['0022500083', '0022500637', '0022500338']
DEAD_TURNOVERS = {'out-of-bounds', 'offensive foul', 'shot clock', 'traveling',
                  'backcourt', '3-second-violation', 'offensive goaltending',
                  '5-second-violation', 'discontinued dribble', 'double dribble',
                  'offensive-kicked-ball', '8-second-violation', 'jumpball violation'}

def write(name, obj):
    (OUT / name).write_text(json.dumps(obj, indent=2, sort_keys=True) + '\n')

def markers(e):
    if e['type'] in {'foul', 'timeout', 'free_throw', 'violation', 'period_start', 'period_end', 'ejection'}:
        return e['type']
    if e['type'] == 'turnover' and e['subtype'] in DEAD_TURNOVERS:
        return 'dead_ball_turnover'
    return None

def buckets(events):
    # Consecutive equal period/clock runs, not a game-wide group-by: clock resets
    # must not silently merge distinct stretches. Retain live events to diagnose ambiguity.
    return [list(v) for _, v in itertools.groupby(events, lambda e: (e['period'], e['clock_remaining_ms']))]

def dist(values):
    return dict(sorted(C.Counter(values).items()))

def analyze(x):
    tables = x['tables']; all_e = tables['events']
    events = sorted((e for e in all_e if e['validity'] == 'effective'), key=lambda e: (e['game_id'], e['canonical_sequence']))
    by_game = {g['game_id']: [e for e in events if e['game_id'] == g['game_id']] for g in x['games']}
    parts = C.defaultdict(list)
    for p in tables['event_participants']: parts[p['event_id']].append(p)
    game_results = []; groups = []; boundaries = []; all_buckets = []
    for game in sorted(x['games'], key=lambda g: g['scheduled_tipoff']):
        gid = game['game_id']; es = by_game[gid]; bs = buckets(es); all_buckets.extend(bs)
        own = 'home' if game['home_team_id'] == BOS else 'away'
        gs = []
        for b in bs:
            subs = [e for e in b if e['type'] == 'substitution']
            cs = [e for e in subs if e['team_id'] == BOS]
            if not subs: continue
            ins = [p['player_id'] for e in cs for p in parts[e['event_id']] if p['role'] == 'sub_in']
            outs = [p['player_id'] for e in cs for p in parts[e['event_id']] if p['role'] == 'sub_out']
            first = cs[0]['canonical_sequence'] if cs else None
            gs.append(dict(game_id=gid, period=b[0]['period'], clock_ms=b[0]['clock_remaining_ms'],
                           first_sequence=b[0]['canonical_sequence'], last_sequence=b[-1]['canonical_sequence'],
                           sub_rows=len(subs), celtics_rows=len(cs), entries=ins, exits=outs,
                           marker_types=sorted(set(filter(None, map(markers,b)))),
                           own_before=cs[0].get(own+'_lineup_before') if cs else None,
                           opponent_before=cs[0].get(('away' if own=='home' else 'home')+'_lineup_before') if cs else None,
                           opponent_rows_before=sum(e['team_id'] != BOS and first is not None and e['canonical_sequence'] < first for e in subs),
                           opponent_rows_after=sum(e['team_id'] != BOS and first is not None and e['canonical_sequence'] > first for e in subs),
                           timeout_before=sum(e['type']=='timeout' and first is not None and e['canonical_sequence'] < first for e in b),
                           timeout_after=sum(e['type']=='timeout' and first is not None and e['canonical_sequence'] > first for e in b),
                           non_sub_between_celtics=([e['type'] for e in b if first < e['canonical_sequence'] < cs[-1]['canonical_sequence'] and e['type']!='substitution'] if cs else []),
                           live_types=sorted(set(e['type'] for e in b if e['type'] in {'field_goal','jump_ball','turnover','rebound'})),
                           events=[dict(sequence=e['canonical_sequence'], type=e['type'], subtype=e['subtype'], description=e['description']) for e in b]))
        groups.extend(gs)
        for start in (e for e in es if e['type']=='period_start' and e['period']>1):
            prev = next((e for e in reversed(es) if e['type']=='period_end' and e['period']==start['period']-1), None)
            before = prev.get(own+'_lineup_before') if prev else None
            after = start.get(own+'_lineup_after')
            boundaries.append(dict(game_id=gid,period=start['period'],before=before,after=after,
                                   exits=sorted(set(before)-set(after)) if before and after else None,
                                   entries=sorted(set(after)-set(before)) if before and after else None))
        candidate = [b for b in bs if any(markers(e) for e in b)]
        game_results.append(dict(game_id=gid,events=len(es),home_null=sum(e.get('home_lineup_before') is None for e in es),
                                 away_null=sum(e.get('away_lineup_before') is None for e in es),
                                 home_null_rate=sum(e.get('home_lineup_before') is None for e in es)/len(es),
                                 away_null_rate=sum(e.get('away_lineup_before') is None for e in es)/len(es),
                                 marker_clock_buckets=len(candidate),
                                 marker_buckets_without_celtics_sub=sum(not any(e['type']=='substitution' and e['team_id']==BOS for e in b) for b in candidate),
                                 unknown_either_marker_buckets=sum(b[0].get('home_lineup_before') is None or b[0].get('away_lineup_before') is None for b in candidate),
                                 unknown_own_marker_buckets=sum(b[0].get(own+'_lineup_before') is None for b in candidate),
                                 celtics_sub_rows=sum(g['celtics_rows'] for g in gs), celtics_sub_clock_buckets=sum(g['celtics_rows']>0 for g in gs),
                                 duplicate_sequences=len(es)-len(set(e['canonical_sequence'] for e in es)),
                                 null_clocks=sum(e['clock_remaining_ms'] is None for e in es)))
    contiguous_blocks = [list(b) for es in by_game.values() for key,b in itertools.groupby(es,lambda e:(e['type']=='substitution',e['period'],e['clock_remaining_ms'])) if key[0]]
    opponent_prefix_changes=[]
    for b in contiguous_blocks:
        first=next((e for e in b if e['team_id']==BOS),None)
        if first is None: continue
        prior=[e for e in b if e['canonical_sequence']<first['canonical_sequence']]
        ins=[p['player_id'] for e in prior for p in parts[e['event_id']] if p['role']=='sub_in']
        outs=[p['player_id'] for e in prior for p in parts[e['event_id']] if p['role']=='sub_out']
        if ins and len(ins)==len(outs):
            opponent_prefix_changes.append(dict(game_id=first['game_id'],sequence=first['canonical_sequence'],entries=ins,exits=outs))
    stints = [s for s in tables['v_player_stints'] if s['team_id']==BOS]
    raw_inperiod_entries=C.Counter()
    for b in all_buckets:
        if any(e['type']=='period_start' for e in b): continue
        for e in b:
            raw_inperiod_entries[e['game_id']]+=sum(p['role']=='sub_in' and p['team_id']==BOS for p in parts[e['event_id']])
    stint_entries=C.Counter(s['game_id'] for s in stints if s['start_reason']=='substitution')
    stint_action_differences=[dict(game_id=g,raw_inperiod_entries=n,stint_substitution_starts=stint_entries[g]) for g,n in sorted(raw_inperiod_entries.items()) if n!=stint_entries[g]]
    fouls = C.Counter(); raw_fouls=C.Counter()
    for e in events:
        for p in parts[e['event_id']]:
            if p['role']=='fouler' and p['team_id']==BOS:
                raw_fouls[e['game_id'],p['player_id']]+=1
                if e['type']=='foul' and not re.search(r'technical|defensive 3 second|delay of game',e['description'] or '',re.I):
                    fouls[e['game_id'],p['player_id']]+=1
    comparisons = [dict(game_id=b['game_id'],player_id=b['player_id'],official=b['personal_fouls'],
                        all_fouler_roles=raw_fouls[b['game_id'],b['player_id']],personal_fouls=fouls[b['game_id'],b['player_id']])
                   for b in tables['player_box_scores'] if b['team_id']==BOS]
    stint_disagreements=[]
    for s in stints:
        for bound in ['entry','exit']:
            cutoff=s['start_sequence' if bound=='entry' else 'end_sequence']
            n=sum(1 for e in by_game[s['game_id']] if e['canonical_sequence']<cutoff and e['type']=='foul' and not re.search(r'technical|defensive 3 second|delay of game',e['description'] or '',re.I) for p in parts[e['event_id']] if p['role']=='fouler' and p['player_id']==s['player_id'])
            if s['personal_fouls_'+bound] is not None and s['personal_fouls_'+bound]!=n:
                stint_disagreements.append(dict(stint_id=s['stint_id'],bound=bound,release=s['personal_fouls_'+bound],recomputed=n))
    summary=dict(games=len(by_game),events=len(events),validity=dist(e['validity'] for e in all_e),
                 null_scores=sum(e.get('home_score_before') is None or e.get('away_score_before') is None for e in events),
                 free_throw_number_null=sum(e['free_throw_number'] is None for e in events if e['type']=='free_throw'),
                 free_throw_total_null=sum(e['free_throw_total'] is None for e in events if e['type']=='free_throw'),
                 free_throw_types=dist(str(e['free_throw_type']) for e in events if e['type']=='free_throw'),
                 types=dist(e['type'] for e in events),type_subtypes=dist(e['type']+'/'+str(e['subtype']) for e in events),
                 marker_events=dist(filter(None,map(markers,events))),
                 marker_clock_buckets=sum(g['marker_clock_buckets'] for g in game_results),
                 marker_buckets_without_celtics_sub=sum(g['marker_buckets_without_celtics_sub'] for g in game_results),
                 opponent_complete_changes_before_celtics=opponent_prefix_changes,
                 contiguous_sub_blocks=len(contiguous_blocks),
                 celtics_contiguous_block_sizes=dist(str(n) if n<3 else '3+' for b in contiguous_blocks if (n:=sum(p['role']=='sub_in' and p['team_id']==BOS for e in b for p in parts[e['event_id']]))),
                 celtics_entries=sum(len(g['entries']) for g in groups),
                 celtics_groups_reentry=sum(bool(set(g['entries']) & set(g['exits'])) for g in groups),
                 all_sub_clock_buckets=len(groups),celtics_sub_clock_buckets=sum(g['celtics_rows']>0 for g in groups),
                 celtics_group_sizes=dist(str(len(g['entries'])) if len(g['entries'])<3 else '3+' for g in groups if g['celtics_rows']),
                 all_team_group_sizes=dist(str(g['sub_rows']//2) if g['sub_rows']//2<3 else '3+' for g in groups),
                 unbalanced_celtics_groups=sum(len(g['entries'])!=len(g['exits']) for g in groups),
                 sub_groups_without_marker=sum(not g['marker_types'] for g in groups),
                 celtics_groups_without_marker=sum(g['celtics_rows']>0 and not g['marker_types'] for g in groups),
                 celtics_groups_with_intervening_non_sub=sum(bool(g['non_sub_between_celtics']) for g in groups),
                 repaired_events=sum(bool(e['order_repair_reason']) for e in events),
                 repaired_substitutions=sum(bool(e['order_repair_reason']) for e in events if e['type']=='substitution'),
                 mixed_team_groups=sum(g['celtics_rows']>0 and g['sub_rows']>g['celtics_rows'] for g in groups),
                 mixed_team_timeout_groups=sum(g['celtics_rows']>0 and g['sub_rows']>g['celtics_rows'] and 'timeout' in g['marker_types'] for g in groups),
                 opponent_rows_before=sum(g['opponent_rows_before'] for g in groups),opponent_rows_after=sum(g['opponent_rows_after'] for g in groups),
                 timeouts_before=sum(g['timeout_before'] for g in groups),timeouts_after=sum(g['timeout_after'] for g in groups),
                 stint_action_count_differences=stint_action_differences,
                 raw_inperiod_entries=sum(raw_inperiod_entries.values()),
                 stints=len(stints),null_fouls_entry=sum(s['personal_fouls_entry'] is None for s in stints),null_fouls_exit=sum(s['personal_fouls_exit'] is None for s in stints),
                 stint_start_reasons=dist(s['start_reason'] for s in stints),stint_end_reasons=dist(s['end_reason'] for s in stints),
                 foul_box_rows=len(comparisons),raw_fouler_mismatches=sum(c['official']!=c['all_fouler_roles'] for c in comparisons),
                 personal_foul_mismatches=[c for c in comparisons if c['official']!=c['personal_fouls']],
                 stint_foul_disagreements=stint_disagreements,
                 boundaries=len(boundaries),unknown_boundaries=sum(b['entries'] is None for b in boundaries),
                 changed_boundaries=sum(bool(b['entries']) for b in boundaries),boundary_entry_sizes=dist(str(len(b['entries'])) if b['entries'] is not None else 'unknown' for b in boundaries))
    return summary,game_results,groups,boundaries,comparisons

def opener_types(event, include_new=True):
    """Proposed openers, independent of the substitution target.

    Missing qualifiers mean unavailable, never a TEAM-description proxy.
    Period openings/ends are excluded by opener_counts, not counted twice.
    """
    t, subtype = event['type'], event.get('subtype')
    kinds = []
    if t == 'timeout' and subtype == 'full':
        kinds.append('timeout')
    if t == 'foul' and subtype in {'personal', 'offensive'}:
        kinds.append('foul')
    if t == 'turnover' and subtype in DEAD_TURNOVERS:
        kinds.append('dead_ball_turnover')
    if t == 'violation' and subtype in {'kicked ball', 'defensive goaltending', 'lane'}:
        kinds.append('violation')
    if include_new:
        opening_clock = 720000 if event['period'] <= 4 else 300000
        if t == 'jump_ball' and event['clock_remaining_ms'] != opening_clock:
            kinds.append('jump_ball')
        qualifiers = event.get('qualifiers') or []
        if t == 'rebound' and {'team', 'deadball'}.issubset(qualifiers):
            kinds.append('deadball_team_rebound')
    return kinds


def opener_counts(events, include_new=True):
    """Count candidate buckets, not qualified/scored windows.

    Adjacency associates an otherwise unanchored substitution bucket with the
    immediately previous opener bucket in canonical order, in the same period,
    with 0 < previous clock - current clock <= 2000 ms. No skipped buckets,
    period crossings or recursive/chained associations; no new candidates.
    """
    counts = C.Counter()
    remainder = C.Counter()
    ledger, adjacent = [], []
    ordered = sorted((e for e in events if e['validity'] == 'effective'),
                     key=lambda e: (e['game_id'], e['canonical_sequence']))
    for game_id, rows in itertools.groupby(ordered, lambda e: e['game_id']):
        bs = buckets(list(rows))
        def in_period(b):
            return 0 < b[0]['clock_remaining_ms'] < (720000 if b[0]['period'] <= 4 else 300000)
        candidates = {i for i, b in enumerate(bs) if in_period(b) and any(opener_types(e, include_new) for e in b)}
        direct, attached = set(), set()
        counts['candidate_inperiod_buckets'] += len(candidates)
        for i, b in enumerate(bs):
            own = [e for e in b if e['type'] == 'substitution' and e['team_id'] == BOS]
            if not own or not in_period(b):
                continue
            counts['celtics_substitution_buckets'] += 1
            if i in candidates:
                direct.add(i)
                continue
            counts['unanchored_before_adjacency'] += 1
            previous = bs[i - 1] if i else []
            gap = previous[0]['clock_remaining_ms'] - b[0]['clock_remaining_ms'] if previous else None
            reference = dict(game_id=game_id, period=b[0]['period'], clock_ms=b[0]['clock_remaining_ms'],
                             first_sub_sequence=own[0]['canonical_sequence'])
            if i - 1 in candidates and previous[0]['period'] == b[0]['period'] and 0 < gap <= 2000:
                attached.add(i - 1)
                counts['adjacency_anchored_substitution_buckets'] += 1
                adjacent.append(dict(reference, opener_bucket_sequence=previous[0]['canonical_sequence'], game_clock_gap_ms=gap))
                continue
            # Descriptions classify residual mechanisms ONLY; they never open a candidate.
            if any(e['type'] in {'foul', 'ejection'} for e in b):
                mechanism = 'technical_foul_or_ejection'
            elif any(e['type'] in {'violation', 'timeout'} for e in b):
                mechanism = 'delay_of_game_or_challenge'
            elif any(e['type'] == 'rebound' and (e.get('description') or '').startswith('TEAM ') for e in b):
                mechanism = 'team_rebound_qualifier_unavailable_or_not_deadball'
            elif all(e['type'] == 'substitution' for e in b):
                prior = previous[-1] if previous else {}
                if prior.get('type') == 'field_goal' and prior.get('shot_result') == 'made':
                    mechanism = 'substitution_only_after_made_basket'
                elif prior.get('type') == 'rebound':
                    mechanism = 'substitution_only_after_rebound'
                else:
                    mechanism = 'other_substitution_only'
            elif any(e['type'] == 'jump_ball' for e in b):
                mechanism = 'jump_ball'
            elif any(e['type'] == 'rebound' for e in b):
                mechanism = 'player_rebound'
            elif any(e['type'] == 'field_goal' and e.get('shot_result') == 'made' for e in b):
                mechanism = 'same_bucket_made_basket'
            else:
                mechanism = 'other'
            remainder[mechanism] += 1
            ledger.append(dict(reference, mechanism=mechanism))
        counts['same_bucket_positive_candidates'] += len(direct)
        counts['positive_candidates_after_adjacency'] += len(direct | attached)
    result = {key: counts[key] for key in [
        'candidate_inperiod_buckets', 'celtics_substitution_buckets',
        'same_bucket_positive_candidates', 'unanchored_before_adjacency',
        'adjacency_anchored_substitution_buckets', 'positive_candidates_after_adjacency']}
    result.update(unanchored_after_adjacency=len(ledger), remainder_mechanisms=dict(sorted(remainder.items())),
                  adjacency_ledger=adjacent, unanchored_ledger=ledger)
    n = result['candidate_inperiod_buckets']
    result['substitution_share_before_adjacency'] = result['same_bucket_positive_candidates'] / n if n else None
    result['substitution_share_after_adjacency'] = result['positive_candidates_after_adjacency'] / n if n else None
    assert sum(remainder.values()) == result['unanchored_after_adjacency']
    assert result['same_bucket_positive_candidates'] + result['adjacency_anchored_substitution_buckets'] + len(ledger) == result['celtics_substitution_buckets']
    return result


if __name__ == '__main__' and '--openers' in sys.argv:
    x = json.loads((ROOT / '2025-26.json').read_text())
    print(json.dumps(dict(baseline=opener_counts(x['tables']['events'], include_new=False),
                          proxy_free=opener_counts(x['tables']['events'])), indent=2, sort_keys=True))
elif __name__ == '__main__':
    for season in ['2025-26','2024-25']:
        x=json.loads((ROOT/(season+'.json')).read_text())
        summary,games,groups,boundaries,fouls=analyze(x)
        write(season+'-summary.json',summary)
        write(season+'-games.json',games)
        if season=='2025-26': write(season+'-groups.json',[g for g in groups if g['game_id'] in SAMPLE or g['non_sub_between_celtics'] or set(g['entries']) & set(g['exits'])])
        if season=='2025-26': write(season+'-boundaries.json',[b for b in boundaries if b['game_id'] in SAMPLE or b['entries'] is None])
        write(season+'-fouls.json',[f for f in fouls if f['official']!=f['all_fouler_roles'] or f['official']!=f['personal_fouls']])
        issue_groups={}
        for issue in x['tables']['data_quality_issues']:
            key=tuple(issue.get(k) for k in ['game_id','product','code','message'])
            if key not in issue_groups:
                issue_groups[key]={k:issue.get(k) for k in ['game_id','product','code','message']}
                issue_groups[key].update(count=0,example_issue_id=issue['issue_id'])
            issue_groups[key]['count']+=1
        write(season+'-provenance.json',dict(pin=x['pin'],objects=x['objects'],coverage=[{k:r.get(k) for k in ['game_id','product','quality_status','record_count','missing_reason','issue_ids']} for r in x['coverage']],issue_groups=list(issue_groups.values()),official_sources=[r for r in x['tables']['raw_objects'] if r['game_id'] in SAMPLE and r['source'] in {'cdn_pbp','cdn_box'}]))
        print(season,json.dumps(summary,indent=2))
