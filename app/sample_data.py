# -*- coding: utf-8 -*-
"""示例：2026-01-15，三件藏品从 -22°C 严寒室外进入 21°C / 55%RH 暖湿展厅。

箱 C-01 计划安排合理（隔夜静置后清晨开箱），仅用于对照；
箱 C-02 实测回温明显偏快（车门漏风/泡沫老化），用于演示"从偏离点建修订"；
箱 C-03 记录仪中段断档，且拆外包装偏早，用于演示断档与结露风险。
"""

import csv
import io
import random
from datetime import timedelta

from . import thermal

D = "2026-01-15"


def trip_document():
    return {
        "code": "WX-2026-0115",
        "title": "冬季借展 WX-2026-0115（严寒室外 → 暖湿展厅）",
        "as_of": f"{D}T13:00",
        "gap_threshold_min": 30,
        "deviation_temp": 2.0,
        "phases": [
            {"name": "严寒室外装卸", "start": f"{D}T06:00",
             "end": f"{D}T07:00", "temp": -22, "rh": 85,
             "color": "#c7d9f0"},
            {"name": "冷藏车途中", "start": f"{D}T07:00",
             "end": f"{D}T12:00", "temp": -18, "rh": 50,
             "color": "#bfe0ef"},
            {"name": "室内卸货平台", "start": f"{D}T12:00",
             "end": f"{D}T13:00", "temp": 12, "rh": 40,
             "color": "#e3ead9"},
            {"name": "展厅静置/布展", "start": f"{D}T13:00",
             "end": "2026-01-16T06:00",
             "temp": 21, "rh": 55, "color": "#f3e7d3"},
        ],
        "cases": [
            {
                "id": "C-01",
                "name": "清代绢本设色立轴",
                "tau_multiplier": 1.0,
                "k_open": 0.5,
                "surface_factor": 0.0,
                "layers": [
                    {"name": "带铝箔木质运输箱", "role": "outer",
                     "r_value": 2.1, "heat_capacity": 1.4,
                     "removed_at": "unpack"},
                    {"name": "聚氨酯泡沫内衬 5cm（开箱后暂留）",
                     "role": "middle",
                     "r_value": 0.55, "heat_capacity": 0.4,
                     "removed_at": "none"},
                ],
                "limits": {"dew_margin": 2.0, "warm_rate": 2.0,
                           "rh_rate": 5.0, "min_rest_min": 240},
                "nodes": [
                    {"type": "entry", "time": f"{D}T12:40"},
                    {"type": "rest", "time": f"{D}T13:00"},
                    {"type": "unpack", "time": f"{D}T18:30"},
                    {"type": "open", "time": "2026-01-16T05:00"},
                ],
            },
            {
                "id": "C-02",
                "name": "铸铁佛造像（金属，热容大）",
                "tau_multiplier": 1.0,
                "k_open": 0.4,
                "surface_factor": 0.0,
                "layers": [
                    {"name": "胶合板运输箱", "role": "outer",
                     "r_value": 1.6, "heat_capacity": 2.4,
                     "removed_at": "unpack"},
                    {"name": "聚乙烯缓冲 3cm（开箱后暂留）",
                     "role": "middle",
                     "r_value": 0.35, "heat_capacity": 0.5,
                     "removed_at": "none"},
                ],
                "limits": {"dew_margin": 3.0, "warm_rate": 2.0,
                           "rh_rate": 5.0, "min_rest_min": 240},
                "nodes": [
                    {"type": "entry", "time": f"{D}T12:45"},
                    {"type": "rest", "time": f"{D}T13:00"},
                    {"type": "unpack", "time": f"{D}T18:30"},
                    {"type": "open", "time": "2026-01-16T05:30"},
                ],
            },
            {
                "id": "C-03",
                "name": "粉彩瓷瓶（对湿度敏感）",
                "tau_multiplier": 1.0,
                "k_open": 1.5,
                "surface_factor": 0.0,
                "layers": [
                    {"name": "铝制航空箱", "role": "outer",
                     "r_value": 0.8, "heat_capacity": 1.0,
                     "removed_at": "unpack"},
                    {"name": "气泡膜+无酸纸", "role": "inner",
                     "r_value": 0.25, "heat_capacity": 0.3,
                     "removed_at": "open"},
                ],
                "limits": {"dew_margin": 2.0, "warm_rate": 2.0,
                           "rh_rate": 5.0, "min_rest_min": 240},
                "nodes": [
                    {"type": "entry", "time": f"{D}T12:50"},
                    {"type": "rest", "time": f"{D}T13:00"},
                    {"type": "unpack", "time": f"{D}T14:30"},
                    {"type": "open", "time": f"{D}T19:00"},
                ],
            },
        ],
        "events": [],
    }


# ---------------------------------------------------------------- 记录仪

def _case_measured(case_id):
    """各箱"真实"行为相对计划模型的扰动参数。"""
    return {
        "C-01": {"tau_mult": 1.00, "noise": 0.25, "gap": None},
        # 车门密封条老化、泡沫受潮 -> 实际热阻约为模型的 65%，回温偏快
        "C-02": {"tau_mult": 0.62, "noise": 0.3, "gap": None},
        # 记录仪在 14:10–15:20 断电断档
        "C-03": {"tau_mult": 0.9, "noise": 0.3,
                 "gap": (f"{D}T14:10", f"{D}T15:20")},
    }[case_id]


def build_logger_rows():
    """用同一台引擎按"真实参数"模拟，再降采样为 5 分钟记录仪 CSV 行。"""
    from .thermal import parse_dt
    doc = trip_document()
    phases = thermal._sorted_phases(doc)
    t_start = phases[0]["start"]
    t_end = parse_dt(f"{D}T22:00")

    rows = []
    rng = random.Random(20260115)
    for case in doc["cases"]:
        cfg = _case_measured(case["id"])
        minute = thermal._simulate(case, phases, t_start, t_end,
                                   tau_mult_override=cfg["tau_mult"])
        gap = None
        if cfg["gap"]:
            gap = (parse_dt(cfg["gap"][0]), parse_dt(cfg["gap"][1]))
        M = len(minute["T"]) - 1
        for m in range(0, M + 1, 5):
            t = t_start + timedelta(minutes=m)
            if gap and gap[0] <= t < gap[1]:
                continue
            Tin = minute["T"][m] + rng.uniform(-cfg["noise"], cfg["noise"])
            RHi = thermal.rh_from_x(minute["x"][m], minute["T"][m]) \
                + rng.uniform(-1.0, 1.0)
            rows.append([case["id"], t.strftime(thermal.DT_FMT),
                         round(Tin, 1), round(max(5, min(99, RHi)), 1)])
    return rows


def logger_csv_text():
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["case_id", "timestamp", "temp", "rh"])
    w.writerows(build_logger_rows())
    return buf.getvalue()
