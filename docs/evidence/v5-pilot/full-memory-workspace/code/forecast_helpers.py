"""
Forecast helper utilities for Celtics 2025-26 season.
Updated after Game 2 (0022500018).
"""

# Player ID to name mapping
PLAYER_NAMES = {
    "1627759": "Jaylen Brown",
    "1628369": "Jayson Tatum",
    "1628401": "Derrick White",
    "1628449": "Chris Boucher",
    "1629014": "Anfernee Simons",
    "1629674": "Neemias Queta",
    "1630202": "Payton Pritchard",
    "1630214": "Xavier Tillman",
    "1630568": "Luka Garza",
    "1630573": "Sam Hauser",
    "1631169": "Josh Minott",
    "1631199": "Ron Harper Jr.",
    "1631248": "Baylor Scheierman",
    "1641775": "Jordan Walsh",
    "1642864": "Hugo González",
    "1642873": "Amari Williams",
    "1642917": "Max Shulga",
}

# Starting 5 (stable through first 2 games)
STARTERS = ["1630202", "1628401", "1627759", "1630573", "1629674"]

# Role tiers
CORE = ["1627759", "1628401", "1630202", "1630573"]  # starters with heavy min
ROTATION_LOCKED = ["1629014", "1629674", "1628449", "1630214"]  # always play when healthy
VOLATILE_BENCH = ["1631169", "1642864"]  # one plays 15-20 min, other may DNP
DEEP_BENCH = ["1631248", "1641775"]  # spot minutes 0-5
GARBAGE_TIME = ["1642873", "1642917"]  # 0-2 min
OUT_LONG_TERM = ["1628369", "1630568"]  # Tatum (Achilles), Garza (concussion)

# Game history: minutes by player (game_id: {player_id: minutes})
GAME_MINUTES = {
    "0022500083": {  # G1 vs PHI
        "1630202": 37.1, "1627759": 36.2, "1628401": 35.4, "1629014": 32.3,
        "1629674": 25.1, "1630573": 22.4, "1628449": 15.8, "1630214": 15.6,
        "1631169": 14.2, "1630568": 5.7,
    },
    "0022500018": {  # G2 @ NYK
        "1630202": 35.9, "1627759": 35.5, "1628401": 33.2, "1630573": 27.7,
        "1629014": 27.1, "1642864": 22.6, "1629674": 21.6, "1628449": 15.4,
        "1630214": 13.8, "1631248": 4.2, "1641775": 2.4, "1642873": 0.7,
    },
}

# Fantasy points per game
GAME_FP = {
    "0022500083": {
        "1627759": 38.5, "1628401": 40.75, "1630202": 28.75, "1629014": 24.5,
        "1629674": 26.0, "1630573": 11.5, "1628449": 14.5, "1630214": 20.25,
        "1631169": 7.5, "1630568": 2.25,
    },
    "0022500018": {
        "1627759": 32.5, "1628401": 31.0, "1630202": 25.25, "1629014": 22.75,
        "1629674": 19.25, "1630573": 28.25, "1628449": 15.0, "1630214": 10.75,
        "1642864": 16.5, "1631248": 1.25, "1641775": 0.0, "1642873": 1.25,
    },
}


def get_player_avg_minutes(player_id, games_played=None):
    """Get average minutes across games played."""
    mins = []
    for gid, gdata in GAME_MINUTES.items():
        if games_played and gid not in games_played:
            continue
        if player_id in gdata:
            mins.append(gdata[player_id])
    return sum(mins) / len(mins) if mins else 0


def dk_fantasy_points(pts, reb, ast, stl, blk, tov, three_pm):
    """Calculate DraftKings Classic fantasy points."""
    fp = pts + 0.5 * three_pm + 1.25 * reb + 1.5 * ast + 2 * stl + 2 * blk - 0.5 * tov
    # Double-double / triple-double bonus
    cats = sum(1 for x in [pts, reb, ast, stl, blk] if x >= 10)
    if cats >= 2:
        fp += 1.5
    if cats >= 3:
        fp += 3
    return fp
