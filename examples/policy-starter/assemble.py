from nba_starter import predict
import json
from pathlib import Path


def assemble(state):
    note = Path('/package/components/instructions.txt').read_text()
    model = predict(state)
    candidates = model['candidates']
    ins = state['eligibleBench']
    criteria = {'out:' + ','.join(sorted(c['out'])) + '|in:' + ','.join(sorted(c['in'])):
                'Players out: ' + ', '.join(c['out']) + '. Players in: ' + ', '.join(c['in']) + '.'
                for c in candidates}
    if ins:
        criteria['other'] = 'Any legal substitution not listed.'
    prediction = model['prediction']
    return {
        'prediction': prediction,
        'defer': None,
        'jev_state': json.dumps(state, sort_keys=True, separators=(',', ':')),
        'candidates': candidates,
        'instructions': {'substitution': note + ' Will the Celtics substitute at this window?',
                         'swap': 'Conditional on a substitution, which complete swap will the coach make?'},
        'criteria': {'substitution': {'true': 'At least one Celtics player is replaced.', 'false': 'No substitution.'},
                     'swap': criteria},
        'diagnostics': {'components': ['components/instructions.txt'], 'features': ['starter-hgb-e-v1']},
    }
