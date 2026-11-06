"""SPO-845 cross-check: curated Celtics transactions versus released box-score membership.

The curated file (config/celtics-transactions-2025-26.json) is the source of truth for
who is on the roster at each scheduled tip. Box-score membership is used here only to
check it, game by game; it is never a roster source. Reads the cached export written by
scripts/decision-window-export.ts against the pinned release.
"""
import collections as C
import json
import pathlib
import sys

BOS = '1610612738'
CONFIG = pathlib.Path('config/celtics-transactions-2025-26.json')
EXPORT = pathlib.Path('.cache/spo837/2025-26.json')
OUT = pathlib.Path('docs/evidence/roster/crosscheck.json')


def roster_at(config, tip):
    """Opening roster, then every event available strictly before tip, in availability order."""
    members = {p['playerId'] for p in config['openingRoster']}
    assert config['openingAvailableFrom'] < tip
    for event in sorted(config['events'], key=lambda e: (e['availableAt'], e['id'])):
        if event['availableAt'] >= tip:
            break
        assert set(event['out']) <= members, (event['id'], 'departure of a non-member')
        assert not set(event['in']) & (members - set(event['out'])), (event['id'], 'arrival of a member')
        members = (members - set(event['out'])) | set(event['in'])
    return members


def main():
    config = json.loads(CONFIG.read_text())
    export = json.loads(EXPORT.read_text())
    official = json.loads(pathlib.Path(config['sources']['official']['path']).read_text())
    assert official['source']['sha256'] == config['sources']['official']['fullDownloadSha256']
    for event in config['events']:
        assert all(s in config['sources'] for s in event['sources']), event['id']
    games = sorted(export['games'], key=lambda g: g['scheduled_tipoff'])
    box, played = C.defaultdict(set), C.defaultdict(set)
    for row in export['tables']['player_box_scores']:
        if row['team_id'] == BOS:
            box[row['game_id']].add(row['player_id'])
            if (row.get('minutes_seconds') or 0) > 0:
                played[row['game_id']].add(row['player_id'])
    rows, disagreements = [], []
    for number, game in enumerate(games, 1):
        tip = game['scheduled_tipoff'].replace('.000Z', 'Z')
        roster = roster_at(config, tip)
        only_curated, only_box = sorted(roster - box[game['game_id']]), sorted(box[game['game_id']] - roster)
        played_off_roster = sorted(played[game['game_id']] - roster)
        rows.append(dict(game_number=number, game_id=game['game_id'], scheduled_tip=tip, roster=sorted(roster),
                         roster_size=len(roster), box_size=len(box[game['game_id']])))
        if only_curated or only_box:
            disagreements.append(dict(game_number=number, game_id=game['game_id'], scheduled_tip=tip,
                                      curated_not_in_box=only_curated, box_not_curated=only_box,
                                      played_but_not_curated=played_off_roster))
    result = dict(
        release_pin=export['pin'], curated_file=str(CONFIG), games=len(rows),
        distinct_rosters=len({tuple(r['roster']) for r in rows}),
        disagreements=disagreements, per_game=rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    sizes = C.Counter(r['roster_size'] for r in rows)
    print('games', len(rows), 'distinct rosters', result['distinct_rosters'], 'roster sizes', dict(sorted(sizes.items())))
    print('disagreements', len(disagreements))
    for d in disagreements:
        print(' ', d)
    if disagreements and '--allow-disagreements' not in sys.argv:
        sys.exit(1)


if __name__ == '__main__':
    main()
