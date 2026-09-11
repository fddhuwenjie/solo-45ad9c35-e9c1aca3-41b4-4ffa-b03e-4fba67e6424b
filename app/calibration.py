# -*- coding: utf-8 -*-
"""记录仪时间校准：时区/固定偏移 + 锚点分段线性漂移映射（无第三方依赖）。

映射模型
========
    校准时间 = 原始时间 + 时区偏移 + 固定偏移 + 漂移(原始时间)

* base = tz_offset_min + fixed_offset_min，对全部采样点整体平移；
* 漂移由锚点（raw_time → true_time）分段线性插值得到，锚点漂移量
  drift_i = (true_i − raw_i) − base；
* 0 个锚点：仅 base 平移；1 个锚点：在 base 上再整体平移 drift_0；
  ≥2 个锚点：相邻锚点间线性插值，**超出锚点范围不外推**（视为冲突）。

阻止规则（confirm 前必须通过 validate）
======================================
* duplicate_anchor  同一采样点被两个锚点重复占用；
* anchor_order      锚点顺序矛盾：按原始时间排序后真值时间必须严格递增；
* extrapolation     采样点超出锚点覆盖范围，需要外推；
* non_monotonic     校准后时间倒序（含停滞）。
"""

from datetime import timedelta

from .thermal import fmt_dt, parse_dt

# 阻止确认的冲突规则（其余为提示）
BLOCKING_RULES = ("duplicate_anchor", "anchor_order",
                  "extrapolation", "non_monotonic")


def normalize(mapping):
    """规范化映射载荷：数值化偏移、解析锚点时间并按原始时间排序。"""
    mapping = mapping or {}
    m = {
        "tz_offset_min": _num(mapping.get("tz_offset_min")),
        "fixed_offset_min": _num(mapping.get("fixed_offset_min")),
        "anchors": [],
    }
    m["base"] = m["tz_offset_min"] + m["fixed_offset_min"]
    for a in mapping.get("anchors", []):
        if not a.get("raw_time") or not a.get("true_time"):
            continue  # 缺任一端时间的锚点不参与映射
        try:
            raw = parse_dt(str(a["raw_time"]).strip())
            true = parse_dt(str(a["true_time"]).strip())
        except (ValueError, TypeError):
            continue
        m["anchors"].append({
            "id": str(a.get("id") or ""),
            "label": str(a.get("label") or ""),
            "kind": str(a.get("kind") or "manual"),
            "raw": raw,
            "true": true,
        })
    m["anchors"].sort(key=lambda a: a["raw"])
    return m


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _drifts(m):
    """各锚点的漂移量（分钟）：真值 − 原始 − base。"""
    return [(a["true"] - a["raw"]).total_seconds() / 60.0 - m["base"]
            for a in m["anchors"]]


def drift_at(m, raw_dt):
    """raw_dt 处的分段线性漂移（分钟）；超出锚点范围返回 None。"""
    anchors = m["anchors"]
    if not anchors:
        return 0.0
    ds = _drifts(m)
    if len(anchors) == 1:
        return ds[0]
    if raw_dt < anchors[0]["raw"] or raw_dt > anchors[-1]["raw"]:
        return None  # 不外推
    for i in range(len(anchors) - 1):
        a, b = anchors[i], anchors[i + 1]
        if a["raw"] <= raw_dt <= b["raw"]:
            span = (b["raw"] - a["raw"]).total_seconds() / 60.0
            if span <= 0:
                return ds[i]
            f = (raw_dt - a["raw"]).total_seconds() / 60.0 / span
            return ds[i] + (ds[i + 1] - ds[i]) * f
    return ds[-1]


def calibrate_dt(m, raw_dt):
    """映射单个时刻；超出锚点范围（需外推）返回 None。"""
    d = drift_at(m, raw_dt)
    if d is None:
        return None
    return raw_dt + timedelta(minutes=m["base"] + d)


# ---------------------------------------------------------------- 校验

def validate(m, raw_dts):
    """返回冲突列表 [{rule, message}]；空列表表示可以确认。"""
    conflicts = []
    anchors = m["anchors"]

    # 同一采样点重复占用
    seen = {}
    for a in anchors:
        key = fmt_dt(a["raw"])
        name = a["label"] or key
        if key in seen:
            conflicts.append({
                "rule": "duplicate_anchor",
                "message": f"锚点「{name}」与「{seen[key]}」重复占用"
                           f"同一采样点 {key}"})
        else:
            seen[key] = name

    # 锚点顺序矛盾：原始时间递增时真值时间必须严格递增
    for prev, cur in zip(anchors, anchors[1:]):
        if cur["true"] <= prev["true"]:
            conflicts.append({
                "rule": "anchor_order",
                "message": f"锚点顺序矛盾：「{cur['label'] or fmt_dt(cur['raw'])}」"
                           f"的真值时间 {fmt_dt(cur['true'])} 不晚于前一锚点 "
                           f"{fmt_dt(prev['true'])}，映射将倒退"})

    # 超出锚点范围的外推
    out_range = 0
    if len(anchors) >= 2:
        lo, hi = anchors[0]["raw"], anchors[-1]["raw"]
        out_range = sum(1 for t in raw_dts if t < lo or t > hi)
        if out_range:
            conflicts.append({
                "rule": "extrapolation",
                "message": f"{out_range} 个采样点落在锚点范围 "
                           f"{fmt_dt(lo)} ~ {fmt_dt(hi)} 之外，"
                           f"校准需外推，须先补充覆盖首尾的手记事件或峰谷锚点"})

    # 校准后时间倒序（含停滞）；锚点本身已矛盾时不再级联报告
    if not any(c["rule"] in ("duplicate_anchor", "anchor_order")
               for c in conflicts):
        cals = []
        for t in sorted(raw_dts):
            c = calibrate_dt(m, t)
            if c is not None:
                cals.append(c)
        for a, b in zip(cals, cals[1:]):
            if b <= a:
                conflicts.append({
                    "rule": "non_monotonic",
                    "message": f"校准后时间倒序：{fmt_dt(a)} 之后出现 "
                               f"{fmt_dt(b)}，请检查锚点真值或偏移设置"})
                break
    return conflicts


