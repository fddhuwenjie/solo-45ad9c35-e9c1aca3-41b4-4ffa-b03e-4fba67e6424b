/* 路线时间带与回温曲线：原生 SVG 渲染，无第三方库。 */

var Charts = (function () {
  var SVGNS = "http://www.w3.org/2000/svg";
  var COLORS = ["#c0392b", "#2f6db5", "#2e7d4f", "#7d3c98", "#b7791f"];
  var NODE_META = {
    entry: { label: "进场", shape: "square", color: "#455a64" },
    rest: { label: "静置", shape: "diamond", color: "#7d3c98" },
    unpack: { label: "拆外包装", shape: "hex", color: "#b7791f" },
    open: { label: "开箱", shape: "ring", color: "#c0392b" },
  };

  function el(name, attrs, parent) {
    var n = document.createElementNS(SVGNS, name);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    if (parent) parent.appendChild(n);
    return n;
  }

  function parse(t) { return new Date(t.replace(" ", "T")).getTime(); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function hm(t) { return pad(t.getHours()) + ":" + pad(t.getMinutes()); }
  function mdhm(t) { return (t.getMonth() + 1) + "/" + t.getDate() + " " + hm(t); }

  function fmtDuration(min) {
    if (min == null) return "—";
    var h = Math.floor(Math.abs(min) / 60), m = Math.abs(min) % 60;
    return (min < 0 ? "已超出 " : "还需等待 ") + h + " 小时 " + m + " 分";
  }

  var state = null;

  function render(container, result, doc, handlers) {
    var W = Math.max(560, container.clientWidth - 4);
    var ML = 54, MR = 18;
    var plotW = W - ML - MR;
    var t0 = parse(result.domain.start), t1 = parse(result.domain.end);
    function x(t) { return ML + (parse(t) - t0) / (t1 - t0) * plotW; }

    var caseIds = Object.keys(result.cases);
    var colorOf = {};
    caseIds.forEach(function (id, i) { colorOf[id] = COLORS[i % COLORS.length]; });

    container.innerHTML = "";
    state = { result: result, doc: doc, x: x, t0: t0, t1: t1,
              ML: ML, plotW: plotW, handlers: handlers,
              colorOf: colorOf, caseIds: caseIds };

    var strips = [
      drawTemp(container, W, ML, MR, plotW),
      drawMargin(container, W, ML, MR, plotW),
      drawWarm(container, W, ML, MR, plotW),
      drawRh(container, W, ML, MR, plotW),
    ];
    strips.forEach(function (s) { bindCrosshair(s); });
    drawNodeLane(container, W, ML, MR, plotW, caseIds, colorOf);
    drawAxis(container, W, ML, MR, plotW, t0, t1);
    drawLegend(document.getElementById("chart-legend"), caseIds,
               result, colorOf);
  }

  // ------------------------------------------------------------ 公共件
  function backdrop(svg, h, ML, plotW) {
    var phases = state.result.phases;
    phases.forEach(function (p) {
      el("rect", {
        x: state.x(p.start), y: 0,
        width: Math.max(1, state.x(p.end) - state.x(p.start)),
        height: h, fill: p.color || "#eef3f8",
      }, svg);
      var cx = (state.x(p.start) + state.x(p.end)) / 2;
      if (cx > ML + 4) {
        var t = el("text", {
          x: cx, y: 12, "text-anchor": "middle",
          "font-size": 10, fill: "#5a6b7a",
          text: p.name + " " + p.temp + "°C/" + p.rh + "%",
        }, svg);
      }
    });
    el("line", { x1: ML, x2: ML + plotW, y1: h - 0.5, y2: h - 0.5,
                 stroke: "#c8d2db", "stroke-width": 1 }, svg);
  }

  function yticks(svg, h, ML, yfn, lo, hi, unit) {
    var n = 4;
    for (var i = 0; i <= n; i++) {
      var v = lo + (hi - lo) * i / n;
      var yy = yfn(v);
      el("line", { x1: ML - 4, x2: ML, y1: yy, y2: yy,
                   stroke: "#9aa8b4" }, svg);
      el("text", { x: ML - 7, y: yy + 3, "text-anchor": "end",
                   "font-size": 10, fill: "#7a8894",
                   text: (Math.round(v * 10) / 10) + (unit || "") }, svg);
    }
  }

  function title(svg, text) {
    el("text", { x: 8, y: 14, "font-size": 11, "font-weight": 600,
                 fill: "#33485a", text: text }, svg);
  }

  function path(points) {
    return points.map(function (p, i) {
      return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1);
    }).join("");
  }

  function makeSvg(container, h, W) {
    var wrap = document.createElement("div");
    wrap.className = "strip";
    var svg = el("svg", { height: h, width: W });
    wrap.appendChild(svg);
    container.appendChild(wrap);
    return { wrap: wrap, svg: svg };
  }

  // ------------------------------------------------------------ 温度带
  function drawTemp(container, W, ML, MR, plotW) {
    var H = 168, r = state.result;
    var s = makeSvg(container, H, W);
    backdrop(s.svg, H, ML, plotW);
    title(s.svg, "温度（°C）：灰=环境，彩=箱内，虚点=记录仪实测");

    var vals = [];
    r.ambient.forEach(function (p) { vals.push(p.t_amb, p.td_amb); });
    state.caseIds.forEach(function (cid) {
      r.cases[cid].series.forEach(function (p) {
        vals.push(p.t_in);
        if (p.t_meas != null) vals.push(p.t_meas);
      });
    });
    var lo = Math.floor(Math.min.apply(null, vals) - 1);
    var hi = Math.ceil(Math.max.apply(null, vals) + 1);
    var y = function (v) { return H - 22 - (v - lo) / (hi - lo) * (H - 36); };
    yticks(s.svg, H, ML, y, lo, hi, "");

    // 环境温度与露点
    var ambPts = r.ambient.map(function (p) { return [state.x(p.time), y(p.t_amb)]; });
    var tdPts = r.ambient.map(function (p) { return [state.x(p.time), y(p.td_amb)]; });
    el("path", { d: path(ambPts), fill: "none", stroke: "#8a97a3",
                 "stroke-width": 1.6 }, s.svg);
    el("path", { d: path(tdPts), fill: "none", stroke: "#8a97a3",
                 "stroke-width": 1, "stroke-dasharray": "4 3" }, s.svg);

    state.caseIds.forEach(function (cid) {
      var col = state.colorOf[cid], co = r.cases[cid];
      var pts = co.series.map(function (p) { return [state.x(p.time), y(p.t_in)]; });
      el("path", { d: path(pts), fill: "none", stroke: col,
                   "stroke-width": 2 }, s.svg);
      var meas = co.series.filter(function (p) { return p.t_meas != null; })
        .map(function (p) { return [state.x(p.time), y(p.t_meas)]; });
      if (meas.length) {
        el("path", { d: path(meas), fill: "none", stroke: col,
                     "stroke-width": 1.4, "stroke-dasharray": "1 3",
                     "stroke-linecap": "round", opacity: 0.85 }, s.svg);
        meas.forEach(function (m) {
          el("circle", { cx: m[0], cy: m[1], r: 1.3, fill: col,
                         opacity: 0.55 }, s.svg);
        });
      }
    });
    s.wrap._strip = "temp";
    s.wrap._tooltip = function (pIdx) { return tempTooltip(pIdx, y); };
    return s.wrap;
  }

  function tempTooltip(pIdx) {
    var r = state.result, p = r.ambient[pIdx];
    if (!p) return "";
    var html = "<b>" + mdhm(new Date(parse(p.time))) + "</b><br>" +
      "环境 " + p.t_amb + "°C / " + p.rh_amb + "%RH，露点 " + p.td_amb + "°C";
    html += "<table>";
    state.caseIds.forEach(function (cid) {
      var q = r.cases[cid].series[pIdx];
      var m = q.t_meas != null ? " / 实测 " + q.t_meas + "°C" : "";
      html += "<tr><td style='color:" + state.colorOf[cid] +
        "'>●</td><td>" + cid + "</td><td>" + q.t_in + "°C" + m + "</td></tr>";
      // 校准后的实测点并排显示原始记录仪时间
      if (q.t_meas != null && q.meas_raw_time &&
          q.meas_raw_time !== q.time) {
        html += "<tr><td></td><td></td><td class='raw-note'>原始 " +
          q.meas_raw_time.replace("T", " ") + " → 校准 " +
          q.time.replace("T", " ") + "</td></tr>";
      }
    });
    return html + "</table>";
  }

  // ------------------------------------------------------------ 露点差带
  function drawMargin(container, W, ML, MR, plotW) {
    var H = 128, r = state.result;
    var s = makeSvg(container, H, W);
    backdrop(s.svg, H, ML, plotW);
    title(s.svg, "冷表面露点差（°C）：低于 0 即结露，低于材料限值为预警");

    var vals = [];
    state.caseIds.forEach(function (cid) {
      r.cases[cid].series.forEach(function (p) { vals.push(p.margin); });
    });
    var lo = Math.min(0, Math.floor(Math.min.apply(null, vals) - 1));
    var hi = Math.ceil(Math.max.apply(null, vals) + 1);
    var y = function (v) { return H - 20 - (v - lo) / (hi - lo) * (H - 30); };
    yticks(s.svg, H, ML, y, lo, hi, "");

    el("rect", { x: ML, width: plotW, y: y(0), height: H - 20 - y(0),
                 fill: "rgba(192,57,43,.08)" }, s.svg);
    el("line", { x1: ML, x2: ML + plotW, y1: y(0), y2: y(0),
                 stroke: "#c0392b", "stroke-width": 1.2 }, s.svg);

    state.caseIds.forEach(function (cid) {
      var col = state.colorOf[cid], co = r.cases[cid];
      var lim = findLimit(state.doc, cid, "dew_margin");
      var pts = co.series.map(function (p) {
        return [state.x(p.time), y(p.margin)];
      });
      el("path", { d: path(pts), fill: "none", stroke: col,
                   "stroke-width": 1.8 }, s.svg);
      el("line", { x1: ML, x2: ML + plotW, y1: y(lim), y2: y(lim),
                   stroke: col, "stroke-width": 0.8,
                   "stroke-dasharray": "5 4", opacity: 0.6 }, s.svg);
    });
    s.wrap._strip = "margin";
    s.wrap._tooltip = function (i) {
      var r = state.result, p = r.ambient[i];
      var html = "<b>" + mdhm(new Date(parse(p.time))) + "</b> 露点差";
      html += "<table>";
      state.caseIds.forEach(function (cid) {
        var q = r.cases[cid].series[i];
        html += "<tr><td style='color:" + state.colorOf[cid] + "'>●</td><td>" +
          cid + "</td><td>" + q.margin + "°C</td></tr>";
      });
      return html + "</table>";
    };
    return s.wrap;
  }

  function findLimit(doc, cid, key) {
    var c = (doc.cases || []).filter(function (k) {
      return String(k.id) === String(cid);
    })[0];
    return c && c.limits ? Number(c.limits[key]) : 2;
  }

  // ------------------------------------------------------------ 升温率带
  function drawWarm(container, W, ML, MR, plotW) {
    var H = 128, r = state.result;
    var s = makeSvg(container, H, W);
    backdrop(s.svg, H, ML, plotW);
    title(s.svg, "箱内升温率（°C/h，60 分钟滚动）");

    var vals = [0];
    state.caseIds.forEach(function (cid) {
      r.cases[cid].series.forEach(function (p) {
        vals.push(Math.abs(p.warm_rate));
      });
    });
    var hi = Math.ceil(Math.max.apply(null, vals) + 0.5);
    var y = function (v) { return H - 20 - v / hi * (H - 32); };
    yticks(s.svg, H, ML, y, 0, hi, "");

    state.caseIds.forEach(function (cid) {
      var col = state.colorOf[cid], co = r.cases[cid];
      var lim = findLimit(state.doc, cid, "warm_rate");
      var pts = co.series.map(function (p) {
        return [state.x(p.time), y(Math.max(0, p.warm_rate))];
      });
      el("path", { d: path(pts), fill: "none", stroke: col,
                   "stroke-width": 1.6 }, s.svg);
      el("line", { x1: ML, x2: ML + plotW, y1: y(lim), y2: y(lim),
                   stroke: col, "stroke-width": 0.8,
                   "stroke-dasharray": "5 4", opacity: 0.6 }, s.svg);
    });
    s.wrap._strip = "warm";
    s.wrap._tooltip = function (i) {
      return rateTooltip(i, "warm_rate", "升温率", "°C/h");
    };
    return s.wrap;
  }

  function drawRh(container, W, ML, MR, plotW) {
    var H = 128, r = state.result;
    var s = makeSvg(container, H, W);
    backdrop(s.svg, H, ML, plotW);
    title(s.svg, "相对湿度变化率（%RH/h，60 分钟滚动；开箱后）");

    var vals = [0];
    state.caseIds.forEach(function (cid) {
      r.cases[cid].series.forEach(function (p) {
        vals.push(Math.abs(p.rh_rate));
      });
    });
    var hi = Math.ceil(Math.max.apply(null, vals) + 0.5);
    var y = function (v) { return H - 20 - (v + hi) / (2 * hi) * (H - 30); };
    yticks(s.svg, H, ML, y, -hi, hi, "");
    el("line", { x1: ML, x2: ML + plotW, y1: y(0), y2: y(0),
                 stroke: "#9aa8b4" }, s.svg);

    state.caseIds.forEach(function (cid) {
      var col = state.colorOf[cid], co = r.cases[cid];
      var lim = findLimit(state.doc, cid, "rh_rate");
      var pts = co.series.map(function (p) {
        return [state.x(p.time), y(p.sealed ? 0 : p.rh_rate)];
      });
      el("path", { d: path(pts), fill: "none", stroke: col,
                   "stroke-width": 1.4, opacity: 0.9 }, s.svg);
      el("line", { x1: ML, x2: ML + plotW, y1: y(lim), y2: y(lim),
                   stroke: col, "stroke-width": 0.8,
                   "stroke-dasharray": "5 4", opacity: 0.55 }, s.svg);
    });
    s.wrap._strip = "rh";
    s.wrap._tooltip = function (i) {
      return rateTooltip(i, "rh_rate", "RH 变化率", "%RH/h");
    };
    return s.wrap;
  }

  function rateTooltip(i, key, name, unit) {
    var r = state.result, p = r.ambient[i];
    var html = "<b>" + mdhm(new Date(parse(p.time))) + "</b> " + name;
    html += "<table>";
    state.caseIds.forEach(function (cid) {
      var q = r.cases[cid].series[i];
      html += "<tr><td style='color:" + state.colorOf[cid] + "'>●</td><td>" +
        cid + "</td><td>" + q[key] + " " + unit + "</td></tr>";
    });
    return html + "</table>";
  }

  // ------------------------------------------------------------ 节点拖移带
  function drawNodeLane(container, W, ML, MR, plotW, caseIds, colorOf) {
    var rowH = 26, H = rowH * caseIds.length + 12;
    var s = makeSvg(container, H, W);
    backdrop(s.svg, H, ML, plotW);

    var events = {};
    (state.doc.events || []).forEach(function (e) {
      events[e.case_id + "|" + e.type] = e.time;
    });

    caseIds.forEach(function (cid, row) {
      var yBase = 10 + rowH * row + rowH / 2;
      el("text", { x: 6, y: yBase + 3.5, "font-size": 10,
                   fill: colorOf[cid], "font-weight": 600, text: cid }, s.svg);
      var caseObj = (state.doc.cases || []).filter(function (c) {
        return String(c.id) === String(cid);
      })[0];
      if (!caseObj) return;
      (caseObj.nodes || []).forEach(function (n) {
        var meta = NODE_META[n.type];
        if (!meta) return;
        var evKey = cid + "|" + n.type;
        var tStr = events[evKey] || n.time;
        var locked = !!events[evKey] || n.locked;
        var xx = Math.max(ML + 4, Math.min(ML + plotW - 4, state.x(tStr)));
        var g = el("g", { class: "node-marker" + (locked ? " locked" : ""),
                          transform: "translate(" + xx + "," + yBase + ")" },
                   s.svg);
        drawShape(g, meta.shape, meta.color, locked);
        el("text", { x: 0, y: -9, "text-anchor": "middle",
                     "font-size": 9.5, fill: "#33485a",
                     text: meta.label }, g);
        el("title", { text: cid + " " + meta.label + " " + tStr +
                      (locked ? "（已封存，不可移动）" : "（可拖移）") }, g);
        if (!locked) bindDrag(g, cid, n.type, s.svg, W, yBase);
      });
    });
  }

  function drawShape(g, shape, color, locked) {
    var d;
    if (shape === "square") {
      el("rect", { x: -5, y: -5, width: 10, height: 10, rx: 2,
                   fill: color }, g);
    } else if (shape === "diamond") {
      el("polygon", { points: "0,-6 6,0 0,6 -6,0", fill: color }, g);
    } else if (shape === "hex") {
      el("polygon", { points: "-6,-3.5 6,-3.5 9,0 6,3.5 -6,3.5 -9,0",
                      fill: color }, g);
    } else {
      el("circle", { r: 6, fill: "#fff", stroke: color,
                     "stroke-width": 2.4 }, g);
      el("circle", { r: 2.2, fill: color }, g);
    }
    if (locked) {
      el("text", { x: 7, y: 4, "font-size": 9, text: "🔒" }, g);
    }
  }

  function bindDrag(g, cid, ntype, svg, W, yBase) {
    var dragging = false;
    g.addEventListener("pointerdown", function (ev) {
      ev.preventDefault();
      dragging = true;
      g.setPointerCapture(ev.pointerId);
      document.body.style.cursor = "grabbing";
    });
    g.addEventListener("pointermove", function (ev) {
      if (!dragging) return;
      var rect = svg.getBoundingClientRect();
      var px = ev.clientX - rect.left;
      var tMs = state.t0 + (px - state.ML) / state.plotW *
                (state.t1 - state.t0);
      tMs = Math.max(state.t0, Math.min(state.t1, tMs));
      var d = new Date(tMs);
      d.setSeconds(0, 0);
      var m = d.getMinutes();
      d.setMinutes(m - m % 5);
      var tStr = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" +
        pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
      // 拖动中只更新数据与标记本身，避免整图重绘打断指针捕获
      state.handlers.onNodeDrag(cid, ntype, tStr);
      var xx = Math.max(state.ML + 4,
        Math.min(state.ML + state.plotW - 4, state.x(tStr)));
      g.setAttribute("transform",
        "translate(" + xx + "," + yBase + ")");
      var titleEl = g.querySelector("title");
      if (titleEl) titleEl.textContent =
        cid + " " + NODE_META[ntype].label + " " + tStr + "（可拖移）";
    });
    function end() {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      state.handlers.onNodeDragEnd();
    }
    g.addEventListener("pointerup", end);
    g.addEventListener("pointercancel", end);
  }

  // ------------------------------------------------------------ 时间轴
  function drawAxis(container, W, ML, MR, plotW, t0, t1) {
    var H = 24;
    var s = makeSvg(container, H, W);
    var spanH = (t1 - t0) / 3600000;
    var stepH = spanH > 20 ? 2 : spanH > 10 ? 1 : 0.5;
    for (var t = t0; t <= t1; t += stepH * 3600000) {
      var xx = ML + (t - t0) / (t1 - t0) * plotW;
      el("line", { x1: xx, x2: xx, y1: 2, y2: 7,
                   stroke: "#7a8894" }, s.svg);
      el("text", { x: xx, y: 19, "text-anchor": "middle",
                   "font-size": 10, fill: "#5a6b7a",
                   text: mdhm(new Date(t)) }, s.svg);
    }
  }

  // ------------------------------------------------------------ 十字线
  function bindCrosshair(wrap) {
    wrap.addEventListener("mousemove", function (ev) {
      var rect = wrap.getBoundingClientRect();
      var px = ev.clientX - rect.left;
      var tMs = state.t0 + (px - state.ML) / state.plotW * (state.t1 - state.t0);
      var i = Math.round((tMs - state.t0) / 300000);
      i = Math.max(0, Math.min(state.result.ambient.length - 1, i));
      showCross(i, ev.clientX, ev.clientY, wrap);
    });
    wrap.addEventListener("mouseleave", hideCross);
  }

  function showCross(i, cx, cy, srcWrap) {
    var xx = state.x(state.result.ambient[i].time);
    document.querySelectorAll(".strip svg").forEach(function (svg) {
      var old = svg.querySelector(".crosshair");
      if (old) old.remove();
      var g = el("g", { class: "crosshair" }, svg);
      el("line", { x1: xx, x2: xx, y1: 0, y2: svg.getBoundingClientRect().height,
                   stroke: "#9aa8b4" }, g);
    });
    var tip = document.getElementById("tooltip");
    tip.innerHTML = srcWrap._tooltip(i);
    tip.hidden = false;
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = Math.min(cx + 14, window.innerWidth - tw - 8);
    var top = Math.min(cy + 14, window.innerHeight - th - 8);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function hideCross() {
    document.getElementById("tooltip").hidden = true;
    document.querySelectorAll(".crosshair").forEach(function (g) {
      g.remove();
    });
  }

  function drawLegend(box, caseIds, result, colorOf) {
    if (!box) return;
    var calVers = result.calibration_versions || {};
    box.innerHTML =
      '<span class="lg"><span class="sw" style="background:#8a97a3"></span>环境温度</span>' +
      '<span class="lg"><span class="sw dash" style="color:#8a97a3"></span>环境露点</span>' +
      caseIds.map(function (cid) {
        var cal = calVers[cid]
          ? ' <span class="tag info">校准 v' + calVers[cid] + "</span>"
          : "";
        return '<span class="lg"><span class="sw" style="background:' +
          colorOf[cid] + '"></span>' + cid + " " +
          escapeHtml(result.cases[cid].name) + cal + "</span>";
      }).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  return { render: render, fmtDuration: fmtDuration, COLORS: COLORS };
})();
