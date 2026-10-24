"""Read only, cutoff-selected session and historical data.

query executes SQL once per game and concatenates results. For global aggregates,
use table(...).groupby(...), or aggregate the returned per-game counts/sums.
"""

from pathlib import Path
import sqlite3
import gzip
import pandas as pd


def session(root="/data"):
    return sqlite3.connect(f"file:{Path(root) / 'session.sqlite'}?mode=ro", uri=True)


def query(sql, params=(), root="/data"):
    """Query every eligible game shard. SQL aggregates are per game."""
    frames = []
    for file in sorted((Path(root) / "games").glob("*.sqlite.gz")):
        db = sqlite3.connect(":memory:")
        try:
            db.deserialize(gzip.decompress(file.read_bytes()))
            db.execute("PRAGMA query_only=ON")
            frames.append(pd.read_sql_query(sql, db, params=params))
        finally:
            db.close()
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def table(name, columns="*", root="/data"):
    """Read a history table across all eligible games into one DataFrame."""
    quoted = '"' + name.replace('"', '""') + '"'
    return query(f"SELECT {columns} FROM {quoted}", root=root)
