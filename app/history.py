"""Detection history in a local SQLite file (standard library only)."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

DB_PATH = Path(os.environ.get("OPEN_DETECTOR_DB", Path(__file__).resolve().parents[1] / "data" / "history.db"))


class HistoryStore:
    def __init__(self, path: Path = DB_PATH):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._conn() as c:
            c.execute(
                """CREATE TABLE IF NOT EXISTS analyses (
                    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, title TEXT NOT NULL,
                    source TEXT NOT NULL, words INTEGER NOT NULL, status TEXT NOT NULL,
                    overall_score REAL, verdict TEXT, text TEXT NOT NULL, result TEXT NOT NULL)"""
            )

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path)
        c.row_factory = sqlite3.Row
        return c

    def add(self, title: str, source: str, text: str, result: dict) -> str:
        aid = uuid.uuid4().hex[:12]
        with self._lock, self._conn() as c:
            c.execute(
                "INSERT INTO analyses VALUES (?,?,?,?,?,?,?,?,?,?)",
                (aid, datetime.now(timezone.utc).isoformat(timespec="seconds"), title, source,
                 result["words"], result["status"], result["overall_score"], result["verdict"],
                 text, json.dumps(result)),
            )
        return aid

    def list(self, limit: int = 100) -> List[dict]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT id, created_at, title, source, words, status, overall_score, verdict "
                "FROM analyses ORDER BY created_at DESC, rowid DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def get(self, aid: str) -> Optional[dict]:
        with self._conn() as c:
            r = c.execute("SELECT * FROM analyses WHERE id=?", (aid,)).fetchone()
        if not r:
            return None
        d = dict(r)
        d["result"] = json.loads(d["result"])
        return d

    def delete(self, aid: str) -> bool:
        with self._lock, self._conn() as c:
            return c.execute("DELETE FROM analyses WHERE id=?", (aid,)).rowcount > 0

    def clear(self) -> None:
        with self._lock, self._conn() as c:
            c.execute("DELETE FROM analyses")
