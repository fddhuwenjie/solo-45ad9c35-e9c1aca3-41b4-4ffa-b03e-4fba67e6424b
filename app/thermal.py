# -*- coding: utf-8 -*-
"""藏品转运回温计算引擎（无第三方依赖）。

模型概述
========
* 每个运输箱视为一个集总热容节点，包装层提供串联热阻：
      tau = C_total * (R_1 + ... + R_n) * tau_multiplier      [小时]
  箱内温度按一阶响应逼近环境： dT/dt = (T_amb - T) / tau
* 拆外包装节点移除 role='outer'（或 removed_at='unpack'）的层；
  开箱节点移除 removed_at='open' 的内包装；removed_at='none' 的层保留。
* 水汽：密封期间箱内绝对湿度 x 不变；开箱后按
      dx/dt = k_open * (x_amb - x)
  若仍有包装层残留，k_open 折减为 1/4（微气候缓冲）。
* 露点采用 Magnus 公式；露点差 = 冷表面温度 - 露点温度，
  冷表面温度默认取箱内温度（最保守），可用 surface_factor 让其向环境侧提前。
* 变化率采用 60 分钟滚动平均（°C/h、%RH/h），避免拆层瞬间的伪尖峰。
"""

import math
from datetime import datetime, timedelta

DT_FMT = "%Y-%m-%dT%H:%M"

OUT_STEP_MIN = 5          # 输出曲线采样间隔
RATE_WINDOW_MIN = 60      # 变化率滚动窗口
MIN_TAU_H = 0.25          # 全部包装拆除后的最小热时间常数
HOLD_MIN = 30             # 判定"安全"所需的连续达标时长
DEFAULT_GAP_MIN = 30      # 记录仪断档阈值
DEFAULT_DEV_T = 2.0       # 实测偏离阈值 °C


# ---------------------------------------------------------------- 基础函数

def parse_dt(v):
    if isinstance(v, datetime):
        return v
    return datetime.strptime(v, DT_FMT)


def fmt_dt(dt):
    return dt.strftime(DT_FMT)


def esat_kpa(t):
    """饱和水汽压 kPa（Magnus/Tetens，-45~60°C 适用）。"""
    return 0.61078 * math.exp(17.27 * t / (t + 237.3))


def dewpoint(t, rh):
    """气温 t(°C)、相对湿度 rh(%) -> 露点 °C。"""
    rh = min(max(rh, 0.1), 100.0)
    g = math.log(rh / 100.0) + 17.27 * t / (t + 237.3)
    return 237.3 * g / (17.27 - g)


def x_from_rh(t, rh):
    """气温/相对湿度 -> 绝对湿度 kg/m³。"""
    pv = esat_kpa(t) * 1000.0 * rh / 100.0   # Pa
    return pv / (461.5 * (t + 273.15))


def rh_from_x(x, t):
    pv = x * 461.5 * (t + 273.15)            # Pa
    return max(0.0, min(100.0, pv / (esat_kpa(t) * 1000.0) * 100.0))


# ---------------------------------------------------------------- 环境带

def _sorted_phases(trip):
    phases = sorted(trip.get("phases", []),
                    key=lambda p: parse_dt(p["start"]))
    clean = []
    for p in phases:
        clean.append({
            "name": p.get("name", ""),
            "start": parse_dt(p["start"]),
            "end": parse_dt(p["end"]),
            "temp": float(p["temp"]),
            "rh": float(p["rh"]),
            "color": p.get("color", "#dce7f5"),
        })
    return clean


def ambient_at(phases, t):
    """分段定值，相邻阶段之间的空档线性过渡；区间外钳制。"""
    if t <= phases[0]["start"]:
        return phases[0]["temp"], phases[0]["rh"]
    if t >= phases[-1]["end"]:
        return phases[-1]["temp"], phases[-1]["rh"]
    for i, p in enumerate(phases):
        if p["start"] <= t < p["end"]:
            return p["temp"], p["rh"]
        if i + 1 < len(phases):
            q = phases[i + 1]
            if p["end"] <= t < q["start"]:
                f = (t - p["end"]).total_seconds() / max(
                    1, (q["start"] - p["end"]).total_seconds())
                return (p["temp"] + (q["temp"] - p["temp"]) * f,
                        p["rh"] + (q["rh"] - p["rh"]) * f)
    return phases[-1]["temp"], phases[-1]["rh"]


# ---------------------------------------------------------------- 单箱计算

def _node_map(case):
    out = {}
    for n in case.get("nodes", []):
        out[n["type"]] = parse_dt(n["time"])
    return out


