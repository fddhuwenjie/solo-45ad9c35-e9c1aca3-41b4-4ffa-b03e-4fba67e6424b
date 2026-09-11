# -*- coding: utf-8 -*-
"""SQLite 版本库：当前工作单 + 每次封存的不可变版本快照。"""

import json
import sqlite3
from datetime import datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS trips (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT UNIQUE NOT NULL,
    title       TEXT,
    document    TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id     INTEGER NOT NULL REFERENCES trips(id),
    kind        TEXT NOT NULL,          -- plan | revision | sealed
    note        TEXT,
    parent_version_id INTEGER,
    document    TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
"""


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def get_db(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def get_or_create_trip(conn, code, document=None, title=None):
    row = conn.execute("SELECT id FROM trips WHERE code = ?", (code,)).fetchone()
    if row:
        return row["id"]
    doc = document if document is not None else {"code": code, "phases": [],
                                                 "cases": []}
    conn.execute(
        "INSERT INTO trips(code, title, document, updated_at) VALUES(?,?,?,?)",
        (code, title or code, json.dumps(doc, ensure_ascii=False), _now()))
    conn.commit()
    return conn.execute("SELECT id FROM trips WHERE code = ?", (code,)).fetchone()["id"]


def load_document(conn, trip_id):
    row = conn.execute("SELECT * FROM trips WHERE id = ?", (trip_id,)).fetchone()
    return json.loads(row["document"])


def save_document(conn, trip_id, document):
    conn.execute("UPDATE trips SET document = ?, updated_at = ? WHERE id = ?",
                 (json.dumps(document, ensure_ascii=False), _now(), trip_id))
    conn.commit()


def list_versions(conn, trip_id):
    rows = conn.execute(
        "SELECT * FROM versions WHERE trip_id = ? ORDER BY id", (trip_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def add_version(conn, trip_id, document, kind, note="", parent_version_id=None):
    cur = conn.execute(
        "INSERT INTO versions(trip_id, kind, note, parent_version_id, "
        "document, created_at) VALUES(?,?,?,?,?,?)",
        (trip_id, kind, note, parent_version_id,
         json.dumps(document, ensure_ascii=False), _now()))
    conn.commit()
    return cur.lastrowid


def get_version(conn, version_id):
    row = conn.execute("SELECT * FROM versions WHERE id = ?",
                       (version_id,)).fetchone()
    return dict(row) if row else None
