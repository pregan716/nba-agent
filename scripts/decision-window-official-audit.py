"""Compare archived official NBA actions with release rows; emit hand-review sheets.
This checks descriptive candidates, not substitution legality or a replay builder.
"""
import collections as C
import itertools
import json
import pathlib

ROOT=pathlib.Path('.cache/spo837')
OUT=pathlib.Path('docs/evidence/decision-windows')
BOS='1610612738'
SAMPLE=['0022500083','0022500637','0022500338']
x=json.loads((ROOT/'2025-26.json').read_text())
DEAD={'out-of-bounds','offensive foul','shot clock','traveling','backcourt','3-second-violation','offensive goaltending','5-second-violation','discontinued dribble','double dribble','offensive-kicked-ball','8-second-violation','jumpball violation'}

def marker(a):
    t=a['actionType'];s=a.get('subType')
    return t in {'foul','timeout','freethrow','violation','ejection','period'} or (t=='turnover' and s in DEAD)

def dump(name,obj): (OUT/name).write_text(json.dumps(obj,indent=2,sort_keys=True)+'\n')
reports=[]; sheets=[]
for gid in SAMPLE:
    raw=json.loads((ROOT/f'cdn_pbp-{gid}.json').read_text())['game']['actions']
    box=json.loads((ROOT/f'cdn_box-{gid}.json').read_text())['game']
    es=sorted([e for e in x['tables']['events'] if e['game_id']==gid],key=lambda e:e['canonical_sequence'])
    mapped={e['source_event_ids'][0]:e for e in es}
    lineups={str(box[t]['teamId']):set(str(p['personId']) for p in box[t]['players'] if p['starter']=='1') for t in ['homeTeam','awayTeam']}
    names={str(p['personId']):p['nameI'] for t in ['homeTeam','awayTeam'] for p in box[t]['players']}
    side={str(box[t]['teamId']):'home' if t=='homeTeam' else 'away' for t in ['homeTeam','awayTeam']}
    disagreements=[];checks=[];source_disagreements=[]
    for i,a in enumerate(raw):
        e=mapped.get(str(a['actionNumber']))
        if not e or e['canonical_sequence']!=i or e['description']!=a['description'] or e['clock_original']!=a['clock'] or e['period']!=a['period']:
            source_disagreements.append(a['actionNumber'])
    # Official starters + official ins/outs, independently of release lineups.
    # Apply a maximal contiguous run atomically, matching the feed's out/out/in/in format.
    for key,block in itertools.groupby(raw,lambda a:(a['actionType']=='substitution',a['period'],a['clock'])):
        block=list(block)
        if not key[0]: continue
        before={t:set(v) for t,v in lineups.items()}
        for a in block:
            t=str(a['teamId']);p=str(a['personId'])
            if a['subType']=='out':
                if p not in lineups[t]: disagreements.append(dict(action=a['actionNumber'],reason='official exit absent',player=p))
                lineups[t].discard(p)
            else:
                if p in lineups[t]: disagreements.append(dict(action=a['actionNumber'],reason='official entry already present',player=p))
                lineups[t].add(p)
        for t in lineups:
            if len(lineups[t])!=5: disagreements.append(dict(action=block[0]['actionNumber'],reason='official resulting lineup not five',team=t,lineup=sorted(lineups[t])))
        own=[a for a in block if str(a['teamId'])==BOS]
        if not own: continue
        first=mapped[str(own[0]['actionNumber'])]
        differences={t:dict(official=sorted(before[t]),release=first[side[t]+'_lineup_before']) for t in before if set(first[side[t]+'_lineup_before'])!=before[t]}
        if differences: disagreements.append(dict(action=own[0]['actionNumber'],reason='pre-block lineup mismatch',differences=differences))
        checks.append(dict(period=own[0]['period'],clock=own[0]['clock'],first_action=own[0]['actionNumber'],sequence=first['canonical_sequence'],
                           before=sorted(before[BOS]),opponent_before=sorted(before[next(t for t in before if t!=BOS)]),
                           before_names=[names[p] for p in sorted(before[BOS])],
                           exits=[a['playerNameI'] for a in own if a['subType']=='out'],entries=[a['playerNameI'] for a in own if a['subType']=='in'],lineup_agrees=not differences))
    bs=[list(b) for _,b in itertools.groupby(raw,lambda a:(a['period'],a['clock']))]
    candidates=[b for b in bs if any(marker(a) for a in b)]
    # Every candidate appears with the full official descriptions and release sequence
    # to support inspection of negative windows as well as substitutions.
    for b in bs:
        if any(marker(a) or a['actionType']=='substitution' for a in b):
            sheets.append(dict(game_id=gid,period=b[0]['period'],clock=b[0]['clock'],marker_candidate=any(marker(a) for a in b),
                               official_actions=[dict(action=a['actionNumber'],sequence=mapped[str(a['actionNumber'])]['canonical_sequence'],description=a['description']) for a in b]))
    reports.append(dict(game_id=gid,official_actions=len(raw),release_events=len(es),source_disagreements=source_disagreements,
                        official_marker_clock_buckets=len(candidates),official_negative_marker_buckets=sum(not any(a['actionType']=='substitution' and str(a.get('teamId'))==BOS for a in b) for b in candidates),
                        official_celtics_rows=sum(a['actionType']=='substitution' and str(a.get('teamId'))==BOS for a in raw),
                        official_celtics_sub_clock_buckets=sum(any(a['actionType']=='substitution' and str(a.get('teamId'))==BOS for a in b) for b in bs),
                        celtics_contiguous_sub_blocks=len(checks),checks=checks,lineup_disagreements=disagreements))
dump('official-audit.json',reports)
dump('official-review-sheets.json',sheets)
print(json.dumps([{k:v for k,v in r.items() if k!='checks'} for r in reports],indent=2))
