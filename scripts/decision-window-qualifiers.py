"""SPO-837 qualifier update on the spo-839 release: descriptive only, not a replay dataset.

Reads the cached export written by scripts/decision-window-export.ts against the
pinned releases and answers one question: what does the restored `qualifiers`
array on events say about team rebounds, and what would the proposed
dead-ball team-rebound opener do to the windows-v1 counts if it were enabled?
"""
import collections as C
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import importlib

analysis = importlib.import_module('decision-window-analysis')

ROOT = pathlib.Path('.cache/spo837')
OUT = pathlib.Path('docs/evidence/decision-windows')
BOS = '1610612738'
DEAD = analysis.DEAD_TURNOVERS


def opener_kind(event):
    """windows-v1 openers without the team-rebound branch."""
    t, s = event['type'], event.get('subtype')
    if t == 'timeout' and s == 'full':
        return 'timeout'
    if t == 'foul' and s in ('personal', 'offensive'):
        return 'foul'
    if t == 'turnover' and s in DEAD:
        return 'dead_ball_turnover'
    if t == 'violation' and s != 'delay-of-game':
        return 'violation'
    if t == 'jump_ball':
        return 'jump_ball'
    return None


def shot_result(event):
    if event['type'] in ('field_goal', 'free_throw'):
        return 'made' if event.get('points_credited') else 'missed'
    return ''


def main():
    export = json.loads((ROOT / '2025-26.json').read_text())
    events = [e for e in export['tables']['events'] if e.get('validity') == 'effective']
    assert all('qualifiers' in e for e in export['tables']['events'])
    assert not any(e['qualifiers'] is None for e in export['tables']['events'])

    vocabulary = C.Counter()
    for e in export['tables']['events']:
        for q in e['qualifiers']:
            vocabulary[f"{e['type']}:{q}"] += 1

    by_game = C.defaultdict(list)
    for e in events:
        by_game[e['game_id']].append(e)
    preceded = {'deadball_team_rebound': C.Counter(), 'team_rebound_without_deadball': C.Counter()}
    sole_opener_buckets = []
    for game_id, rows in by_game.items():
        rows.sort(key=lambda e: e['canonical_sequence'])
        for i, e in enumerate(rows):
            if e['type'] != 'rebound' or 'team' not in e['qualifiers']:
                continue
            prev = rows[i - 1] if i else None
            key = 'none' if prev is None else ' '.join(
                x for x in (prev['type'], prev.get('subtype') or '', shot_result(prev)) if x)
            group = 'deadball_team_rebound' if 'deadball' in e['qualifiers'] else 'team_rebound_without_deadball'
            preceded[group][key] += 1
        # Equal-clock buckets that hold a deadball team rebound and no windows-v1 opener.
        i = 0
        while i < len(rows):
            j = i
            while j < len(rows) and (rows[j]['period'], rows[j]['clock_remaining_ms']) == (
                    rows[i]['period'], rows[i]['clock_remaining_ms']):
                j += 1
            bucket = rows[i:j]
            if any(e['type'] == 'rebound' and {'team', 'deadball'} <= set(e['qualifiers']) for e in bucket) \
                    and not any(opener_kind(e) for e in bucket):
                sole_opener_buckets.append(dict(
                    game_id=game_id, period=bucket[0]['period'], clock_remaining_ms=bucket[0]['clock_remaining_ms'],
                    sequence_span=[bucket[0]['canonical_sequence'], bucket[-1]['canonical_sequence']],
                    celtics_substitution_rows=sum(1 for e in bucket if e['type'] == 'substitution' and e.get('team_id') == BOS),
                    contains_ejection=any(e['type'] == 'ejection' for e in bucket),
                    foul_subtypes=sorted({e.get('subtype') for e in bucket if e['type'] == 'foul'}),
                    rows=[f"{e['type']}/{e.get('subtype')}" for e in bucket]))
            i = j

    all_events = export['tables']['events']
    modes = (
        ('baseline_without_jump_ball_or_team_rebound', analysis.opener_counts(all_events, include_new=False)),
        ('windows_v1_jump_ball_on_team_rebound_off', analysis.opener_counts(all_events, team_rebound=False)),
        ('hypothetical_with_deadball_team_rebound_opener', analysis.opener_counts(all_events)),
    )
    counts = {}
    for name, r in modes:
        counts[name] = {k: v for k, v in r.items() if not isinstance(v, (list, dict))}
        counts[name]['remainder_mechanisms'] = r['remainder_mechanisms']
    adopted, hypothetical = counts[modes[1][0]], counts[modes[2][0]]
    delta = {k: hypothetical[k] - adopted[k] for k in (
        'candidate_inperiod_buckets', 'same_bucket_positive_candidates', 'positive_candidates_after_adjacency',
        'adjacency_anchored_substitution_buckets', 'unanchored_after_adjacency')}
    # Every deadball-only bucket is a new candidate; the only anchored one is the bucket with substitution rows.
    assert delta['candidate_inperiod_buckets'] == len(sole_opener_buckets), delta
    anchored = sum(1 for b in sole_opener_buckets if b['celtics_substitution_rows'])
    assert delta['same_bucket_positive_candidates'] == anchored == -delta['unanchored_after_adjacency'], delta
    assert delta['adjacency_anchored_substitution_buckets'] == 0, delta
    assert delta['positive_candidates_after_adjacency'] == anchored, delta
    counts['delta_hypothetical_minus_windows_v1'] = delta

    official = {}
    for game_id in analysis.SAMPLE:
        actions = json.loads((ROOT / f'cdn_pbp-{game_id}.json').read_text())
        actions = actions.get('game', actions).get('actions') if isinstance(actions, dict) else actions
        by_action = {str(a['actionNumber']): a.get('qualifiers', []) for a in actions}
        rows = [e for e in export['tables']['events'] if e['game_id'] == game_id]
        official[game_id] = dict(
            events=len(rows), source_actions=len(actions),
            qualifiers_equal_to_source=sum(1 for e in rows if by_action.get(e['event_id'].rsplit(':', 1)[-1]) == e['qualifiers']))

    result = dict(
        pin=export['pin'],
        scope='82 Celtics regular-season games, 2025-26; effective events only unless stated',
        qualifier_vocabulary_by_event_type=dict(sorted(vocabulary.items())),
        team_rebounds_preceded_by={k: dict(v.most_common()) for k, v in preceded.items()},
        deadball_team_rebound_buckets_with_no_other_opener=sole_opener_buckets,
        opener_set_counts=counts,
        official_sample_qualifier_equality=official,
    )
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / '2025-26-qualifiers-spo839.json').write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    print(json.dumps({k: result[k] for k in ('team_rebounds_preceded_by', 'opener_set_counts', 'official_sample_qualifier_equality')}, indent=2))
    print('deadball-only buckets:', len(sole_opener_buckets))


if __name__ == '__main__':
    main()
