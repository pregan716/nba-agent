import json
from pathlib import Path


def assemble(state):
    note = Path('/package/components/instructions.txt').read_text()
    return {
        'jev_state': json.dumps(state, sort_keys=True, separators=(',', ':')),
        'instructions': {
            'substitution': note + ' Will the Celtics substitute at this window?',
            'count': 'How many Celtics players will be replaced at this window?',
            'exit': 'Conditional on a substitution, which on-court Celtics player exits?',
            'entry': 'Conditional on a substitution, which eligible Celtics bench player enters?',
        },
        'criteria': {
            'substitution': {'true': 'At least one Celtics player is replaced.', 'false': 'No Celtics substitution.'},
            'count': {'none': 'No players replaced', 'one': 'One player replaced', 'two': 'Two players replaced', 'three_or_more': 'Three or more players replaced'},
            'exit': {p: f'Celtics player {p} exits' for p in state['celtics']},
            'entry': {p: f'Celtics player {p} enters' for p in state['eligibleBench']},
        },
        'diagnostics': {'components': ['components/instructions.txt'], 'features': []},
    }
