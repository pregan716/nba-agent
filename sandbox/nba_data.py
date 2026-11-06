"""Read only, cutoff-selected session and historical data.

query executes SQL once per game and concatenates results. For global aggregates,
use table(...).groupby(...), or aggregate the returned per-game counts/sums.
"""

from pathlib import Path
import sqlite3
import gzip
import pandas as pd
import json

PROVENANCE_COLUMNS = frozenset(json.loads(Path(__file__).with_name("provenance-columns.json").read_text()))


def session(root="/data"):
    return sqlite3.connect(f"file:{Path(root) / 'session.sqlite'}?mode=ro", uri=True)


def query(sql, params=(), root="/data", include_metadata=False):
    """Query every eligible game shard. SQL aggregates are per game."""
    frames = []
    for file in sorted((Path(root) / "games").glob("*.sqlite.gz")):
        db = sqlite3.connect(":memory:")
        try:
            db.deserialize(gzip.decompress(file.read_bytes()))
            db.execute("PRAGMA query_only=ON")
            frame = pd.read_sql_query(sql, db, params=params)
            if not include_metadata:
                frame = frame.drop(columns=list(PROVENANCE_COLUMNS), errors="ignore")
            frames.append(frame)
        finally:
            db.close()
    if not frames:
        return pd.DataFrame()
    # Use a common object dtype before concatenation to avoid pandas 2.2's
    # deprecated all-NA dtype inference; explicitly infer the final value types.
    return pd.concat([f.astype(object) for f in frames], ignore_index=True).infer_objects(copy=False)


def table(name, columns="*", root="/data", include_metadata=False):
    """Read a history table across all eligible games into one DataFrame."""
    quoted = '"' + name.replace('"', '""') + '"'
    return query(f"SELECT {columns} FROM {quoted}", root=root, include_metadata=include_metadata)
