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
CREATE TABLE IF NOT EXISTS calibration_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id     INTEGER NOT NULL REFERENCES trips(id),
    case_id     TEXT NOT NULL,
    mapping     TEXT NOT NULL,          -- 锚点/偏移映射 JSON（不含原始记录）
    note        TEXT,
    status      TEXT NOT NULL,          -- confirmed | reverted
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


# ---------------------------------------------------------------- 校准映射版本

def add_calibration(conn, trip_id, case_id, mapping, note=""):
    """确认一版校准映射；同一 (trip, case) 旧版本自动置为 reverted。"""
    conn.execute(
        "UPDATE calibration_versions SET status = 'reverted' "
        "WHERE trip_id = ? AND case_id = ? AND status = 'confirmed'",
        (trip_id, case_id))
    cur = conn.execute(
        "INSERT INTO calibration_versions"
        "(trip_id, case_id, mapping, note, status, created_at) "
        "VALUES(?,?,?,?,?,?)",
        (trip_id, case_id, json.dumps(mapping, ensure_ascii=False),
         note, "confirmed", _now()))
    conn.commit()
    return cur.lastrowid


def list_calibrations(conn, trip_id, case_id=None):
    sql = ("SELECT * FROM calibration_versions WHERE trip_id = ?")
    args = [trip_id]
    if case_id is not None:
        sql += " AND case_id = ?"
        args.append(case_id)
    sql += " ORDER BY id"
    rows = conn.execute(sql, args).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["mapping"] = json.loads(d["mapping"])
        out.append(d)
    return out


def confirmed_calibration(conn, trip_id, case_id):
    """当前生效（confirmed）的校准映射；无则 None。"""
    row = conn.execute(
        "SELECT * FROM calibration_versions WHERE trip_id = ? "
        "AND case_id = ? AND status = 'confirmed' ORDER BY id DESC LIMIT 1",
        (trip_id, case_id)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["mapping"] = json.loads(d["mapping"])
    return d


def delete_calibrations(conn, trip_id):
    """清空某行程的全部校准版本（示例行程重置时调用）。"""
    conn.execute("DELETE FROM calibration_versions WHERE trip_id = ?",
                 (trip_id,))
    conn.commit()


def revert_calibration(conn, trip_id, case_id):
    """撤销当前生效映射：置为 reverted，并把上一版恢复为 confirmed。

    返回 (被撤销的版本, 恢复的版本或 None)。
    """
    cur = confirmed_calibration(conn, trip_id, case_id)
    if not cur:
        return None, None
    conn.execute(
        "UPDATE calibration_versions SET status = 'reverted' WHERE id = ?",
        (cur["id"],))
    prev = conn.execute(
        "SELECT * FROM calibration_versions WHERE trip_id = ? "
        "AND case_id = ? AND status = 'reverted' AND id < ? "
        "ORDER BY id DESC LIMIT 1",
        (trip_id, case_id, cur["id"])).fetchone()
    restored = None
    if prev:
        conn.execute(
            "UPDATE calibration_versions SET status = 'confirmed' "
            "WHERE id = ?", (prev["id"],))
        restored = dict(prev)
        restored["mapping"] = json.loads(restored["mapping"])
    conn.commit()
    return cur, restored
