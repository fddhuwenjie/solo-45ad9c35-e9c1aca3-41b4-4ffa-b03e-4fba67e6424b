# -*- coding: utf-8 -*-
"""Flask 入口：计算、版本封存、修订、操作单与参数导出。"""

import csv
import io
import json
import os
from datetime import timedelta

from flask import (Flask, Response, jsonify, render_template, request,
                   send_from_directory)

from . import sample_data, storage, thermal

SAMPLE_CODE = "WX-2026-0115"


def create_app(db_path=None):
    app = Flask(__name__, instance_relative_config=False)
    if db_path is None:
        db_path = os.environ.get("ACCLIM_DB", os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "data", "acclimation.sqlite3"))
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    app.config["DB_PATH"] = db_path

    def conn():
        return storage.get_db(app.config["DB_PATH"])

    def trip_id_or_404(c, code):
        row = c.execute("SELECT id FROM trips WHERE code = ?", (code,)).fetchone()
        if not row:
            return None
        return row["id"]

    # ------------------------------------------------------------ 页面
    @app.route("/")
    def index():
        return render_template("index.html", sample_code=SAMPLE_CODE)

    @app.route("/sheet/<code>")
    def sheet(code):
        c = conn()
        tid = trip_id_or_404(c, code)
        if tid is None:
            return "行程不存在", 404
        doc = storage.load_document(c, tid)
        result = thermal.calculate(doc, doc.get("logger_rows"))
        ctx = _sheet_context(doc, result)
        vid = request.args.get("v", type=int)
        if vid:
            v = storage.get_version(c, vid)
            if v and v["trip_id"] == tid:
                vdoc = json.loads(v["document"])
                vres = thermal.calculate(vdoc, vdoc.get("logger_rows"))
                ctx = _sheet_context(vdoc, vres)
                ctx["version"] = v
        return render_template("sheet.html", **ctx)

    def _sheet_context(doc, result):
        rows = []
        for case in doc.get("cases", []):
            cid = case["id"]
            co = result["cases"].get(cid, {})
            advice = co.get("node_advice", {})
            nodes = {n["type"]: n["time"] for n in case.get("nodes", [])}

            def plan_or_safe(t):
                # 已封存的实际事件优先；否则用建议安全时刻；再否则用原计划
                ev = next((e for e in doc.get("events", [])
                           if e["case_id"] == cid and e["type"] == t), None)
                if ev:
                    return ev["time"], "已执行"
                adv = advice.get(t)
                if adv and adv.get("wait_minutes"):
                    return adv["safe_time"], f"需等待 {adv['wait_minutes']} 分"
                return nodes.get(t, ""), "按计划"

            unpack_t, unpack_note = plan_or_safe("unpack")
            open_t, open_note = plan_or_safe("open")
            rows.append({
                "id": cid, "name": case.get("name", cid),
                "entry": nodes.get("entry", ""),
                "rest": nodes.get("rest", ""),
                "unpack": unpack_t, "unpack_note": unpack_note,
                "open": open_t, "open_note": open_note,
                "risks": co.get("risks", []),
                "rest_info": co.get("rest"),
            })
        return {"doc": doc, "result": result, "rows": rows}

    # ------------------------------------------------------------ API
    @app.post("/api/sample/load")
    def load_sample():
        c = conn()
        doc = sample_data.trip_document()
        tid = storage.get_or_create_trip(c, doc["code"], doc, doc["title"])
        # 载入即重置样例，保证演示可复现
        storage.save_document(c, tid, doc)
        versions = storage.list_versions(c, tid)
        return jsonify({"trip_code": doc["code"], "trip_id": tid,
                        "document": doc,
                        "versions": [_version_brief(v) for v in versions]})

    @app.get("/api/trip/<code>")
    def get_trip(code):
        c = conn()
        tid = trip_id_or_404(c, code)
        if tid is None:
            return jsonify({"error": "trip not found"}), 404
        doc = storage.load_document(c, tid)
        versions = storage.list_versions(c, tid)
        return jsonify({"trip_code": code, "trip_id": tid, "document": doc,
                        "versions": [_version_brief(v) for v in versions]})

    @app.put("/api/trip/<code>/document")
    def put_document(code):
        payload = request.get_json(force=True)
        c = conn()
        tid = trip_id_or_404(c, code)
        if tid is None:
            title = payload.get("title", code)
            tid = storage.get_or_create_trip(c, code, payload, title)
        else:
            storage.save_document(c, tid, payload)
        return jsonify({"ok": True, "trip_id": tid})

    @app.post("/api/calculate")
    def api_calculate():
        payload = request.get_json(force=True)
        doc = payload.get("document")
        if not isinstance(doc, dict):
            return jsonify({"error": "document 必填"}), 400
        try:
            return jsonify(thermal.calculate(doc, doc.get("logger_rows")))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

    @app.post("/api/trip/<code>/versions")
    def save_version(code):
        payload = request.get_json(force=True)
        kind = payload.get("kind", "plan")
        note = payload.get("note", "")
        c = conn()
        tid = trip_id_or_404(c, code)
        if tid is None:
            return jsonify({"error": "trip not found"}), 404
        doc = storage.load_document(c, tid)
        versions = storage.list_versions(c, tid)
        parent = versions[-1]["id"] if versions else None
        vid = storage.add_version(c, tid, doc, kind, note, parent)
        return jsonify({"version_id": vid,
                        "versions": [_version_brief(v)
                                     for v in storage.list_versions(c, tid)]})

    @app.get("/api/trip/<code>/versions")
    def list_versions(code):
        c = conn()
        tid = trip_id_or_404(c, code)
        if tid is None:
            return jsonify({"error": "trip not found"}), 404
        return jsonify({"versions": [_version_brief(v)
                                     for v in storage.list_versions(c, tid)]})

    @app.get("/api/version/<int:vid>")
    def get_version(vid):
        c = conn()
        v = storage.get_version(c, vid)
        if not v:
            return jsonify({"error": "not found"}), 404
        v["document"] = json.loads(v["document"])
        return jsonify(v)

    @app.post("/api/trip/<code>/events")
    def seal_event(code):
        """封存一个已发生的现场事件（不可再由拖移修改）。"""
        payload = request.get_json(force=True)
        c = conn()
        tid = trip_id_or_404(c, code)
        if tid is None:
            return jsonify({"error": "trip not found"}), 404
        doc = storage.load_document(c, tid)
        events = doc.setdefault("events", [])
        ev = {"case_id": str(payload["case_id"]),
              "type": payload["type"],
              "time": payload["time"]}
        # 同箱同类型事件只保留一次
        events[:] = [e for e in events
                     if not (e["case_id"] == ev["case_id"]
                             and e["type"] == ev["type"])]
        events.append(ev)
        storage.save_document(c, tid, doc)
        vid = storage.add_version(c, tid, doc, "sealed",
                                  f"封存事件：{ev['case_id']} "
                                  f"{_node_label(ev['type'])} {ev['time']}")
        return jsonify({"ok": True, "events": events, "version_id": vid,
                        "versions": [_version_brief(v)
                                     for v in storage.list_versions(c, tid)]})

    @app.post("/api/trip/<code>/revision")
    def make_revision(code):
        """从实测偏离点另建修订：锁定偏离点之前的历史，按拟合参数生成
        未来节点安排；版本库为空时先封存原计划不可变快照，再存子修订。"""
        import copy
        payload = request.get_json(force=True)
        c = conn()
        tid = trip_id_or_404(c, code)
        if tid is None:
            return jsonify({"error": "trip not found"}), 404
        doc = storage.load_document(c, tid)
        cid = str(payload.get("case_id", ""))
        case = next((x for x in doc.get("cases", [])
                     if str(x["id"]) == cid), None)
        if not case:
            return jsonify({"error": "case not found"}), 404

        result = thermal.calculate(doc, doc.get("logger_rows"))
        co = result["cases"].get(cid)
        dev = co.get("deviation") if co else None
        if not dev:
            return jsonify({"error": "该箱未检测到持续偏离"}), 400
        t_dev = thermal.parse_dt(dev["time"])
        fitted = co.get("fitted_tau_multiplier")

        phases = thermal._sorted_phases(doc)
        t_start = phases[0]["start"]
        t_end = thermal.parse_dt(result["domain"]["end"])

        existing = storage.list_versions(c, tid)

        # 1) 版本库为空：先封存偏离前的原计划（保持原 tau，不改历史）
        if not existing:
            plan_note = (f"原计划基线（{cid} 实测偏离前不可变快照）")
            plan_id = storage.add_version(
                c, tid, copy.deepcopy(doc), "plan", plan_note, None)
            parent_id = plan_id
        else:
            parent_id = existing[-1]["id"]

        # 2) 锁定历史节点：偏离点及之前，或已实际发生的进场/静置/封存事件；
        #    待执行的拆外包装/开箱若在偏离点之后则留待重排。
        locked_event_keys = {
            (e["case_id"], e["type"]) for e in doc.get("events", [])
        }
        for n in case.get("nodes", []):
            t_node = thermal.parse_dt(n["time"])
            historical = (t_node <= t_dev or n["type"] in ("entry", "rest")
                          or (cid, n["type"]) in locked_event_keys)
            if historical:
                n["locked"] = True
            else:
                n.pop("locked", None)

        # 3) 应用按实测拟合的热响应系数
        if fitted:
            case["tau_multiplier"] = fitted

        # 4) 以新模型重算待执行节点的安全时刻，生成并写入新安排
        advice = thermal.advise_nodes(case, phases, t_start, t_end)
        new_schedule = {}
        for ntype in ("unpack", "open"):
            adv = advice.get(ntype)
            node = next((n for n in case.get("nodes", [])
                         if n["type"] == ntype), None)
            if (node and adv and adv.get("safe_time")
                    and thermal.parse_dt(node["time"]) > t_dev
                    and not node.get("locked")
                    and node["time"] != adv["safe_time"]):
                old_time = node["time"]
                node["time"] = adv["safe_time"]
                new_schedule[ntype] = {"from": old_time,
                                       "to": adv["safe_time"]}

        labels = {"unpack": "拆外包装", "open": "开箱"}
        sched_txt = "，".join(
            f"{labels[k]} {v['from']}→{v['to']}"
            for k, v in new_schedule.items()) or "未来节点时刻不变"
        note = (f"{cid} 实测偏离修订：偏离点 {dev['time']}，"
                f"估算 {dev['est_temp']}°C / 实测 {dev['meas_temp']}°C；"
                f"热响应系数 {case.get('tau_multiplier')}；新安排 {sched_txt}")

        # 5) 子修订（父版本指向原计划基线或上一版本）
        rev_id = storage.add_version(
            c, tid, copy.deepcopy(doc), "revision", note, parent_id)
        storage.save_document(c, tid, doc)

        return jsonify({"ok": True, "deviation": dev, "note": note,
                        "fitted_tau_multiplier":
                            case.get("tau_multiplier"),
                        "new_schedule": new_schedule,
                        "plan_version_id": parent_id if not existing else None,
                        "version_id": rev_id,
                        "versions": [_version_brief(v)
                                     for v in storage.list_versions(c, tid)]})

    # ------------------------------------------------------------ 导入导出
    @app.post("/api/parse-csv")
    def parse_csv():
        if "file" in request.files:
            text = request.files["file"].read().decode("utf-8-sig")
        else:
            text = request.get_json(force=True).get("text", "")
        reader = csv.DictReader(io.StringIO(text))
        raw = [r for r in reader]
        try:
            rows = thermal.parse_logger_rows(raw)
        except Exception as e:  # noqa: BLE001
            return jsonify({"error": f"CSV 解析失败：{e}"}), 400
        by_case = {}
        for r in rows:
            by_case.setdefault(r["case_id"], 0)
            by_case[r["case_id"]] += 1
        return jsonify({"count": len(rows), "by_case": by_case,
                        "rows": [{"case_id": r["case_id"],
                                  "timestamp": thermal.fmt_dt(r["dt"]),
                                  "temp": r["temp"], "rh": r["rh"]}
                                 for r in rows]})

    @app.get("/api/sample/logger.csv")
    def sample_logger():
        return Response(sample_data.logger_csv_text(), mimetype="text/csv")

    @app.post("/api/params")
    def params_json():
        payload = request.get_json(force=True)
        doc = payload.get("document")
        if not isinstance(doc, dict):
            return jsonify({"error": "document 必填"}), 400
        result = thermal.calculate(doc, doc.get("logger_rows"))
        bundle = _params_bundle(doc, result)
        fname = f"params-{doc.get('code', 'trip')}.json"
        return Response(json.dumps(bundle, ensure_ascii=False, indent=2),
                        mimetype="application/json",
                        headers={"Content-Disposition":
                                 f"attachment; filename={fname}"})

    @app.get("/api/trip/<code>/params.json")
    def saved_params(code):
        c = conn()
        tid = trip_id_or_404(c, code)
        if tid is None:
            return jsonify({"error": "trip not found"}), 404
        doc = storage.load_document(c, tid)
        result = thermal.calculate(doc, doc.get("logger_rows"))
        bundle = _params_bundle(doc, result)
        return Response(json.dumps(bundle, ensure_ascii=False, indent=2),
                        mimetype="application/json")

    def _params_bundle(doc, result):
        return {
            "trip": {k: v for k, v in doc.items() if k != "logger_rows"},
            "logger_points": len(doc.get("logger_rows", [])),
            "model": result["constants"],
            "limits_in_effect": {
                c["id"]: c.get("limits", {}) for c in doc.get("cases", [])},
            "derived": {
                cid: {
                    "nodes": co["nodes"],
                    "node_advice": co["node_advice"],
                    "rest": co["rest"],
                    "deviation": co["deviation"],
                    "fitted_tau_multiplier": co["fitted_tau_multiplier"],
                    "risk_count": len(co["risks"]),
                } for cid, co in result["cases"].items()},
            "risk_text": _risk_text(doc, result),
        }

    return app


def _node_label(t):
    return {"entry": "进场", "rest": "静置",
            "unpack": "拆外包装", "open": "开箱"}.get(t, t)


def _version_brief(v):
    return {"id": v["id"], "kind": v["kind"], "note": v["note"],
            "parent_version_id": v["parent_version_id"],
            "created_at": v["created_at"]}


def _risk_text(doc, result):
    lines = []
    for cid, co in result["cases"].items():
        for r in co["risks"]:
            lines.append(f"[{cid}] {r['start']} {r['message']}")
    return lines
