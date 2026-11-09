import json
from pathlib import Path


def assemble(state):
    note = Path('/package/components/instructions.txt').read_text()
    players = {p['playerId']: p for p in state['players']}
    outs = sorted(state['celtics'], key=lambda p: (-players[p]['currentStintMinutes'], p))
    ins = sorted(state['eligibleBench'], key=lambda p: (-(players[p]['restMs'] if players[p]['restMs'] is not None else -1), p))
    candidates = [{'out': outs[:k], 'in': ins[:k]} for k in (1, 2) if len(ins) >= k]
    criteria = {'out:' + ','.join(sorted(c['out'])) + '|in:' + ','.join(sorted(c['in'])):
                'Players out: ' + ', '.join(c['out']) + '. Players in: ' + ', '.join(c['in']) + '.'
                for c in candidates}
    if ins:
        criteria['other'] = 'Any legal substitution not listed.'
    prediction = {'substitution': {'type': 'noul', 'noul': 0.25}}
    if ins:
        prediction['swap'] = {'type': 'choice', 'probabilities': {
            key: (0.6 if key == 'other' else 0.4 / len(candidates)) for key in criteria}}
    return {
        'prediction': prediction,
        'defer': {'reason': 'Between-period lineup reset'} if state['stoppage']['kind'] == 'between_periods' else None,
        'jev_state': json.dumps(state, sort_keys=True, separators=(',', ':')),
        'candidates': candidates,
        'instructions': {'substitution': note + ' Will the Celtics substitute at this window?',
                         'swap': 'Conditional on a substitution, which complete swap will the coach make?'},
        'criteria': {'substitution': {'true': 'At least one Celtics player is replaced.', 'false': 'No substitution.'},
                     'swap': criteria},
        'diagnostics': {'components': ['components/instructions.txt'], 'features': ['currentStintMinutes', 'restMs']},
    }
