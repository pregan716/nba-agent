"""Compare the pinned roster at tip with released team boxes before the holdout.

Run from the repository root, e.g. python3 scripts/roster-crosscheck.py MEM.
The reader applies the schedule and release gates before decoding box rows.
The historical full-season Boston report is preserved separately.
"""
import argparse
import json
from pathlib import Path
import subprocess


# Key by the exact two set differences. A changed discrepancy needs fresh review.
EXPLANATIONS = {
    ("0022500730", ("203486",), ("1642272",)): (
        "The box lists Mason Plumlee and omits Jared McCain. Oklahoma City announced "
        "both McCain's acquisition and Plumlee's waiver at 01:54:46Z, before the 02:30Z tip.",
        "https://www.nba.com/thunder/news/release-mccain-260204",
    ),
    ("0022500758", ("203957",), ()): (
        "The box still lists Dante Exum. Washington's waiver was public before the 19:00Z tip.",
        "https://www.hoopsrumors.com/2026/02/wizards-waive-dante-exum.html",
    ),
    ("0022500822", (), ("1641778",)): (
        "The box omits Leaky Black. Washington announced his two-way signing the previous day.",
        "https://gleague.nba.com/news/washington-signs-tristan-vukcevic-to-multi-year-contract",
    ),
    ("0022500865", (), ("1642882",)): (
        "The box omits Julian Reese. Washington announced his two-way signing before tip.",
        "https://www.hoopsrumors.com/2026/02/wizards-sign-julian-reese-to-two-way-contract.html",
    ),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("team", choices=["BOS", "DEN", "MEM", "OKC", "WAS"],
                        default="BOS", nargs="?")
    parser.add_argument("--allow-disagreements", action="store_true")
    args = parser.parse_args()
    data = json.loads(subprocess.check_output([
        "node_modules/.bin/tsx", "scripts/roster-crosscheck-input.ts", args.team,
    ]))
    rows, disagreements = [], []
    for game in data["games"]:
        box_rows = game.pop("box")
        box = {row["playerId"] for row in box_rows}
        played = {row["playerId"] for row in box_rows if (row["minutesSeconds"] or 0) > 0}
        roster = set(game["roster"])
        rows.append(dict(**game, roster_size=len(roster), box_size=len(box)))
        only_box, only_roster = sorted(box - roster), sorted(roster - box)
        if only_box or only_roster:
            explanation = EXPLANATIONS.get((game["game_id"], tuple(only_box), tuple(only_roster)))
            disagreements.append(dict(
                game_id=game["game_id"], scheduled_tip=game["scheduled_tip"],
                box_not_curated=only_box, curated_not_in_box=only_roster,
                played_not_curated=sorted(played - roster),
                explanation=explanation[0] if explanation else None,
                source=explanation[1] if explanation else None,
            ))

    report = dict(team=args.team, release_pin=data["release_pin"], cutoff=data["cutoff"],
                  roster_sources=data["roster_sources"], games=len(rows),
                  distinct_rosters=len({tuple(row["roster"]) for row in rows}),
                  disagreements=disagreements, per_game=rows)
    out = Path(f"docs/evidence/roster/crosscheck-{args.team}.json")
    out.write_text(json.dumps(report, indent=2) + "\n")
    print(f"{args.team}: {len(rows)} released games, {len(disagreements)} disagreements")
    if any(d["explanation"] is None or d["played_not_curated"] for d in disagreements) and not args.allow_disagreements:
        raise SystemExit(f"Roster discrepancy requires review in {out}")


if __name__ == "__main__":
    main()