def blocking(conflicts):
    """冲突中是否含阻止确认的规则。"""
    return [c for c in conflicts if c["rule"] in BLOCKING_RULES]


# ---------------------------------------------------------------- 残差与分段

def residuals(m):
    """逐锚点漂移量与留一残差（分钟）。

    残差 = 本锚点漂移 − 由其余锚点分段线性预测的漂移；
    锚点少于 3 个时无法留一预测，残差为 None。
    """
    anchors = m["anchors"]
    ds = _drifts(m)
    n = len(anchors)
    out = []
    for i, a in enumerate(anchors):
        res = None
        if n >= 3:
            others = [(anchors[j]["raw"], ds[j]) for j in range(n) if j != i]
            res = round(ds[i] - _interp_clamped(others, a["raw"]), 1)
        out.append({
            "id": a["id"], "label": a["label"], "kind": a["kind"],
            "raw": fmt_dt(a["raw"]), "true": fmt_dt(a["true"]),
            "drift_min": round(ds[i], 1), "residual_min": res,
        })
    return out


def _interp_clamped(points, x):
    """单自变量线性插值；范围外钳制到最近端点。"""
    points = sorted(points, key=lambda p: p[0])
    if x <= points[0][0]:
        return points[0][1]
    if x >= points[-1][0]:
        return points[-1][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x0 <= x <= x1:
            span = (x1 - x0).total_seconds()
            if span <= 0:
                return y0
            f = (x - x0).total_seconds() / span
            return y0 + (y1 - y0) * f
    return points[-1][1]


def segments(m):
    """分段线性映射的各段（用于界面展示与导出）。"""
    anchors = m["anchors"]
    ds = _drifts(m)
    segs = []
    for i in range(len(anchors) - 1):
        a, b = anchors[i], anchors[i + 1]
        span = (b["raw"] - a["raw"]).total_seconds() / 60.0
        segs.append({
            "raw_start": fmt_dt(a["raw"]), "raw_end": fmt_dt(b["raw"]),
            "drift_start": round(ds[i], 1), "drift_end": round(ds[i + 1], 1),
            "rate": round((ds[i + 1] - ds[i]) / span, 4) if span > 0 else None,
        })
    return segs


# ---------------------------------------------------------------- 应用

def apply_to_rows(rows, mapping_payload):
    """把映射应用到记录仪行（含 dt 字段的已解析行），返回新列表。

    原始行不被修改；落在锚点范围外的行被剔除（确认前 validate 已阻止
    该情形，此处为防御）。每行附带 raw_dt 以便界面并排显示原始时间。
    """
    m = normalize(mapping_payload)
    out = []
    for r in rows:
        c = calibrate_dt(m, r["dt"])
        if c is None:
            continue
        nr = dict(r)
        nr["raw_dt"] = r["dt"]
        nr["dt"] = c
        out.append(nr)
    return out


def extract_offsets(raw):
    """从 CSV 原始行提取逐箱时区/固定偏移列（不再丢弃）。

    识别列 tz_offset_min / fixed_offset_min（可空）；返回
    {case_id: {"tz_offset_min": x, "fixed_offset_min": y}}，
    仅保留至少一个非零偏移的箱号。
    """
    offsets = {}
    for r in raw:
        cid = str(r.get("case_id", "")).strip()
        if not cid or cid in offsets:
            continue
        tz = _num(r.get("tz_offset_min"))
        fx = _num(r.get("fixed_offset_min"))
        if tz or fx:
            offsets[cid] = {"tz_offset_min": tz, "fixed_offset_min": fx}
    return offsets


def covered_phases(phases, start_dt, end_dt):
    """与 [start_dt, end_dt] 相交的路线阶段（重算范围标注用）。"""
    if start_dt is None or end_dt is None:
        return []
    return [{"name": p["name"], "start": fmt_dt(p["start"]),
             "end": fmt_dt(p["end"])}
            for p in phases
            if p["start"] <= end_dt and p["end"] >= start_dt]
