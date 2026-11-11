"""Deterministic team-game reference. stdin and stdout carry trusted JSON only."""
import hashlib
import json
import pickle
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor

LEVELS = [.05, .10, .25, .50, .75, .90, .95]
STATS = ["minutes", "points", "rebounds", "assists", "fantasy_points"]
PRIOR = np.array([.47, .18, .11, .96])
BOS = "1610612738"


class Player:
    def __init__(self):
        self.minutes = self.starts = self.start_weight = self.weight = 0.
        self.plays = self.opportunities = 0.
        self.stats = np.zeros(4)
        self.rate_minutes = self.games = self.missed = self.last = 0.
        self.team = None
        self.team_games = 0

    def features(self, team):
        return [self.minutes / self.weight if self.weight else np.nan,
                self.plays / self.opportunities if self.opportunities else .5,
                self.starts / self.start_weight if self.start_weight else np.nan,
                self.games, self.last, self.missed, self.team_games if team == self.team else 0]

    def observe(self, row, team):
        if team != self.team:
            self.team, self.team_games = team, 0
        if row["inactive"]:
            self.missed += 1
            return
        minutes = row["minutes"]
        self.opportunities = .85 * self.opportunities + 1
        self.plays = .85 * self.plays + row["played"]
        if row["played"]:
            self.weight = .8 * self.weight + 1
            self.minutes = .8 * self.minutes + minutes
            if row["starter"] is not None:
                self.starts = .8 * self.starts + row["starter"]
                self.start_weight = .8 * self.start_weight + 1
            self.stats = .95 * self.stats + [row[s] for s in STATS[1:]]
            self.rate_minutes = .95 * self.rate_minutes + minutes
            self.last, self.missed = minutes, 0
            self.games += 1
            self.team_games += 1


def features(rows, team, history):
    players = [history[r["playerId"]] for r in rows]
    x = np.array([p.features(team) for p in players])
    rates = np.array([(p.stats + 60 * PRIOR) / (p.rate_minutes + 60) for p in players])
    expected = np.nan_to_num(x[:, 0]) * x[:, 1]
    out = np.array([r["inactive"] for r in rows], dtype=bool)
    available = np.where(out, 0., expected)
    ranks = np.argsort(np.argsort(-available, kind="stable"), kind="stable") + 1
    return np.column_stack([x, expected, 240 * available / (available.sum() or 1),
                            np.full(len(rows), expected[out].sum()), ranks]), rates, out


def fit(x, y, out):
    opts = dict(max_iter=300, learning_rate=.05, max_depth=5,
                min_samples_leaf=40, random_state=1, early_stopping=False)
    played = y[:, 5] == 1
    known_start = played & np.isfinite(y[:, 6])
    return [HistGradientBoostingClassifier(**opts).fit(x[~out], played[~out]),
            HistGradientBoostingRegressor(**opts).fit(x[played], y[played, 0]),
            HistGradientBoostingClassifier(**opts).fit(x[known_start], y[known_start, 6])]


def probability(model, x):
    if len(model.classes_) == 1:
        return np.full(len(x), float(model.classes_[0]))
    return model.predict_proba(x)[:, 1]


def predict(models, x, rates, out, groups):
    p = np.where(out, 0, probability(models[0], x))
    conditional = np.maximum(models[1].predict(x), .1)
    totals = np.bincount(groups, weights=p * conditional)
    minutes = np.clip(conditional * 240 / np.maximum(totals[groups], 1), 1, 46)
    return p, p * probability(models[2], x), np.column_stack([minutes, minutes[:, None] * rates])


def forecast(data):
    history = defaultdict(Player)
    xs, ys, rs, outs, gs, release_times = [], [], [], [], [], []
    # Outcomes update player histories only once their release precedes the
    # historical example's tip, including on days with multiple league games.
    games = sorted(data["history"], key=lambda g: (g["tip"], g["gameId"]))
    by_release = sorted(games, key=lambda g: (g["release"], g["tip"], g["gameId"]))
    position = 0

    def advance(cutoff):
        nonlocal position
        while position < len(by_release) and by_release[position]["release"] < cutoff:
            game = by_release[position]
            for row in game["players"]:
                history[row["playerId"]].observe(row, row["teamId"])
            position += 1

    group = 0
    for game in games:
        if game["release"] >= data["tip"]:
            raise ValueError("unreleased training game")
        advance(game["tip"])
        teams = defaultdict(list)
        for r in game["players"]:
            teams[r["teamId"]].append(r)
        for team, rows in sorted(teams.items()):
            rows.sort(key=lambda r: r["playerId"])
            x, rates, out = features(rows, team, history)
            xs.append(x)
            rs.append(rates)
            outs.append(out)
            ys.extend([[r[s] for s in STATS] + [r["played"], r["starter"]] for r in rows])
            gs.extend([group] * len(rows))
            release_times.extend([game["release"]] * len(rows))
            group += 1
    advance(data["tip"])
    x, rates, out = np.vstack(xs), np.vstack(rs), np.concatenate(outs)
    y, groups = np.array(ys, dtype=float), np.array(gs)
    # Hold back whole later games for errors of forecasts on unseen outcomes.
    split_tip = games[int(.8 * len(games))]["tip"]
    early = np.array(release_times) < split_tip
    calibrate = np.repeat([g["tip"] >= split_tip for g in games], [len(g["players"]) for g in games])
    pilot = fit(x[early], y[early], out[early])
    _, _, centers = predict(pilot, x[calibrate], rates[calibrate], out[calibrate], groups[calibrate])
    played = y[calibrate, 5] == 1
    residuals = y[calibrate][played, :5] - centers[played]
    # Similar workloads have similar production variance.
    bins = [8, 18, 30]
    buckets = np.digitize(centers[played, 0], bins)
    offsets = []
    for b in range(len(bins) + 1):
        errors = residuals[buckets == b]
        offsets.append(np.quantile(errors if len(errors) >= 40 else residuals, LEVELS, axis=0).T)
    models = fit(x, y, out)
    roster = sorted(data["roster"], key=lambda r: r["playerId"])
    x, rates, out = features(roster, BOS, history)
    p, starts, centers = predict(models, x, rates, out, np.zeros(len(x), dtype=int))
    players = []
    for i, row in enumerate(roster):
        ranges = centers[i, :, None] + offsets[np.digitize(centers[i, 0], bins)]
        ranges = np.clip(ranges, np.array([0, 0, 0, 0, -10])[:, None],
                         np.array([58, np.inf, np.inf, np.inf, np.inf])[:, None])
        players.append(dict(playerId=row["playerId"], p_play=p[i], p_start=starts[i],
                            **dict(zip(STATS, ranges.tolist()))))
    h = hashlib.sha256(Path(__file__).read_bytes())
    h.update(pickle.dumps(models, protocol=5))
    h.update(np.asarray(offsets).tobytes())
    h.update(json.dumps(data, sort_keys=True, separators=(",", ":")).encode())
    return dict(modelHash=h.hexdigest(), forecast=dict(version="forecast-v1", gameId=data["gameId"], players=players))


if __name__ == "__main__":
    json.dump(forecast(json.load(sys.stdin)), sys.stdout, allow_nan=False)
