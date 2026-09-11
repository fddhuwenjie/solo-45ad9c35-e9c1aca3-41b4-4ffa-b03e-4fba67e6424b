/* 主控：载入样例、计算、节点拖移、封存事件、修订与导出。 */

(function () {
  var doc = null, result = null, versions = [], code = null;
  var calcTimer = null;
  // 已确认的校准映射（只有确认版参与重排）与全部校准版本
  var calibrations = {};        // case_id -> {version_id, mapping, ...}
  var calibrationVersions = []; // 全部校准版本（含已撤销）

  var $ = function (id) { return document.getElementById(id); };

  function api(url, opts) {
    return fetch(url, Object.assign({
      headers: { "Content-Type": "application/json" },
    }, opts)).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }

  function enableUI(on) {
    ["btn-calc", "btn-save", "btn-params", "btn-revision"].forEach(
      function (id) { $(id).disabled = !on; });
    var link = $("link-sheet");
    if (on) { link.hidden = false; link.style.pointerEvents = ""; }
  }

  // ------------------------------------------------------------ 载入
  $("btn-sample").addEventListener("click", function () {
    api("/api/sample/load", { method: "POST" }).then(function (j) {
      code = j.trip_code;
      doc = j.document;
      versions = j.versions;
      calibrations = {};
      calibrationVersions = [];
      $("trip-code").textContent = code;
      $("link-sheet").href = "/sheet/" + encodeURIComponent(code);
      mountEditors();
      renderVersions();
      enableUI(true);
      loadCalibrations();
      calculate(true);
    }).catch(flashErr);
  });

  function mountEditors() {
    Editor.mount($("editor"), function () { return doc; }, scheduleCalc);
    Calib.mount({
      getDoc: function () { return doc; },
      getCode: function () { return code; },
      getCalibrations: function () { return calibrations; },
      getCalibrationVersions: function () { return calibrationVersions; },
      api: api,
      onCalibrated: onCalibrated,
    });
    Editor.render();
  }

  function loadCalibrations() {
    if (!code) return;
    api("/api/trip/" + encodeURIComponent(code) + "/calibrations")
      .then(function (j) {
        calibrations = j.confirmed || {};
        calibrationVersions = j.versions || [];
      }).catch(function () { /* 无校准版本时忽略 */ });
  }

  // 校准确认/撤销后：只合并该箱的重算结果，其余箱保持不变
  function onCalibrated(caseResult, calPayload) {
    calibrations = calPayload.confirmed || {};
    calibrationVersions = calPayload.versions || [];
    if (result && caseResult) {
      result.cases[caseResult.id] = caseResult;
      recomputeEarliest();
      renderAll();
    }
  }

  function recomputeEarliest() {
    var earliest = null;
    Object.keys(result.cases).forEach(function (cid) {
      var co = result.cases[cid];
      co.risks.forEach(function (r) {
        if (r.severity === "danger" &&
            (!earliest || r.start < earliest.time)) {
          earliest = { time: r.start, case_id: cid, case_name: co.name,
                       kind: r.kind, message: r.message };
        }
      });
    });
    if (!earliest) {
      Object.keys(result.cases).forEach(function (cid) {
        var co = result.cases[cid];
        co.risks.forEach(function (r) {
          if (!earliest || r.start < earliest.time) {
            earliest = { time: r.start, case_id: cid, case_name: co.name,
                         kind: r.kind, message: r.message };
          }
        });
      });
    }
    result.earliest = earliest;
  }

  function flashErr(e) {
    var b = $("risk-banner");
    b.className = "risk-banner danger";
    b.textContent = "请求失败：" + e.message;
  }

  // ------------------------------------------------------------ 计算
  $("btn-calc").addEventListener("click", function () { calculate(true); });

  function scheduleCalc() {
    clearTimeout(calcTimer);
    calcTimer = setTimeout(function () { calculate(false); }, 200);
  }

  function calculate(persist) {
    if (!doc) return;
    var tasks = [api("/api/calculate", {
      method: "POST",
      body: JSON.stringify({ document: doc,
                             calibrations: calibMappings() }),
    })];
    if (persist) {
      tasks.push(api("/api/trip/" + encodeURIComponent(code) + "/document",
        { method: "PUT", body: JSON.stringify(doc) })
        .catch(function () { /* 未建行程时忽略 */ }));
    }
    Promise.all(tasks).then(function (rs) {
      result = rs[0];
      renderAll();
    }).catch(function (e) {
      if (String(e.message).indexOf("阶段") >= 0) {
        $("charts").innerHTML =
          '<div class="empty-hint">' + e.message + "</div>";
      } else flashErr(e);
    });
  }

  function calibMappings() {
    var out = {};
    Object.keys(calibrations).forEach(function (cid) {
      out[cid] = calibrations[cid].mapping;
    });
    return out;
  }

  // ------------------------------------------------------------ 渲染
  function renderAll() {
    // 路线时间带图例注明各校准版本
    var calVersions = {};
    Object.keys(calibrations).forEach(function (cid) {
      calVersions[cid] = calibrations[cid].version_id;
    });
    result.calibration_versions = calVersions;
    Charts.render($("charts"), result, doc, {
      onNodeDrag: handleNodeDrag,
      onNodeDragEnd: function () { calculate(true); },
    });
    Editor.refresh();
    renderBanner();
    renderRiskList();
    renderOpenTable();
    $("btn-revision").disabled = !hasDeviation();
  }

  function handleNodeDrag(cid, type, time) {
    var c = doc.cases.filter(function (x) {
      return String(x.id) === String(cid);
    })[0];
    if (!c) return;
    var n = (c.nodes || []).filter(function (x) { return x.type === type; })[0];
    if (n && !n.locked) n.time = time;
    // 不在拖动中重算（会整图重绘、打断拖移）；松开时统一重算
  }

  function renderBanner() {
    var b = $("risk-banner");
    var e = result.earliest;
    if (!e) {
      b.className = "risk-banner ok";
      b.innerHTML = "✓ 当前安排下各箱均未触发结露、升温/湿度超限或静置不足。";
      return;
    }
    var danger = e.kind === "condensation";
    b.className = "risk-banner " + (danger ? "danger" : "warn");
    var waitTxt = earliestWait();
    b.innerHTML = (danger ? "⚠ 结露风险：" : "预警：") +
      "最早出现在 <b>" + e.time.replace("T", " ") + "</b>，箱号 " +
      esc(e.case_id) + "（" + esc(e.case_name) + "）— " + esc(e.message) +
      (waitTxt ? '<span class="wait">' + waitTxt + "</span>" : "");
  }

  function earliestWait() {
    // 取各箱节点建议中的最大等待时长，给出最保守的等待提示
    var maxW = 0, where = "";
    Object.keys(result.cases).forEach(function (cid) {
      var adv = result.cases[cid].node_advice || {};
      ["unpack", "open"].forEach(function (t) {
        var a = adv[t];
        if (a && a.wait_minutes > maxW) {
          maxW = a.wait_minutes;
          where = cid + " " +
            ({ unpack: "拆外包装", open: "开箱" }[t]);
        }
      });
    });
    if (!maxW) {
      // 可能是断档/静置类风险，无直接等待量
      var g = firstGapRisk();
      if (g) return "记录仪断档 " + g.peak + " 分钟，须人工核查该时段";
      return "";
    }
    return where + " 尚需等待 " + fmtMin(maxW);
  }

  function firstGapRisk() {
    var out = null;
    Object.keys(result.cases).forEach(function (cid) {
      result.cases[cid].risks.forEach(function (r) {
        if (r.kind === "logger_gap" && (!out || r.start < out.start)) out = r;
      });
    });
    return out;
  }

  function fmtMin(m) {
    var h = Math.floor(m / 60), mm = m % 60;
    return h + " 小时 " + mm + " 分";
  }

  function renderRiskList() {
    var box = $("risk-list");
    box.innerHTML = "";
    box.classList.remove("muted");
    var any = false;
    Object.keys(result.cases).forEach(function (cid) {
      var co = result.cases[cid];
      co.risks.forEach(function (r) {
        any = true;
        var d = ce("div", "risk-item " +
          (r.kind === "condensation" ? "danger" : "warn"));
        d.innerHTML = "<b>" + esc(cid) + " · " + esc(co.name) + "</b> " +
          '<span class="when">' + r.start.replace("T", " ") +
          (r.end !== r.start ? " – " + r.end.replace("T", " ") : "") +
          "</span><br>" + esc(r.message);
        box.appendChild(d);
      });
      co.gaps.forEach(function (g) {
        // 断档已在 risks 中，不重复
      });
    });
    if (!any) {
      box.classList.add("muted");
      box.textContent = "暂无风险";
    }
  }

  function renderOpenTable() {
    var box = $("open-table");
    var html = '<table class="grid"><tr><th>箱号 / 藏品</th><th>进场</th>' +
      "<th>静置起</th><th>静置时长</th><th>拆外包装</th><th>开箱</th>" +
      "<th>现场操作</th></tr>";
    doc.cases.forEach(function (c) {
      var co = result.cases[c.id] || {};
      var nodes = {};
      (c.nodes || []).forEach(function (n) { nodes[n.type] = n.time; });
      var adv = co.node_advice || {};
      var events = {};
      (doc.events || []).forEach(function (e) {
        if (e.case_id === c.id) events[e.type] = e.time;
      });
      var cal = calibrations[c.id];

      html += "<tr><td><b>" + esc(c.id) + "</b><br>" +
        '<span class="muted small">' + esc(c.name) + "</span>" +
        (cal ? '<br><span class="tag info" title="' +
          esc(cal.note || "") + "">校准 v" + cal.version_id + "</span>"
          : "") + "</td>";
      html += "<td>" + short(nodes.entry) + "</td>";
      html += "<td>" + short(nodes.rest) + "</td>";
      var rest = co.rest;
      if (rest) {
        html += "<td>" +
          '<span class="tag ' + (rest.enough ? "ok" : "warn") + '">' +
          (Math.round(rest.minutes / 6)) / 10 + "h / 要求 " +
          (Math.round(rest.required / 6)) / 10 + "h</span></td>";
      } else html += "<td>—</td>";

      html += nodeCell("unpack", nodes, events, adv);
      html += nodeCell("open", nodes, events, adv);
      html += "<td>" + actionButtons(c) + "</td></tr>";
    });
    html += "</table>";

    // 风险摘要行
    html += '<p class="muted small" style="margin-top:8px">';
    var counts = { danger: 0, warn: 0 };
    Object.keys(result.cases).forEach(function (cid) {
      result.cases[cid].risks.forEach(function (r) {
        counts[r.severity === "danger" ? "danger" : "warn"]++;
      });
    });
    html += "风险合计：<span class='tag danger'>结露 " + counts.danger +
      "</span><span class='tag warn'>预警 " + counts.warn + "</span>";
    if (hasDeviation()) {
      var d = firstDeviation();
      html += "<span class='tag warn'>实测偏离自 " +
        d.time.replace("T", " ") + "</span>";
    }
    html += "</p>";
    box.innerHTML = html;

    box.querySelectorAll("[data-seal]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var parts = btn.dataset.seal.split("|");
        sealEvent(parts[0], parts[1]);
      });
    });
  }

  function nodeCell(type, nodes, events, adv) {
    var label = { unpack: "拆外包装", open: "开箱" }[type];
    if (events[type]) {
      return "<td>" + short(events[type]) +
        ' <span class="tag ok">已封存🔒</span></td>';
    }
    var a = adv[type];
    var html = "<td>" + short(nodes[type]);
    if (a) {
      if (a.wait_minutes > 0) {
        html += '<br><span class="tag warn">建议 ' +
          short(a.safe_time) + "</span>" +
          '<div class="muted small">尚需等待 ' +
          fmtMin(a.wait_minutes) + "</div>";
      } else {
        html += '<br><span class="tag ok">时刻安全</span>';
      }
    }
    return html + "</td>";
  }

  function actionButtons(c) {
    var done = {};
    (doc.events || []).forEach(function (e) {
      if (e.case_id === c.id) done[e.type] = true;
    });
    var html = "";
    ["unpack", "open"].forEach(function (t) {
      var label = { unpack: "封存·拆外包装", open: "封存·开箱" }[t];
      if (done[t]) return;
      html += '<button class="btn btn-mini" data-seal="' +
        esc(c.id) + "|" + t + '">' + label + "</button> ";
    });
    return html || '<span class="muted small">操作已完成</span>';
  }

  // ------------------------------------------------------------ 封存
  function sealEvent(cid, type) {
    var c = doc.cases.filter(function (x) {
      return String(x.id) === String(cid);
    })[0];
    var n = c.nodes.filter(function (x) { return x.type === type; })[0];
    if (!n) return;
    if (!confirm("封存后该事件视为已发生，不可再拖移。\n" +
                 cid + " " + ({ unpack: "拆外包装", open: "开箱" })[type] +
                 " @ " + n.time + "\n确认封存？")) return;
    api("/api/trip/" + encodeURIComponent(code) + "/events", {
      method: "POST",
      body: JSON.stringify({ case_id: cid, type: type, time: n.time }),
    }).then(function (j) {
      doc.events = j.events;
      versions = j.versions;
      renderVersions();
      calculate(true);
    }).catch(flashErr);
  }

  // ------------------------------------------------------------ 修订
  function hasDeviation() {
    if (!result) return false;
    return Object.keys(result.cases).some(function (cid) {
      return !!result.cases[cid].deviation;
    });
  }

  function firstDeviation() {
    var out = null;
    Object.keys(result.cases).forEach(function (cid) {
      var d = result.cases[cid].deviation;
      if (d && (!out || d.time < out.time)) out = Object.assign({ cid: cid }, d);
    });
    return out;
  }

  $("btn-revision").addEventListener("click", function () {
    var d = firstDeviation();
    if (!d) return;
    if (!confirm("从偏离点 " + d.time + "（" + d.cid +
                 "）建立修订？\n偏离点之前的节点将锁定为历史，" +
                 "热响应系数将按实测重新拟合。")) return;
    api("/api/trip/" + encodeURIComponent(code) + "/revision", {
      method: "POST", body: JSON.stringify({ case_id: d.cid }),
    }).then(function (j) {
      return api("/api/trip/" + encodeURIComponent(code));
    }).then(function (j) {
      doc = j.document;
      versions = j.versions;
      mountEditors();
      renderVersions();
      calculate(false);
      var b = $("risk-banner");
      b.className = "risk-banner warn";
      b.textContent = "已建立修订版本（历史节点未改动），可在版本列表查看。";
    }).catch(flashErr);
  });

  // ------------------------------------------------------------ 版本
  $("btn-save").addEventListener("click", function () {
    var note = prompt("版本说明：", "计划调整 " + new Date().toLocaleString());
    if (note === null) return;
    calculate(true);
    api("/api/trip/" + encodeURIComponent(code) + "/versions", {
      method: "POST", body: JSON.stringify({ kind: "plan", note: note }),
    }).then(function (j) {
      versions = j.versions;
      renderVersions();
    }).catch(flashErr);
  });

  function renderVersions() {
    var ol = $("version-list");
    if (!versions.length) {
      ol.className = "version-list muted";
      ol.innerHTML = "<li>尚无封存版本</li>";
      return;
    }
    ol.className = "version-list";
    ol.innerHTML = versions.map(function (v) {
      var label = { plan: "计划", revision: "修订", sealed: "封存" }[v.kind];
      return "<li><span class='kind-" + v.kind + "'>[" + label + "]</span> " +
        "v" + v.id + ' <span class="vat">' + esc(v.created_at) + "</span>" +
        ' <a data-vid="' + v.id + '">查看</a>' +
        ' <a href="/sheet/' + encodeURIComponent(code) + "?v=" + v.id +
        '" target="_blank">操作单</a>' +
        '<span class="vnote">' + esc(v.note || "") + "</span></li>";
    }).join("");
    ol.querySelectorAll("a[data-vid]").forEach(function (a) {
      a.addEventListener("click", function () {
        api("/api/version/" + a.dataset.vid).then(showVersion);
      });
    });
  }

  function showVersion(v) {
    $("modal-title").textContent =
      "v" + v.id + " · " +
      { plan: "计划", revision: "修订", sealed: "封存" }[v.kind] +
      " · " + v.created_at + "　" + (v.note || "");
    $("modal-body").textContent =
      JSON.stringify(v.document, null, 2);
    $("modal").hidden = false;
  }
  $("modal-close").addEventListener("click", function () {
    $("modal").hidden = true;
  });

  // ------------------------------------------------------------ 导入导出
  $("csv-file").addEventListener("change", function (ev) {
    var f = ev.target.files[0];
    if (!f) return;
    var fd = new FormData();
    fd.append("file", f);
    fetch("/api/parse-csv", { method: "POST", body: fd })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error) { alert(res.error); return; }
        var rows = res.rows.map(function (r) {
          return { case_id: r.case_id, timestamp: r.timestamp,
                   temp: r.temp, rh: r.rh };
        });
        doc.logger_rows = rows;
        mountEditors();
        var status = "✅ 从 " + f.name + " 解析 " + res.count +
          " 条：" + Object.keys(res.by_case).map(function (k) {
            return k + "×" + res.by_case[k];
          }).join("，");
        // 时区/固定偏移列预填到校准工作区
        if (res.offsets && Object.keys(res.offsets).length) {
          Calib.prefillOffsets(res.offsets);
          status += "；含时区/偏移列，已预填到“时间校准”";
        }
        Editor.setLogger(rows, status);
        calculate(true);
      });
    ev.target.value = "";
  });

  $("btn-params").addEventListener("click", function () {
    fetch("/api/params", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document: doc,
                             calibrations: calibMappings() }),
    }).then(function (r) { return r.blob(); }).then(function (blob) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "params-" + code + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  });

  // ------------------------------------------------------------ 小工具
  function ce(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function short(t) { return t ? String(t).replace("T", " ").slice(5) : "—"; }
})();
