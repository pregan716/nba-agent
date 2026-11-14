"""Team selection for brief v5 (SPO-899): rotation stability of every NBA team in 2025-26.

Reads the exports the headroom check made (docs/evidence/projection-headroom/scripts/export.ts),
which already leave out every game from the Celtics' 71st on. The same date filter is applied
again here, from the Celtics schedule, before any box-score row is read.

"naive_mis" is a rough yardstick, not the reference projection: each player is forecast at his
mean minutes over the team's previous five games, and the figure is half the summed absolute
error per game. mis_early is the first 15 forecast games, mis_late the last 20.

  uv run --with pandas --with numpy python teams.py <cache dir with the exports> > results.txt
"""
import json, sys, numpy as np, pandas as pd
H = sys.argv[1]
BOS = "1610612738"
ABBR = dict(zip([str(1610612737+i) for i in range(30)], "ATL BOS CLE NOP CHI DAL DEN GSW HOU LAC LAL MIA MIL MIN BKN NYK ORL IND PHI PHX POR SAC SAS OKC TOR UTA MEM WAS DET CHA".split()))
games = pd.DataFrame(json.load(open(f"{H}/games-2025-26.json")))
games["tip"] = pd.to_datetime(games.scheduled_tipoff, utc=True)
# Holdout fixed from the Celtics schedule before any outcome row is read.
bg = games[(games.home_team_id == BOS) | (games.away_team_id == BOS)].sort_values("tip").reset_index(drop=True)
holdout_start = bg.tip.iloc[70]
withheld = set(games[games.tip >= holdout_start].game_id)
games = games[~games.game_id.isin(withheld)]
BOX = "game_id player_id team_id sec pts reb ast stl blk tov fg3m".split()
SUMMARY = "game_id player_id team_id starter status".split()
box = pd.DataFrame([json.loads(l) for l in open(f"{H}/player_box_scores-2025-26.jsonl")], columns=BOX)
summ = pd.DataFrame([json.loads(l) for l in open(f"{H}/v_player_game_summary-2025-26.jsonl")], columns=SUMMARY)
n0 = len(box)
box = box[~box.game_id.isin(withheld)]; summ = summ[~summ.game_id.isin(withheld)]
print("withheld games", len(withheld), "box rows dropped", n0 - len(box), "max tip kept", games.tip.max(), "holdout start", holdout_start)
df = box.merge(summ, on=["game_id","player_id","team_id"], how="left").merge(games[["game_id","tip"]], on="game_id")
df["min"] = pd.to_numeric(df.sec).fillna(0)/60
df["starter"] = df.starter.fillna(False).astype(bool)
df["pts"] = pd.to_numeric(df.pts).fillna(0)
TP = df.groupby(["game_id","team_id"], as_index=False).pts.sum()
rows = []
for t, d in df.groupby("team_id"):
    gl = d[["game_id","tip"]].drop_duplicates().sort_values("tip").game_id.tolist()
    piv = d.pivot_table(index="game_id", columns="player_id", values="min", aggfunc="sum").reindex(gl).fillna(0)
    mis = []
    for i in range(5, len(gl)):
        f = piv.iloc[i-5:i].mean(); a = piv.iloc[i]
        mis.append((a - f).abs().sum()/2)
    mis = np.array(mis)
    lineups = d[d.starter].groupby("game_id").player_id.apply(lambda s: tuple(sorted(s)))
    tot = piv.sum().sort_values(ascending=False)
    top5 = tot.index[:5]
    missed = int((piv[top5] == 0).sum().sum())
    first = (piv > 0).idxmax().map({g:i for i,g in enumerate(gl)})
    last = (piv.iloc[::-1] > 0).idxmax().map({g:i for i,g in enumerate(gl)})
    arrivals = int(((first >= 10) & (tot >= 150)).sum())
    departures = int(((last < len(gl) - 15) & (tot >= 150)).sum())
    w = (TP[TP.team_id == t].set_index("game_id").pts > TP[TP.team_id != t].groupby("game_id").pts.sum().reindex(TP[TP.team_id == t].game_id).values).mean()
    rows.append(dict(team=ABBR.get(t,t), games=len(gl), win=round(w,2), naive_mis=round(mis.mean(),1), mis_early=round(mis[:15].mean(),1), mis_late=round(mis[-20:].mean(),1),
        lineups=lineups.nunique(), starters=int(d[d.starter].player_id.nunique()), used=int((tot>0).sum()), top5_missed=missed, arrivals=arrivals, departures=departures))
out = pd.DataFrame(rows).sort_values("naive_mis")
print(out.to_string(index=False))

# ---------- schedule only (no outcomes): evaluation windows and overlaps ----------
sched = pd.DataFrame(json.load(open(f"{H}/games-2025-26.json")))
sched["tip"] = pd.to_datetime(sched.scheduled_tipoff, utc=True)
ID = {v: k for k, v in ABBR.items()}
def of(team):
    return sched[(sched.home_team_id == ID[team]) | (sched.away_team_id == ID[team])].sort_values("tip")
DEV, TEST = ["BOS", "OKC", "WAS"], ["DEN", "MEM"]
print("\nseason opens", sched.tip.min(), "holdout starts", holdout_start)
for t in DEV + TEST:
    g = of(t)
    print(t, "games before holdout date", int((g.tip < holdout_start).sum()), "on or after", int((g.tip >= holdout_start).sum()))
dev = pd.concat([of(t).assign(team=t) for t in DEV])
dev = dev[dev.tip < holdout_start]
for name, a, b in [("opening", "2025-10-21", "2025-11-17"), ("middle", "2026-01-05", "2026-02-01"), ("late", "2026-02-23", "2026-03-22")]:
    w = dev[(dev.tip >= a) & (dev.tip < pd.Timestamp(b, tz="UTC") + pd.Timedelta(days=1))]
    print("window", name, a, b, "team-games", len(w), dict(w.team.value_counts()), "distinct games", w.game_id.nunique())
pre = sched[sched.tip < holdout_start]
both = pre[(pre.home_team_id.isin([ID[t] for t in DEV]) & pre.away_team_id.isin([ID[t] for t in TEST])) | (pre.home_team_id.isin([ID[t] for t in TEST]) & pre.away_team_id.isin([ID[t] for t in DEV]))]
print("development-team games against test teams before the holdout date:", len(both))
tt = sched[sched.home_team_id.isin([ID[t] for t in TEST]) & sched.away_team_id.isin([ID[t] for t in TEST])]
print("games between the two test teams, whole season:", len(tt))