def _active_layers(case, is_open, t, nodes):
    """当前分钟仍在发挥热阻作用的包装层。"""
    t_unpack = nodes.get("unpack")
    t_open = nodes.get("open")
    layers = []
    for ly in case.get("layers", []):
        removed_at = ly.get("removed_at")
        if removed_at is None:
            removed_at = "open" if ly.get("role") == "inner" else "unpack"
        if removed_at == "unpack" and t_unpack and t >= t_unpack:
            continue
        if removed_at == "open" and is_open and t_open and t >= t_open:
            continue
        layers.append(ly)
    return layers


def _simulate(case, phases, t_start, t_end,
              tau_mult_override=None, ambient_override=None):
    """逐分钟积分，返回分钟网格上的状态字典。"""
    amb = ambient_override or (lambda t: ambient_at(phases, t))
    nodes = _node_map(case)
    t_open = nodes.get("open")
    C = sum(float(ly.get("heat_capacity", 0.0))
            for ly in case.get("layers", [])) or 1.0
    tau_mult = float(tau_mult_override if tau_mult_override is not None
                     else case.get("tau_multiplier", 1.0))
    k_open = float(case.get("k_open", 1.5))
    sf = float(case.get("surface_factor", 0.0))

    M = int((t_end - t_start).total_seconds() // 60)
    T0, RH0 = amb(t_start)
    T = float(T0)
    x = x_from_rh(T0, RH0)

    minute = {
        "T": [0.0] * (M + 1), "x": [0.0] * (M + 1),
        "Ta": [0.0] * (M + 1), "RHa": [0.0] * (M + 1),
        "sealed": [True] * (M + 1), "t_start": t_start,
    }

    for m in range(M + 1):
        t = t_start + timedelta(minutes=m)
        Ta, RHa = amb(t)
        is_open = bool(t_open and t >= t_open)
        active = _active_layers(case, is_open, t, nodes)
        Rsum = sum(float(ly.get("r_value", 0.0)) for ly in active)
        tau = max(MIN_TAU_H, C * Rsum * tau_mult)
        k = 0.0 if (not is_open) else (k_open * 0.25 if active else k_open)

        minute["T"][m] = T
        minute["x"][m] = x
        minute["Ta"][m] = Ta
        minute["RHa"][m] = RHa
        minute["sealed"][m] = not is_open

        if m < M:
            dt_h = 1.0 / 60.0
            T += (Ta - T) / tau * dt_h
            if k > 0:
                xa = x_from_rh(Ta, RHa)
                x += k * (xa - x) * dt_h
    return minute


def calculate_case(case, phases, t_start, t_end,
                   tau_mult_override=None, ambient_override=None):
    """逐分钟积分，返回网格序列（每 OUT_STEP_MIN 分钟一点）。"""
    minute = _simulate(case, phases, t_start, t_end,
                       tau_mult_override, ambient_override)
    M = len(minute["T"]) - 1
    t_start = minute["t_start"]
    sf = float(case.get("surface_factor", 0.0))

    def rate(arr, m):
        j = max(0, m - RATE_WINDOW_MIN)
        h = (m - j) / 60.0
        if h <= 0:
            return 0.0
        return (arr[m] - arr[j]) / h

    series = []
    for m in range(0, M + 1, OUT_STEP_MIN):
        t = t_start + timedelta(minutes=m)
        Ta, RHa = minute["Ta"][m], minute["RHa"][m]
        Tin = minute["T"][m]
        RHi = rh_from_x(minute["x"][m], Tin)
        Td_amb = dewpoint(Ta, RHa)
        Td_in = dewpoint(Tin, RHi)
        Tsurf = Tin + sf * (Ta - Tin)
        sealed = minute["sealed"][m]
        margin = Tsurf - (Td_in if not sealed else Td_amb)
        series.append({
            "time": fmt_dt(t),
            "t_amb": round(Ta, 2),
            "rh_amb": round(RHa, 1),
            "td_amb": round(Td_amb, 2),
            "t_in": round(Tin, 2),
            "rh_in": round(RHi, 1),
            "td_in": round(Td_in, 2),
            "t_surface": round(Tsurf, 2),
            "margin": round(margin, 2),
            "sealed": sealed,
            "warm_rate": round(rate(minute["T"], m), 2),
            "rh_rate": round(_rh_rate(minute, m), 2),
        })
    return series


def _rh_rate(minute, m):
    j = max(0, m - RATE_WINDOW_MIN)
    h = (m - j) / 60.0
    if h <= 0:
        return 0.0
    rh_now = rh_from_x(minute["x"][m], minute["T"][m])
    rh_then = rh_from_x(minute["x"][j], minute["T"][j])
    return (rh_now - rh_then) / h


# ---------------------------------------------------------------- 记录仪

def attach_logger(series, rows, tol_min=OUT_STEP_MIN):
    """把实测点就近贴到输出网格；rows 已按单箱过滤并排序。"""
    if not rows:
        for p in series:
            p["t_meas"] = None
            p["rh_meas"] = None
        return
    idx = 0
    rows = sorted(rows, key=lambda r: r["dt"])
    for p in series:
        pt = parse_dt(p["time"])
        best, best_d = None, None
        while idx < len(rows) and rows[idx]["dt"] <= pt:
            best, best_d = rows[idx], (pt - rows[idx]["dt"]).total_seconds() / 60
            idx += 1
        if idx < len(rows):
            d2 = abs((rows[idx]["dt"] - pt).total_seconds() / 60)
            if best is None or d2 < best_d:
                best, best_d = rows[idx], d2
        if best is not None and best_d <= tol_min:
            p["t_meas"] = best["temp"]
            p["rh_meas"] = best["rh"]
        else:
            p["t_meas"] = None
            p["rh_meas"] = None


def logger_gaps(rows, threshold_min=DEFAULT_GAP_MIN):
    gaps = []
    rows = sorted(rows, key=lambda r: r["dt"])
    for a, b in zip(rows, rows[1:]):
        d = (b["dt"] - a["dt"]).total_seconds() / 60
        if d > threshold_min:
            gaps.append({"start": fmt_dt(a["dt"]), "end": fmt_dt(b["dt"]),
                         "minutes": int(d)})
    return gaps


# ---------------------------------------------------------------- 风险识别

def _episodes(flag_fn, series):
    eps, start = [], None
    for i, p in enumerate(series):
        if flag_fn(p):
            if start is None:
                start = i
        elif start is not None:
            eps.append((start, i - 1))
            start = None
    if start is not None:
        eps.append((start, len(series) - 1))
    return eps


def _first_safe_after(series, idx0, checks, hold_min=HOLD_MIN):
    """从 idx0 起，首个使其后 hold_min 内 checks 全部达标的网格下标。"""
    hold = hold_min // OUT_STEP_MIN
    n = len(series)
    for i in range(idx0, n):
        if not all(c(series[i]) for c in checks):
            continue
        # 从 i 起需连续 hold 个点达标；序列末端只要到末尾均达标也算
        j = i
        while j < n and all(c(series[j]) for c in checks):
            j += 1
        if j - i >= hold or j == n:
            return i
    return None


def analyze_case(case, series, gaps):
    limits = case.get("limits", {})
    dew_lim = float(limits.get("dew_margin", 2.0))
    warm_lim = float(limits.get("warm_rate", 2.0))
    rh_lim = float(limits.get("rh_rate", 5.0))
    min_rest = float(limits.get("min_rest_min", 240))

    risks = []
    nodes = _node_map(case)
    t_entry = nodes.get("entry")

    def after_entry(p, _t=t_entry):
        if _t is None:
            return True
        return parse_dt(p["time"]) >= _t

    # 结露 / 露点差不足（仅在藏品进场之后评估：室外装卸无结露防护意义）
    for hard, flag, kind, sev, msg in (
        (True, lambda p: after_entry(p) and p["margin"] < 0,
         "condensation", "danger",
         "冷表面温度已低于环境露点，存在结露"),
        (False, lambda p: after_entry(p) and 0 <= p["margin"] < dew_lim,
         "dewpoint_margin", "warn",
         f"露点差不足 {dew_lim:g}°C，临近结露"),
    ):
        for a, b in _episodes(flag, series):
            peak = min(series[k]["margin"] for k in range(a, b + 1))
            risks.append({"kind": kind, "severity": sev,
                          "start": series[a]["time"], "end": series[b]["time"],
                          "peak": round(peak, 2), "message": msg})

    # 升温过快
    for a, b in _episodes(
            lambda p: after_entry(p) and p["warm_rate"] > warm_lim, series):
        peak = max(series[k]["warm_rate"] for k in range(a, b + 1))
        risks.append({"kind": "warm_rate", "severity": "warn",
                      "start": series[a]["time"], "end": series[b]["time"],
                      "peak": round(peak, 2),
                      "message": f"升温率超过 {warm_lim:g}°C/h"})

    # 湿度变化过快（仅开箱后有意义）
    def rh_flag(p):
        return (not p["sealed"]) and abs(p["rh_rate"]) > rh_lim
    for a, b in _episodes(rh_flag, series):
        peak = max(abs(series[k]["rh_rate"]) for k in range(a, b + 1))
        risks.append({"kind": "rh_rate", "severity": "warn",
                      "start": series[a]["time"], "end": series[b]["time"],
                      "peak": round(peak, 2),
                      "message": f"相对湿度变化率超过 {rh_lim:g}%RH/h"})

    # 记录断档
    for g in gaps:
        risks.append({"kind": "logger_gap", "severity": "warn",
                      "start": g["start"], "end": g["end"],
                      "peak": g["minutes"],
                      "message": f"记录仪断档 {g['minutes']} 分钟"})

    # ---- 节点安全时刻：从节点向后找连续达标的最早时刻
    node_advice = {}
    idx_of = {p["time"]: i for i, p in enumerate(series)}

    def nearest_idx(t):
        target = (t - parse_dt(series[0]["time"])).total_seconds() / 60
        return max(0, min(len(series) - 1,
                          int(round(target / OUT_STEP_MIN))))

    dew_ok = lambda p: p["margin"] >= dew_lim
    warm_ok = lambda p: p["warm_rate"] <= warm_lim
    rh_ok = lambda p: abs(p["rh_rate"]) <= rh_lim

    for ntype, checks in (
        ("unpack", [dew_ok, warm_ok]),
        ("open", [dew_ok, warm_ok, rh_ok]),
    ):
        if ntype in nodes:
            i0 = nearest_idx(nodes[ntype])
            iok = _first_safe_after(series, i0, checks)
            advice = {"planned": fmt_dt(nodes[ntype])}
            if iok is not None:
                t_safe = parse_dt(series[iok]["time"])
                advice["safe_time"] = series[iok]["time"]
                advice["wait_minutes"] = int(
                    (t_safe - nodes[ntype]).total_seconds() / 60)
            else:
                advice["safe_time"] = None
                advice["wait_minutes"] = None
            node_advice[ntype] = advice

    # ---- 静置：进场 -> 拆外包装
    rest = None
    if "entry" in nodes:
        t_ref = nodes.get("rest", nodes["entry"])
        t_unpack = nodes.get("unpack")
        if t_unpack:
            rested = (t_unpack - t_ref).total_seconds() / 60
            rest = {"from": fmt_dt(t_ref), "to": fmt_dt(t_unpack),
                    "minutes": int(rested), "required": int(min_rest),
                    "enough": rested >= min_rest,
                    "short_minutes": int(max(0, min_rest - rested))}
            if rested < min_rest:
                risks.append({
                    "kind": "rest_insufficient", "severity": "warn",
                    "start": fmt_dt(t_unpack), "end": fmt_dt(t_unpack),
                    "peak": int(rested),
                    "message": f"静置仅 {int(rested)} 分钟，"
                               f"不足 {int(min_rest)} 分钟"})

    risks.sort(key=lambda r: r["start"])
    return {"risks": risks, "node_advice": node_advice, "rest": rest}


# ---------------------------------------------------------------- 实测偏离

def detect_deviation(series, rows, dev_t=DEFAULT_DEV_T):
    """实测箱温与估算曲线持续偏离 -> 返回首个偏离点。"""
    if not rows:
        return None
    run_start, run_n = None, 0
    need = 6  # 6 个实测点（约 30 分钟）持续偏离
    grid = [parse_dt(p["time"]) for p in series]
    t0 = grid[0]
    for r in sorted(rows, key=lambda r: r["dt"]):
        k = int(round((r["dt"] - t0).total_seconds() / 60
                      / OUT_STEP_MIN))
        if not (0 <= k < len(series)) or r["temp"] is None:
            continue
        p = series[k]
        if abs(r["temp"] - p["t_in"]) >= dev_t:
            if run_start is None:
                run_start = (r, p["t_in"])
            run_n += 1
            if run_n >= need:
                rr, est = run_start
                return {"time": fmt_dt(rr["dt"]),
                        "est_temp": est,
                        "meas_temp": rr["temp"],
                        "delta": round(rr["temp"] - est, 2)}
        else:
            run_start, run_n = None, 0
    return None


def fit_tau_multiplier(case, phases, t_start, t_end, rows):
    """黄金搜索 tau_multiplier，使实测段箱温误差最小（0.4~2.5）。"""
    rows = [r for r in rows if t_start <= r["dt"] <= t_end]
    if len(rows) < 4:
        return float(case.get("tau_multiplier", 1.0))

    def sse(mult):
        s = calculate_case(case, phases, t_start, t_end,
                           tau_mult_override=mult)
        total = 0.0
        for p in s:
            pt = parse_dt(p["time"])
            near = min(rows, key=lambda r: abs((r["dt"] - pt).total_seconds()))
            if abs((near["dt"] - pt).total_seconds()) <= OUT_STEP_MIN * 60:
                total += (p["t_in"] - near["temp"]) ** 2
        return total

    lo, hi = 0.4, 2.5
    gr = (math.sqrt(5) - 1) / 2
    c, d = hi - gr * (hi - lo), lo + gr * (hi - lo)
    while hi - lo > 0.02:
        if sse(c) < sse(d):
            hi = d
        else:
            lo = c
        c, d = hi - gr * (hi - lo), lo + gr * (hi - lo)
    return round((lo + hi) / 2, 3)


# ---------------------------------------------------------------- 总入口

def parse_logger_rows(raw):
    """规范化 CSV 解析结果：[{case_id,dt,temp,rh}]。"""
    rows = []
    for r in raw:
        try:
            cid = str(r.get("case_id", "")).strip()
            if not cid:
                continue
            rows.append({
                "case_id": cid,
                "dt": parse_dt(str(r["timestamp"]).strip()),
                "temp": float(r["temp"]),
                "rh": float(r["rh"]),
            })
        except (KeyError, ValueError, TypeError):
            continue
    return rows


def calculate(trip, raw_logger=None):
    phases = _sorted_phases(trip)
    if not phases:
        raise ValueError("至少需要一个路线阶段")
    t_start = phases[0]["start"]
    node_times = [parse_dt(n["time"]) for c in trip.get("cases", [])
                  for n in c.get("nodes", [])]
    t_end = phases[-1]["end"]
    if node_times:
        t_end = max(t_end, max(node_times) + timedelta(hours=4))

    logger = {}
    if raw_logger:
        for r in parse_logger_rows(raw_logger):
            logger.setdefault(r["case_id"], []).append(r)

    gap_threshold = int(trip.get("gap_threshold_min", DEFAULT_GAP_MIN))
    dev_t = float(trip.get("deviation_temp", DEFAULT_DEV_T))

    ambient_grid = []
    m_total = int((t_end - t_start).total_seconds() // 60)
    for m in range(0, m_total + 1, OUT_STEP_MIN):
        t = t_start + timedelta(minutes=m)
        Ta, RHa = ambient_at(phases, t)
        ambient_grid.append({"time": fmt_dt(t), "t_amb": round(Ta, 2),
                             "rh_amb": round(RHa, 1),
                             "td_amb": round(dewpoint(Ta, RHa), 2)})

    cases_out = {}
    earliest = None
    for case in trip.get("cases", []):
        cid = str(case.get("id"))
        series = calculate_case(case, phases, t_start, t_end)
        rows = logger.get(cid, [])
        attach_logger(series, rows)
        gaps = logger_gaps(rows, gap_threshold)
        ana = analyze_case(case, series, gaps)
        deviation = detect_deviation(series, rows, dev_t)
        mult = None
        if deviation:
            mult = fit_tau_multiplier(case, phases, t_start, t_end, rows)
        cases_out[cid] = {
            "id": cid,
            "name": case.get("name", cid),
            "series": series,
            "gaps": gaps,
            "risks": ana["risks"],
            "node_advice": ana["node_advice"],
            "rest": ana["rest"],
            "deviation": deviation,
            "fitted_tau_multiplier": mult,
            "nodes": {n["type"]: n["time"] for n in case.get("nodes", [])},
        }
        for r in ana["risks"]:
            if r["severity"] == "danger" and (
                    earliest is None or r["start"] < earliest["time"]):
                earliest = {"time": r["start"], "case_id": cid,
                            "case_name": case.get("name", cid),
                            "kind": r["kind"], "message": r["message"]}
    if earliest is None:
        # 没有硬风险时，退而提示最早的预警
        for cid, co in cases_out.items():
            for r in co["risks"]:
                if earliest is None or r["start"] < earliest["time"]:
                    earliest = {"time": r["start"], "case_id": cid,
                                "case_name": co["name"],
                                "kind": r["kind"], "message": r["message"]}

    return {
        "domain": {"start": fmt_dt(t_start), "end": fmt_dt(t_end)},
        "ambient": ambient_grid,
        "phases": [{k: (fmt_dt(v) if isinstance(v, datetime) else v)
                    for k, v in p.items()} for p in phases],
        "cases": cases_out,
        "earliest": earliest,
        "constants": {"OUT_STEP_MIN": OUT_STEP_MIN,
                      "RATE_WINDOW_MIN": RATE_WINDOW_MIN,
                      "MIN_TAU_H": MIN_TAU_H,
                      "dewpoint": "Magnus 17.27/237.3",
                      "Rv": 461.5},
    }
