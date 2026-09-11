/* 时间校准工作区：记录仪时区/固定偏移、手记事件与峰谷锚点、
 * 分段线性漂移映射的编辑、预览、确认与撤销。
 *
 * 拖动锚点期间在前端即时重算分段线性映射/残差/冲突（镜像
 * app/calibration.py 的规则），松开时再以服务端预览为准。
 * 只有"确认"后的映射由 app.js 送入 /api/calculate 参与重排。
 */

var Calib = (function () {
  var ctx = null;       // app.js 注入的上下文
  var root = null;
  var activeCase = null;
  var events = {};      // case_id -> [{label, time}] 手记事件（当地时间）
  var drafts = {};      // case_id -> 草稿映射 {tz_offset_min, fixed_offset_min, anchors[]}
  var lastPreview = null;
  var dragState = null;
  var anchorSeq = 1;

  var KIND_LABEL = { event: "手记", peak: "峰", valley: "谷",
                     manual: "手动", start: "起点", end: "终点" };

  // ------------------------------------------------------------ 挂载
  function mount(context) { ctx = context; }

  function render(el) {
    root = el;
    root.innerHTML = "";
    var doc = ctx.getDoc();
    if (!doc) { root.appendChild(msg("请先载入行程")); return; }
    var loggerCases = caseIdsWithLogger(doc);
    if (!loggerCases.length) {
      root.appendChild(msg("尚未导入记录仪 CSV。导入后可在此校准时钟。"));
      return;
    }
    if (!activeCase || loggerCases.indexOf(activeCase) < 0) {
      activeCase = loggerCases[0];
    }
    root.appendChild(caseSelector(loggerCases));
    root.appendChild(offsetBlock());
    root.appendChild(eventBlock());
    root.appendChild(peakBlock());
    root.appendChild(anchorChart());
    root.appendChild(anchorTable());
    root.appendChild(conflictBox());
    root.appendChild(pairBox());
    root.appendChild(actionBar());
    root.appendChild(versionList());
    refreshPreview(false);
  }

  function msg(text) {
    var d = document.createElement("div");
    d.className = "muted small";
    d.style.padding = "8px 0";
    d.textContent = text;
    return d;
  }

  function caseIdsWithLogger(doc) {
    var ids = [];
    (doc.logger_rows || []).forEach(function (r) {
      if (ids.indexOf(r.case_id) < 0) ids.push(r.case_id);
    });
    return ids;
  }

  // ------------------------------------------------------------ 草稿
  function draft(cid) {
    if (!drafts[cid]) {
      var confirmed = ctx.getCalibrations()[cid];
      if (confirmed) {
        drafts[cid] = JSON.parse(JSON.stringify(confirmed.mapping));
      } else {
        drafts[cid] = { tz_offset_min: 0, fixed_offset_min: 0, anchors: [] };
      }
    }
    return drafts[cid];
  }

  function prefillOffsets(offsets) {
    // CSV 带入的时区/固定偏移列：预填到对应箱的草稿
    Object.keys(offsets || {}).forEach(function (cid) {
      var d = draft(cid);
      d.tz_offset_min = offsets[cid].tz_offset_min || 0;
      d.fixed_offset_min = offsets[cid].fixed_offset_min || 0;
    });
  }

  // ------------------------------------------------------------ 选择器与偏移
  function caseSelector(ids) {
    var wrap = document.createElement("div");
    wrap.className = "field-row";
    var lab = document.createElement("label");
    lab.className = "fld";
    lab.appendChild(span("记录仪（箱号）"));
    var sel = document.createElement("select");
    sel.className = "f-in";
    ids.forEach(function (cid) {
      var op = document.createElement("option");
      op.value = cid;
      var confirmed = ctx.getCalibrations()[cid];
      op.textContent = cid + (confirmed ? "（已校准 v" +
        confirmed.version_id + "）" : "");
      if (cid === activeCase) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener("change", function () {
      activeCase = sel.value;
      render(root);
    });
    lab.appendChild(sel);
    wrap.appendChild(lab);
    return wrap;
  }

  function offsetBlock() {
    var d = draft(activeCase);
    var sec = document.createElement("div");
    sec.className = "editor-section";
    sec.appendChild(h4("时区与固定偏移"));
    var row = document.createElement("div");
    row.className = "field-row";
    row.appendChild(numFld("时区偏移（分）", d.tz_offset_min, function (v) {
      d.tz_offset_min = num(v); refreshPreview(true);
    }));
    row.appendChild(numFld("固定偏移（分）", d.fixed_offset_min, function (v) {
      d.fixed_offset_min = num(v); refreshPreview(true);
    }));
    sec.appendChild(row);
    var hint = document.createElement("div");
    hint.className = "muted small";
    hint.textContent = "基准偏移 = 时区 + 固定偏移，对全部采样点整体平移；" +
      "残余漂移由下方锚点分段线性修正。";
    sec.appendChild(hint);
    return sec;
  }

  // ------------------------------------------------------------ 手记事件
  function eventBlock() {
    var sec = document.createElement("div");
    sec.className = "editor-section";
    var head = h4("手记事件（开箱人员手记，当地时间）");
    var add = btn("+ 事件", function () {
      var list = events[activeCase] = events[activeCase] || [];
      list.push({ label: "到馆", time: defaultEventTime() });
      render(root);
    });
    head.appendChild(add);
    sec.appendChild(head);

    (events[activeCase] || []).forEach(function (ev, i) {
      var row = document.createElement("div");
      row.className = "field-row calib-event-row";
      var nameInp = document.createElement("input");
      nameInp.className = "f-in";
      nameInp.value = ev.label;
      nameInp.placeholder = "事件名（装车/到馆…）";
      nameInp.addEventListener("change", function () { ev.label = nameInp.value; });
      var timeInp = document.createElement("input");
      timeInp.className = "f-in";
      timeInp.type = "datetime-local";
      timeInp.value = ev.time;
      timeInp.addEventListener("change", function () {
        ev.time = timeInp.value;
      });
      var toAnchor = btn("→锚点", function () {
        var d = draft(activeCase);
        d.anchors.push({ id: "a" + (anchorSeq++), label: ev.label,
          kind: "event", raw_time: ev.time, true_time: ev.time });
        render(root);
      });
      toAnchor.title = "以手记时间为真值建锚点，再拖动对齐记录仪曲线";
      var del = btn("删", function () {
        events[activeCase].splice(i, 1); render(root);
      });
      row.appendChild(nameInp); row.appendChild(timeInp);
      row.appendChild(toAnchor); row.appendChild(del);
      sec.appendChild(row);
    });
    if (!(events[activeCase] || []).length) {
      sec.appendChild(msg("如“装车 06:05”“到馆 12:40”。添加后点 →锚点 建漂移锚点。"));
    }
    return sec;
  }

  function defaultEventTime() {
    var doc = ctx.getDoc();
    if (doc.phases && doc.phases.length) return doc.phases[0].start;
    return "2026-01-15T06:00";
  }

  // ------------------------------------------------------------ 峰谷候选
  function peakBlock() {
    var sec = document.createElement("div");
    sec.className = "editor-section";
    var head = h4("曲线峰谷（记录仪时钟下的候选锚点）");
    var load = btn("识别峰谷", function () {
      ctx.api("/api/trip/" + encodeURIComponent(ctx.getCode()) +
        "/calibration/peaks/" + encodeURIComponent(activeCase))
        .then(function (j) {
          sec.querySelectorAll(".calib-peaks").forEach(function (n) {
            n.remove();
          });
          sec.appendChild(peakList(j.extrema));
        }).catch(function (e) { alert(e.message); });
    });
    head.appendChild(load);
    sec.appendChild(head);
    return sec;
  }

  function peakList(extrema) {
    var box = document.createElement("div");
    box.className = "calib-peaks";
    extrema.forEach(function (ex) {
      var row = document.createElement("div");
      row.className = "calib-peak-row";
      var tag = document.createElement("span");
      tag.className = "tag " + (ex.kind === "peak" ? "warn" :
        ex.kind === "valley" ? "info" : "ok");
      tag.textContent = KIND_LABEL[ex.kind] || ex.kind;
      row.appendChild(tag);
      var tx = document.createElement("span");
      tx.className = "small";
      tx.textContent = ex.time.replace("T", " ") + " · " + ex.temp + "°C";
      row.appendChild(tx);
      var add = btn("→锚点", function () {
        var d = draft(activeCase);
        d.anchors.push({ id: "a" + (anchorSeq++),
          label: (KIND_LABEL[ex.kind] || "") + " " + ex.temp + "°C",
          kind: ex.kind, raw_time: ex.time, true_time: ex.time });
        render(root);
      });
      row.appendChild(add);
      box.appendChild(row);
    });
    if (!extrema.length) box.appendChild(msg("未找到明显峰谷"));
    return box;
  }

  // ------------------------------------------------------------ 锚点图（拖动）
  function anchorChart() {
    var sec = document.createElement("div");
    sec.className = "editor-section";
    sec.appendChild(h4("漂移映射（拖动锚点：上下=真值漂移，左右=原始时刻）"));
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "calib-chart");
    svg.setAttribute("height", "170");
    sec.appendChild(svg);
    requestAnimationFrame(function () { drawChart(svg); });
    return sec;
  }

  function loggerRange(cid) {
    var ts = (ctx.getDoc().logger_rows || []).filter(function (r) {
      return r.case_id === cid;
    }).map(function (r) { return parseT(r.timestamp || r.dt); });
    if (!ts.length) return null;
    return [Math.min.apply(null, ts), Math.max.apply(null, ts)];
  }

  function drawChart(svg) {
    var d = draft(activeCase);
    var range = loggerRange(activeCase);
    svg.innerHTML = "";
    if (!range) return;
    var W = svg.clientWidth || 380, H = 170, ML = 44, MR = 8, MT = 10, MB = 22;
    var plotW = W - ML - MR, plotH = H - MT - MB;
    var t0 = range[0], t1 = range[1];
    var base = num(d.tz_offset_min) + num(d.fixed_offset_min);
    var drifts = d.anchors.map(function (a) {
      return driftOf(a, base);
    });
    var lo = Math.min.apply(null, [0, base].concat(drifts)) - 10;
    var hi = Math.max.apply(null, [0, base].concat(drifts)) + 10;
    if (hi - lo < 20) { lo -= 10; hi += 10; }
    function X(t) { return ML + (t - t0) / Math.max(1, t1 - t0) * plotW; }
    function Y(v) { return MT + (hi - v) / (hi - lo) * plotH; }
    function invX(px) { return t0 + (px - ML) / plotW * (t1 - t0); }
    function invY(py) { return hi - (py - MT) / plotH * (hi - lo); }

    // 网格与零线
    [0, base].forEach(function (v, i) {
      svg.appendChild(svgEl("line", { x1: ML, x2: ML + plotW,
        y1: Y(v), y2: Y(v), stroke: i ? "#b7791f" : "#9aa8b4",
        "stroke-dasharray": i ? "5 4" : "3 3", "stroke-width": 1 }));
      svg.appendChild(svgEl("text", { x: 4, y: Y(v) + 3, "font-size": 9,
        fill: i ? "#b7791f" : "#7a8894",
        text: (i ? "基准" : "0") + " " + v.toFixed(0) + "′" }));
    });
    // 时间刻度
    for (var k = 0; k <= 4; k++) {
      var tk = t0 + (t1 - t0) * k / 4;
      svg.appendChild(svgEl("text", { x: X(tk), y: H - 6,
        "text-anchor": "middle", "font-size": 9, fill: "#7a8894",
        text: hm(new Date(tk)) }));
    }
    // 分段线性映射线
    var anchors = sortedAnchors(d);
    if (anchors.length >= 2) {
      var pts = anchors.map(function (a) {
        return [X(parseT(a.raw_time)), Y(driftOf(a, base))];
      });
      svg.appendChild(svgEl("path", {
        d: pts.map(function (p, i) {
          return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1);
        }).join(""),
        fill: "none", stroke: "#2f6db5", "stroke-width": 2 }));
      // 锚点覆盖范围外的区域淡红提示（不外推）
      var x0 = X(parseT(anchors[0].raw_time));
      var x1 = X(parseT(anchors[anchors.length - 1].raw_time));
      [[ML, x0], [x1, ML + plotW]].forEach(function (seg) {
        if (seg[1] - seg[0] > 1) {
          svg.appendChild(svgEl("rect", { x: seg[0], y: MT,
            width: seg[1] - seg[0], height: plotH,
            fill: "rgba(192,57,43,.07)" }));
        }
      });
    } else if (anchors.length === 1) {
      var v = driftOf(anchors[0], base);
      svg.appendChild(svgEl("line", { x1: ML, x2: ML + plotW,
        y1: Y(v), y2: Y(v), stroke: "#2f6db5", "stroke-width": 2 }));
    }
    // 锚点手柄
    anchors.forEach(function (a) {
      var g = svgEl("g", { "class": "calib-anchor", cursor: "grab" });
      var cx = X(parseT(a.raw_time)), cy = Y(driftOf(a, base));
      g.appendChild(svgEl("circle", { cx: cx, cy: cy, r: 6,
        fill: a.kind === "event" ? "#b7791f" : "#2f6db5",
        stroke: "#fff", "stroke-width": 1.5 }));
      g.appendChild(svgEl("text", { x: cx, y: cy - 10,
        "text-anchor": "middle", "font-size": 9, fill: "#33485a",
        text: a.label || a.kind }));
      bindAnchorDrag(g, a, svg, invX, invY, base);
      svg.appendChild(g);
    });
  }

  function bindAnchorDrag(g, anchor, svg, invX, invY, base) {
    g.addEventListener("pointerdown", function (ev) {
      ev.preventDefault();
      g.setPointerCapture(ev.pointerId);
      dragState = { anchor: anchor };
    });
    g.addEventListener("pointermove", function (ev) {
      if (!dragState || dragState.anchor !== anchor) return;
      var rect = svg.getBoundingClientRect();
      var rawMs = invX(ev.clientX - rect.left);
      var driftMin = invY(ev.clientY - rect.top);
      var rawDate = new Date(rawMs);
      rawDate.setSeconds(0, 0);
      anchor.raw_time = fmtLocal(rawDate);
      // 真值 = 原始 + 基准 + 漂移
      var trueMs = rawMs + (base + driftMin) * 60000;
      var trueDate = new Date(trueMs);
      trueDate.setSeconds(0, 0);
      anchor.true_time = fmtLocal(trueDate);
      // 拖动中：本地即时重算映射/残差/冲突
      liveUpdate(svg);
    });
    function up() {
      if (!dragState || dragState.anchor !== anchor) return;
      dragState = null;
      render(root);   // 重排锚点顺序并刷新服务端预览
    }
    g.addEventListener("pointerup", up);
    g.addEventListener("pointercancel", up);
  }

  // 拖动中的即时反馈：重画映射线 + 本地残差/冲突
  function liveUpdate(svg) {
    drawChart(svg);
    var d = draft(activeCase);
    var local = localValidate(d);
    renderConflicts(local);
    renderResiduals(localResiduals(d));
  }

  // ------------------------------------------------------------ 锚点表
  function anchorTable() {
    var sec = document.createElement("div");
    sec.className = "editor-section";
    var head = h4("锚点（原始记录仪时间 → 真值时间）");
    var add = btn("+ 手动锚点", function () {
      var range = loggerRange(activeCase);
      var t = range ? fmtLocal(new Date(range[0])) : defaultEventTime();
      draft(activeCase).anchors.push({ id: "a" + (anchorSeq++),
        label: "手动", kind: "manual", raw_time: t, true_time: t });
      render(root);
    });
    head.appendChild(add);
    sec.appendChild(head);

    var d = draft(activeCase);
    sortedAnchors(d).forEach(function (a) {
      var row = document.createElement("div");
      row.className = "calib-anchor-row";
      var tag = document.createElement("span");
      tag.className = "tag " + (a.kind === "event" ? "warn" : "info");
      tag.textContent = KIND_LABEL[a.kind] || a.kind;
      row.appendChild(tag);
      row.appendChild(dtInput(a.raw_time, function (v) {
        a.raw_time = v; refreshPreview(true);
      }));
      var arrow = document.createElement("span");
      arrow.textContent = "→";
      arrow.className = "muted";
      row.appendChild(arrow);
      row.appendChild(dtInput(a.true_time, function (v) {
        a.true_time = v; refreshPreview(true);
      }));
      var lab = document.createElement("input");
      lab.className = "f-in calib-label";
      lab.value = a.label || "";
      lab.placeholder = "标注";
      lab.addEventListener("change", function () { a.label = lab.value; });
      row.appendChild(lab);
      var del = btn("删", function () {
        d.anchors = d.anchors.filter(function (x) { return x.id !== a.id; });
        render(root);
      });
      row.appendChild(del);
      sec.appendChild(row);
    });
    if (!d.anchors.length) {
      sec.appendChild(msg("尚无锚点：从手记事件或峰谷添加，或手动新建。"));
    }
    // 残差容器（拖动时即时更新）
    var res = document.createElement("div");
    res.id = "calib-residuals";
    sec.appendChild(res);
    return sec;
  }

  // ------------------------------------------------------------ 冲突与并排
  function conflictBox() {
    var box = document.createElement("div");
    box.id = "calib-conflicts";
    return box;
  }

  function renderConflicts(conflicts) {
    var box = document.getElementById("calib-conflicts");
    if (!box) return;
    box.innerHTML = "";
    if (!conflicts.length) {
      var ok = document.createElement("div");
      ok.className = "calib-conflict ok";
      ok.textContent = "✓ 映射无冲突，可确认";
      box.appendChild(ok);
      return;
    }
    conflicts.forEach(function (c) {
      var d = document.createElement("div");
      d.className = "calib-conflict err";
      d.textContent = "⛔ " + c.message;
      box.appendChild(d);
    });
  }

  function renderResiduals(res) {
    var box = document.getElementById("calib-residuals");
    if (!box) return;
    box.innerHTML = "";
    if (!res.length) return;
    var t = document.createElement("table");
    t.className = "grid small";
    t.innerHTML = "<tr><th>锚点</th><th>漂移</th><th>留一残差</th></tr>";
    res.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + esc(r.label || r.kind) + "</td><td>" +
        fmtMin(r.drift_min) + "</td><td>" +
        (r.residual_min == null ? "—" : fmtMin(r.residual_min)) + "</td>";
      box.appendChild(t);
      t.appendChild(tr);
    });
    box.appendChild(t);
  }

  function pairBox() {
    var sec = document.createElement("div");
    sec.className = "editor-section";
    sec.appendChild(h4("原始 / 校准时间并排（抽样）"));
    var box = document.createElement("div");
    box.id = "calib-pairs";
    box.className = "calib-pairs";
    box.appendChild(msg("计算中…"));
    sec.appendChild(box);
    return sec;
  }

  function renderPairs(pairs) {
    var box = document.getElementById("calib-pairs");
    if (!box) return;
    box.innerHTML = "";
    var t = document.createElement("table");
    t.className = "grid small";
    t.innerHTML = "<tr><th>原始时间</th><th>校准时间</th></tr>";
    pairs.forEach(function (p) {
      var tr = document.createElement("tr");
      var td1 = document.createElement("td");
      td1.textContent = p.raw.replace("T", " ");
      var td2 = document.createElement("td");
      if (p.calibrated) {
        td2.textContent = p.calibrated.replace("T", " ");
      } else {
        td2.textContent = "超出锚点范围（不外推）";
        td2.className = "calib-out";
      }
      tr.appendChild(td1); tr.appendChild(td2);
      t.appendChild(tr);
    });
    box.appendChild(t);
  }

  // ------------------------------------------------------------ 操作与版本
  function actionBar() {
    var sec = document.createElement("div");
    sec.className = "editor-actions calib-actions";
    var confirmed = ctx.getCalibrations()[activeCase];
    var confirmBtn = document.createElement("button");
    confirmBtn.className = "btn btn-mini btn-primary";
    confirmBtn.id = "calib-confirm";
    confirmBtn.textContent = confirmed ? "确认为新版本" : "确认映射";
    confirmBtn.addEventListener("click", doConfirm);
    sec.appendChild(confirmBtn);
    if (confirmed) {
      var rev = document.createElement("button");
      rev.className = "btn btn-mini btn-warn";
      rev.textContent = "撤销映射";
      rev.addEventListener("click", doRevert);
      sec.appendChild(rev);
    }
    var note = document.createElement("span");
    note.className = "muted small";
    note.id = "calib-status";
    sec.appendChild(note);
    return sec;
  }

  function doConfirm() {
    var d = draft(activeCase);
    var local = localValidate(d);
    if (local.length) {
      renderConflicts(local);
      setStatus("存在冲突，无法确认", true);
      return;
    }
    ctx.api("/api/trip/" + encodeURIComponent(ctx.getCode()) +
      "/calibration/confirm", {
        method: "POST",
        body: JSON.stringify({ case_id: activeCase, mapping: d }),
      }).then(function (j) {
        setStatus("已确认 v" + j.version_id +
          "；仅重算该记录仪覆盖的阶段", false);
        ctx.onCalibrated(j.case_result, j.calibrations);
        render(root);
      }).catch(function (e) {
        setStatus(e.message, true);
        refreshPreview(false);
      });
  }

  function doRevert() {
    if (!confirm("撤销当前校准映射？曲线对齐与风险位置将恢复到上一版本。")) {
      return;
    }
    ctx.api("/api/trip/" + encodeURIComponent(ctx.getCode()) +
      "/calibration/revert", {
        method: "POST", body: JSON.stringify({ case_id: activeCase }),
      }).then(function (j) {
        setStatus(j.restored_version_id ?
          "已恢复到 v" + j.restored_version_id : "已撤销到校准前", false);
        delete drafts[activeCase];
        ctx.onCalibrated(j.case_result, j.calibrations);
        render(root);
      }).catch(function (e) { setStatus(e.message, true); });
  }

  function versionList() {
    var sec = document.createElement("div");
    sec.className = "editor-section";
    sec.appendChild(h4("校准版本"));
    var list = ctx.getCalibrationVersions().filter(function (v) {
      return v.case_id === activeCase;
    });
    if (!list.length) { sec.appendChild(msg("尚无校准版本")); return sec; }
    var ol = document.createElement("ol");
    ol.className = "version-list";
    list.forEach(function (v) {
      var li = document.createElement("li");
      li.innerHTML = "<span class='kind-" +
        (v.status === "confirmed" ? "sealed" : "revision") + "'>[v" + v.id +
        " " + (v.status === "confirmed" ? "生效" : "已撤销") + "]</span> " +
        "<span class='vat'>" + esc(v.created_at) + "</span>" +
        "<span class='vnote'>" + esc(v.note || "") + "（" +
        v.anchor_count + " 锚点）</span>";
      ol.appendChild(li);
    });
    sec.appendChild(ol);
    return sec;
  }

  // ------------------------------------------------------------ 预览
  var previewTimer = null;
  function refreshPreview(debounce) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(doPreview, debounce ? 250 : 0);
  }

  function doPreview() {
    if (!activeCase || !ctx.getCode()) return;
    ctx.api("/api/trip/" + encodeURIComponent(ctx.getCode()) +
      "/calibration/preview", {
        method: "POST",
        body: JSON.stringify({ case_id: activeCase,
                               mapping: draft(activeCase) }),
      }).then(function (j) {
        lastPreview = j;
        renderConflicts(j.conflicts);
        renderResiduals(j.residuals);
        renderPairs(j.sample_pairs);
        var btn = document.getElementById("calib-confirm");
        if (btn) btn.disabled = j.blocking;
      }).catch(function () { /* 行程未保存等情形忽略 */ });
  }

  // ------------------------------------------------------------ 本地镜像计算
  function sortedAnchors(d) {
    return (d.anchors || []).slice().sort(function (a, b) {
      return parseT(a.raw_time) - parseT(b.raw_time);
    });
  }

  function driftOf(a, base) {
    return (parseT(a.true_time) - parseT(a.raw_time)) / 60000 - base;
  }

  function localValidate(d) {
    // 镜像 app/calibration.py 的阻止规则（拖动时即时反馈）
    var conflicts = [];
    var anchors = sortedAnchors(d);
    var seen = {};
    anchors.forEach(function (a) {
      var key = a.raw_time;
      if (seen[key]) {
        conflicts.push({ rule: "duplicate_anchor",
          message: "锚点「" + (a.label || key) + "」与「" + seen[key] +
            "」重复占用同一采样点 " + key });
      } else seen[key] = a.label || key;
    });
    for (var i = 1; i < anchors.length; i++) {
      if (parseT(anchors[i].true_time) <= parseT(anchors[i - 1].true_time)) {
        conflicts.push({ rule: "anchor_order",
          message: "锚点顺序矛盾：「" +
            (anchors[i].label || anchors[i].raw_time) +
            "」的真值时间不晚于前一锚点，映射将倒退" });
      }
    }
    if (anchors.length >= 2) {
      var lo = parseT(anchors[0].raw_time);
      var hi = parseT(anchors[anchors.length - 1].raw_time);
      var out = 0;
      (ctx.getDoc().logger_rows || []).forEach(function (r) {
        if (r.case_id !== activeCase) return;
        var t = parseT(r.timestamp || r.dt);
        if (t < lo || t > hi) out++;
      });
      if (out) {
        conflicts.push({ rule: "extrapolation",
          message: out + " 个采样点落在锚点范围之外，校准需外推，" +
            "须先补充覆盖首尾的手记事件或峰谷锚点" });
      }
    }
    return conflicts;
  }

  function localResiduals(d) {
    var anchors = sortedAnchors(d);
    var base = num(d.tz_offset_min) + num(d.fixed_offset_min);
    var ds = anchors.map(function (a) { return driftOf(a, base); });
    return anchors.map(function (a, i) {
      var res = null;
      if (anchors.length >= 3) {
        var others = anchors.map(function (x, j) {
          return [parseT(x.raw_time), ds[j]];
        }).filter(function (_, j) { return j !== i; });
        res = Math.round((ds[i] - interpClamped(others,
          parseT(a.raw_time))) * 10) / 10;
      }
      return { label: a.label, kind: a.kind,
        drift_min: Math.round(ds[i] * 10) / 10, residual_min: res };
    });
  }

  function interpClamped(points, x) {
    points = points.slice().sort(function (a, b) { return a[0] - b[0]; });
    if (x <= points[0][0]) return points[0][1];
    if (x >= points[points.length - 1][0]) return points[points.length - 1][1];
    for (var i = 1; i < points.length; i++) {
      if (x <= points[i][0]) {
        var f = (x - points[i - 1][0]) / (points[i][0] - points[i - 1][0]);
        return points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f;
      }
    }
    return points[points.length - 1][1];
  }

  // ------------------------------------------------------------ 小工具
  function span(t) { var s = document.createElement("span"); s.textContent = t; return s; }
  function h4(t) {
    var h = document.createElement("h4");
    h.textContent = t;
    return h;
  }
  function btn(t, fn) {
    var b = document.createElement("button");
    b.className = "btn btn-mini";
    b.textContent = t;
    b.addEventListener("click", fn);
    return b;
  }
  function numFld(label, val, oninput) {
    var lab = document.createElement("label");
    lab.className = "fld";
    lab.appendChild(span(label));
    var inp = document.createElement("input");
    inp.className = "f-in";
    inp.type = "number";
    inp.value = val == null ? 0 : val;
    inp.addEventListener("change", function () { oninput(inp.value); });
    lab.appendChild(inp);
    return lab;
  }
  function dtInput(val, oninput) {
    var inp = document.createElement("input");
    inp.className = "f-in calib-dt";
    inp.type = "datetime-local";
    inp.value = val || "";
    inp.addEventListener("change", function () { oninput(inp.value); });
    return inp;
  }
  function svgEl(name, attrs) {
    var n = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    return n;
  }
  function parseT(t) { return new Date(String(t).replace(" ", "T")).getTime(); }
  function fmtLocal(d) {
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function hm(d) {
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function fmtMin(m) {
    if (m == null) return "—";
    return (m > 0 ? "+" : "") + Math.round(m * 10) / 10 + "′";
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function setStatus(t, isErr) {
    var el = document.getElementById("calib-status");
    if (el) { el.textContent = t; el.style.color = isErr ? "#c0392b" : "#2e7d4f"; }
  }

  return { mount: mount, render: render, prefillOffsets: prefillOffsets };
})();
