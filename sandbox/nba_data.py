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
    descriptions = {}
    table_descriptions = {}
    for file in sorted((Path(root) / "games").glob("*.sqlite.gz")):
        db = sqlite3.connect(":memory:")
        try:
            db.deserialize(gzip.decompress(file.read_bytes()))
            db.execute("PRAGMA query_only=ON")
            frame = pd.read_sql_query(sql, db, params=params)
            if include_metadata and db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_history_metadata'").fetchone():
                for table_name, column_name, description, table_description in db.execute("SELECT table_name, column_name, description, table_description FROM _history_metadata"):
                    descriptions.setdefault(table_name, {"_row": "Internal SQLite row number."})[column_name] = description
                    if table_description:
                        table_descriptions[table_name] = table_description
            if not include_metadata:
                frame = frame.drop(columns=list(PROVENANCE_COLUMNS), errors="ignore")
            frames.append(frame)
        finally:
            db.close()
    if not frames:
        return pd.DataFrame()
    # Use a common object dtype before concatenation to avoid pandas 2.2's
    # deprecated all-NA dtype inference; explicitly infer the final value types.
    result = pd.concat([f.astype(object) for f in frames], ignore_index=True).infer_objects(copy=False)
    if include_metadata:
        result.attrs["column_descriptions"] = descriptions
        result.attrs["table_descriptions"] = table_descriptions
    return result


def table(name, columns="*", root="/data", include_metadata=False):
    """Read a history table across all eligible games into one DataFrame."""
    quoted = '"' + name.replace('"', '""') + '"'
    return query(f"SELECT {columns} FROM {quoted}", root=root, include_metadata=include_metadata)
