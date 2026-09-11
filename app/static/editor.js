/* 右侧参数编辑器：阶段、箱体（包装层+限值+节点）、记录仪、原始 JSON。 */

var Editor = (function () {
  var root = null, doc = null, onChange = null, activeTab = "phases";
  var loggerRows = null, csvStatus = "";

  function mount(el, getDoc, changeHandler) {
    root = el;
    doc = getDoc;
    onChange = changeHandler;
    loggerRows = (doc() && doc().logger_rows) || [];
    root.parentNode.querySelectorAll(".tab").forEach(function (b) {
      b.addEventListener("click", function () {
        activeTab = b.dataset.tab;
        root.parentNode.querySelectorAll(".tab").forEach(function (x) {
          x.classList.toggle("active", x === b);
        });
        render();
      });
    });
  }

  function setLogger(rows, status) {
    loggerRows = rows;
    csvStatus = status || "";
    doc().logger_rows = rows;
    if (activeTab === "logger") render();
    onChange();
  }

  function refresh() { render(); }

  function render() {
    var d = doc();
    if (!root) return;
    if (activeTab === "phases") renderPhases(d);
    else if (activeTab === "cases") renderCases(d);
    else if (activeTab === "logger") renderLogger(d);
    else renderJson(d);
  }

  // ------------------------------------------------------------ 工具
  function fld(label, val, oninput, type) {
    var wrap = ce("label", "fld");
    var sp = ce("span", null, label);
    var inp = document.createElement("input");
    inp.className = "f-in";
    inp.value = val == null ? "" : val;
    if (type) inp.type = type;
    inp.addEventListener("change", function () { oninput(inp.value); });
    wrap.appendChild(sp); wrap.appendChild(inp);
    return wrap;
  }

  function ce(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ------------------------------------------------------------ 阶段
  function renderPhases(d) {
    root.innerHTML = "";
    var sec = ce("div", "editor-section");
    var h = ce("h4", null, "沿途各阶段");
    var add = ce("button", "btn btn-mini", "+ 增加阶段");
    add.addEventListener("click", function () {
      var last = d.phases[d.phases.length - 1];
      d.phases.push({ name: "新阶段",
        start: last ? last.end : "2026-01-15T12:00",
        end: last ? shift(last.end, 60) : "2026-01-15T13:00",
        temp: 20, rh: 50, color: "#eef3f8" });
      render(); onChange();
    });
    h.appendChild(add);
    sec.appendChild(h);

    d.phases.forEach(function (p, i) {
      var blk = ce("div", "block");
      var head = ce("div", "blk-head");
      head.appendChild(ce("span", null, (i + 1) + ". " + p.name));
      var del = ce("button", "btn btn-mini", "删除");
      del.addEventListener("click", function () {
        d.phases.splice(i, 1); render(); onChange();
      });
      head.appendChild(del);
      blk.appendChild(head);

      var r1 = ce("div", "field-row");
      r1.appendChild(fld("名称", p.name, function (v) { p.name = v; }));
      r1.appendChild(fld("开始", p.start, function (v) { p.start = v; },
        "datetime-local"));
      r1.appendChild(fld("结束", p.end, function (v) { p.end = v; },
        "datetime-local"));
      blk.appendChild(r1);

      var r2 = ce("div", "field-row");
      r2.appendChild(fld("温度 °C", p.temp, function (v) {
        p.temp = num(v); }));
      r2.appendChild(fld("相对湿度 %", p.rh, function (v) {
        p.rh = num(v); }));
      r2.appendChild(fld("色带", p.color, function (v) { p.color = v; },
        "color"));
      blk.appendChild(r2);
      sec.appendChild(blk);
    });
    root.appendChild(sec);
    root.appendChild(globalSettings(d));
  }

  function globalSettings(d) {
    var sec = ce("div", "editor-section");
    sec.appendChild(ce("h4", null, "全局判定"));
    var r = ce("div", "field-row");
    r.appendChild(fld("断档阈值（分）", d.gap_threshold_min || 30,
      function (v) { d.gap_threshold_min = num(v); }));
    r.appendChild(fld("实测偏离阈值 °C", d.deviation_temp || 2,
      function (v) { d.deviation_temp = num(v); }));
    sec.appendChild(r);
    return sec;
  }

  // ------------------------------------------------------------ 箱体
  function renderCases(d) {
    root.innerHTML = "";
    d.cases.forEach(function (c, ci) {
      var blk = ce("div", "block");
      var head = ce("div", "blk-head");
      head.appendChild(ce("span", null, c.id + " · " + c.name));
      blk.appendChild(head);

      var r0 = ce("div", "field-row");
      r0.appendChild(fld("箱号", c.id, function (v) { c.id = v; }));
      r0.appendChild(fld("名称", c.name, function (v) { c.name = v; }));
      r0.appendChild(fld("热响应系数 τ×", c.tau_multiplier,
        function (v) { c.tau_multiplier = num(v); }));
      r0.appendChild(fld("开箱水汽交换 k", c.k_open,
        function (v) { c.k_open = num(v); }));
      blk.appendChild(r0);

      // 包装层
      var lh = ce("h4", null, "包装层与热响应参数");
      var addL = ce("button", "btn btn-mini", "+ 层");
      addL.addEventListener("click", function () {
        c.layers.push({ name: "新包装层", role: "middle",
          r_value: 0.3, heat_capacity: 0.5, removed_at: "unpack" });
        render(); onChange();
      });
      lh.appendChild(addL);
      blk.appendChild(lh);

      c.layers.forEach(function (ly, li) {
        var r = ce("div", "field-row");
        r.appendChild(fld("层名称", ly.name, function (v) { ly.name = v; }));
        r.appendChild(selectFld("角色", ly.role,
          [["outer", "外层"], ["middle", "中层"], ["inner", "内层"]],
          function (v) { ly.role = v; }));
        r.appendChild(selectFld("拆除时机",
          ly.removed_at || (ly.role === "inner" ? "open" : "unpack"),
          [["unpack", "拆外包装时"], ["open", "开箱时"],
           ["none", "不拆（保留）"]],
          function (v) { ly.removed_at = v; }));
        r.appendChild(fld("热阻 R (K/W·kg)", ly.r_value,
          function (v) { ly.r_value = num(v); }));
        r.appendChild(fld("热容 C (kJ/K)", ly.heat_capacity,
          function (v) { ly.heat_capacity = num(v); }));
        var del = ce("button", "btn btn-mini", "删层");
        del.addEventListener("click", function () {
          c.layers.splice(li, 1); render(); onChange();
        });
        r.appendChild(del);
        blk.appendChild(r);
      });

      // 限值
      blk.appendChild(ce("h4", null, "材料限值"));
      var rl = ce("div", "field-row");
      rl.appendChild(fld("露点差下限 °C",
        c.limits.dew_margin, function (v) { c.limits.dew_margin = num(v); }));
      rl.appendChild(fld("升温率上限 °C/h",
        c.limits.warm_rate, function (v) { c.limits.warm_rate = num(v); }));
      rl.appendChild(fld("RH 变化率 %/h",
        c.limits.rh_rate, function (v) { c.limits.rh_rate = num(v); }));
      rl.appendChild(fld("最短静置（分）",
        c.limits.min_rest_min,
        function (v) { c.limits.min_rest_min = num(v); }));
      blk.appendChild(rl);

      // 节点
      blk.appendChild(ce("h4", null, "四类节点（也可在图上拖移）"));
      var rn = ce("div", "field-row");
      ["entry", "rest", "unpack", "open"].forEach(function (t) {
        var n = c.nodes.filter(function (x) { return x.type === t; })[0];
        var lbl = { entry: "进场", rest: "静置", unpack: "拆外包装",
          open: "开箱" }[t];
        if (n) {
          var f = fld(lbl + (n.locked ? " 🔒" : ""), n.time,
            function (v) { n.time = v; }, "datetime-local");
          if (n.locked) f.style.opacity = ".7";
          rn.appendChild(f);
        }
      });
      blk.appendChild(rn);

      root.appendChild(blk);
    });

    var add = ce("button", "btn btn-mini", "+ 增加箱");
    add.addEventListener("click", function () {
      d.cases.push({ id: "C-" + (d.cases.length + 1).toString().padStart(2, "0"),
        name: "新箱", tau_multiplier: 1, k_open: 1.5,
        surface_factor: 0, layers: [],
        limits: { dew_margin: 2, warm_rate: 2, rh_rate: 5,
          min_rest_min: 240 },
        nodes: [
          { type: "entry", time: d.phases[2] ? d.phases[2].start : "" },
          { type: "rest", time: d.phases[2] ? d.phases[2].start : "" },
          { type: "unpack", time: "" }, { type: "open", time: "" }] });
      render(); onChange();
    });
    root.appendChild(add);
  }

  function selectFld(label, val, opts, onsel) {
    var wrap = ce("label", "fld");
    wrap.appendChild(ce("span", null, label));
    var sel = document.createElement("select");
    sel.className = "f-in";
    opts.forEach(function (o) {
      var op = document.createElement("option");
      op.value = o[0]; op.textContent = o[1];
      if (String(o[0]) === String(val)) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener("change", function () { onsel(sel.value); });
    wrap.appendChild(sel);
    return wrap;
  }

  // ------------------------------------------------------------ 记录仪
  function renderLogger(d) {
    root.innerHTML = "";
    var rows = d.logger_rows || [];
    var byCase = {};
    rows.forEach(function (r) {
      byCase[r.case_id] = (byCase[r.case_id] || 0) + 1;
    });
    var info = ce("div", "logger-summary");
    info.innerHTML = csvStatus ||
      ("当前载入 <b>" + rows.length + "</b> 条记录，覆盖箱号：" +
       (Object.keys(byCase).map(function (k) {
         return k + "（" + byCase[k] + " 条）";
       }).join("、") || "无"));
    root.appendChild(info);

    var btns = ce("div", "editor-actions");
    var loadSample = ce("button", "btn btn-mini", "载入示例 CSV（严寒行程）");
    loadSample.addEventListener("click", function () {
      fetch("/api/sample/logger.csv").then(function (r) { return r.text(); })
        .then(function (txt) { ingestText(txt); });
    });
    btns.appendChild(loadSample);
    if (rows.length) {
      var clr = ce("button", "btn btn-mini", "清除实测数据");
      clr.addEventListener("click", function () {
        d.logger_rows = []; loggerRows = []; csvStatus = "已清除实测数据";
        render(); onChange();
      });
      btns.appendChild(clr);
    }
    root.appendChild(btns);

    if (rows.length) {
      var tbl = ce("table", "grid");
      tbl.innerHTML = "<tr><th>箱号</th><th>时间</th><th>°C</th><th>%RH</th></tr>";
      rows.slice(0, 200).forEach(function (r) {
        var tr = ce("tr");
        tr.appendChild(ce("td", null, r.case_id));
        tr.appendChild(ce("td", null, fmt(r.timestamp || r.dt)));
        tr.appendChild(ce("td", null, r.temp));
        tr.appendChild(ce("td", null, r.rh));
        tbl.appendChild(tr);
      });
      root.appendChild(tbl);
      if (rows.length > 200) {
        root.appendChild(ce("p", "muted small",
          "仅预览前 200 条，共 " + rows.length + " 条"));
      }
    }
  }

  function ingestText(txt) {
    fetch("/api/parse-csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: txt }),
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.error) { csvStatus = "❌ " + res.error; render(); return; }
      var norm = res.rows.map(function (r) {
        return { case_id: r.case_id, timestamp: r.timestamp,
                 temp: r.temp, rh: r.rh };
      });
      csvStatus = "✅ 已解析 " + res.count + " 条：" +
        Object.keys(res.by_case).map(function (k) {
          return k + "×" + res.by_case[k];
        }).join("，");
      setLogger(norm, csvStatus);
    });
  }

  // ------------------------------------------------------------ JSON
  function renderJson(d) {
    root.innerHTML = "";
    var ta = ce("textarea", "jsonbox");
    var shown = JSON.parse(JSON.stringify(d));
    ta.value = JSON.stringify(shown, null, 2);
    var acts = ce("div", "editor-actions");
    var apply = ce("button", "btn btn-mini btn-primary", "应用 JSON 并重算");
    var msg = ce("span", "apply-msg");
    apply.addEventListener("click", function () {
      try {
        var parsed = JSON.parse(ta.value);
        Object.keys(d).forEach(function (k) { delete d[k]; });
        Object.assign(d, parsed);
        loggerRows = d.logger_rows || [];
        msg.className = "apply-msg ok";
        msg.textContent = "已应用";
        onChange();
      } catch (e) {
        msg.className = "apply-msg err";
        msg.textContent = "JSON 解析失败：" + e.message;
      }
    });
    acts.appendChild(apply); acts.appendChild(msg);
    root.appendChild(ta); root.appendChild(acts);
  }

  function num(v) {
    var n = parseFloat(v);
    return isNaN(n) ? v : n;
  }

  function shift(t, minutes) {
    var d = new Date(t.replace(" ", "T"));
    d.setMinutes(d.getMinutes() + minutes);
    return d.toISOString().slice(0, 16);
  }

  function fmt(t) { return t ? String(t).replace("T", " ") : ""; }

  return { mount: mount, render: render, refresh: refresh,
           setLogger: function (r, s) { setLogger(r, s); },
           ingestText: ingestText };
})();
