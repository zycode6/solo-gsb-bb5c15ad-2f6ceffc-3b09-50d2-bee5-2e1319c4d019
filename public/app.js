'use strict';

(function () {
  var Anonymizer = window.Anonymizer;

  /* ---------------- 状态 ---------------- */
  var state = {
    text: '',
    rules: [], // {id, code, aliases:[], selections:[{start,end}]}
    undoStack: [], // 仅记录“登记新人物”，支持撤销最近一次规则
    activeIndex: -1,
    pending: null, // 当前框选 {start,end}
  };

  var el = {
    srcContent: document.getElementById('src-content'),
    prevContent: document.getElementById('prev-content'),
    srcPane: document.getElementById('src-pane'),
    prevPane: document.getElementById('prev-pane'),
    srcMeta: document.getElementById('src-meta'),
    prevMeta: document.getElementById('prev-meta'),
    statusbar: document.getElementById('statusbar'),
    rulesList: document.getElementById('rules-list'),
    ruleForm: document.getElementById('rule-form'),
    inputCode: document.getElementById('input-code'),
    inputAliases: document.getElementById('input-aliases'),
    btnUndo: document.getElementById('btn-undo'),
    btnClear: document.getElementById('btn-clear'),
    btnSampleTop: document.getElementById('btn-sample-top'),
    overlay: document.getElementById('entry-overlay'),
    entryTextarea: document.getElementById('entry-textarea'),
    btnLoad: document.getElementById('btn-load'),
    btnSampleEntry: document.getElementById('btn-sample-entry'),
    toolbar: document.getElementById('sel-toolbar'),
    selText: document.getElementById('sel-text'),
    selRule: document.getElementById('sel-rule'),
    selApply: document.getElementById('sel-apply'),
    toast: document.getElementById('toast'),
  };

  var idSeq = 0;
  function nextId() {
    idSeq += 1;
    return 'r' + Date.now().toString(36) + '-' + idSeq;
  }

  /* ---------------- 工具 ---------------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function splitAliases(raw) {
    var seen = Object.create(null);
    var out = [];
    String(raw || '')
      .split(/[,，、;；\s]+/)
      .forEach(function (a) {
        a = a.trim();
        if (a && !Object.prototype.hasOwnProperty.call(seen, a)) {
          seen[a] = true;
          out.push(a);
        }
      });
    return out;
  }

  function hueOf(index) {
    return (index * 53 + 205) % 360;
  }

  var toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.hidden = true;
    }, 2200);
  }

  function findRule(id) {
    return state.rules.filter(function (r) {
      return r.id === id;
    })[0] || null;
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var result = Anonymizer.anonymize(state.text, state.rules);
    var colorOf = Object.create(null);
    var colorByRule = Object.create(null);
    state.rules.forEach(function (r, i) {
      var c = 'hsl(' + hueOf(i) + ',62%,40%)';
      colorOf[r.id] = c;
      colorByRule[r.id] = c;
    });

    renderPane(result, 'orig', el.srcContent, el.srcPane);
    renderPane(result, 'prev', el.prevContent, el.prevPane);

    el.srcMeta.textContent = state.text ? state.text.length + ' 字符' : '';
    el.prevMeta.textContent = state.text ? result.preview.length + ' 字符' : '';

    var explicitCount = result.hits.filter(function (h) {
      return h.type === 'explicit';
    }).length;
    var aliasCount = result.hits.length - explicitCount;
    el.statusbar.innerHTML = state.text
      ? '原稿 <b>' + state.text.length + '</b> 字符　·　预览 <b>' + result.preview.length +
        '</b> 字符　·　命中 <b>' + result.hits.length + '</b> 处（显式框选 <b>' +
        explicitCount + '</b>，称呼匹配 <b>' + aliasCount + '</b>）　·　虚线框＝显式框选，下划线＝称呼自动命中'
      : '尚未载入原稿。';

    renderRules(colorOf, result);
    el.btnUndo.disabled = state.undoStack.length === 0;
    el.btnUndo.textContent = state.undoStack.length
      ? '撤销最近一次规则（' + state.undoStack[state.undoStack.length - 1].code + '）'
      : '撤销最近一次规则';

    if (state.activeIndex >= 0 && state.activeIndex < result.hits.length) {
      markActive(state.activeIndex, false);
    } else {
      state.activeIndex = -1;
    }
  }

  function renderPane(result, side, container, pane) {
    var html = '';
    result.segments.forEach(function (seg) {
      var str;
      if (side === 'orig') {
        str = result.text.slice(seg.origStart, seg.origEnd);
      } else {
        str = result.preview.slice(seg.prevStart, seg.prevEnd);
      }
      if (seg.kind === 'hit') {
        var hit = result.hits[seg.hitIndex];
        var ruleColor = colorByRule[hit.ruleId] || 'hsl(220,60%,40%)';
        var cls = 'hit' + (hit.type === 'explicit' ? ' explicit' : '');
        html += '<span class="' + cls + '" style="color:' + ruleColor +
          '" data-side="' + side + '" data-i="' + seg.hitIndex + '">' +
          escapeHtml(str) + '</span>';
      } else {
        html += escapeHtml(str);
      }
    });
    var scrollTop = pane.scrollTop;
    var scrollLeft = pane.scrollLeft;
    container.innerHTML = html;
    pane.scrollTop = scrollTop;
    pane.scrollLeft = scrollLeft;
  }

  function renderRules(colorOf, result) {
    if (!state.rules.length) {
      el.rulesList.innerHTML =
        '<div class="empty-tip">还没有人物规则。<br>在左侧框选片段，或用上方表单登记人物与称呼。</div>';
      return;
    }

    // 统计每条规则的命中数
    var hitCount = Object.create(null);
    result.hits.forEach(function (h) {
      hitCount[h.ruleId] = (hitCount[h.ruleId] || 0) + 1;
    });

    el.rulesList.innerHTML = state.rules
      .map(function (r) {
        var color = colorOf[r.id];
        var aliasChips = r.aliases
          .map(function (a) {
            return '<span class="chip" title="称呼">' + escapeHtml(a) +
              '<button type="button" data-action="del-alias" data-rule="' + r.id +
              '" data-alias="' + encodeURIComponent(a) + '" title="删除称呼">×</button></span>';
          })
          .join('');

        var selChips = r.selections
          .map(function (s, idx) {
            var snippet = state.text.slice(s.start, Math.min(s.end, s.start + 10));
            if (s.end - s.start > 10) snippet += '…';
            return '<span class="chip sel-chip" data-action="loc-sel" data-rule="' + r.id +
              '" data-idx="' + idx + '" title="点击定位到原稿对应区间">' +
              '✂ ' + escapeHtml(snippet) +
              '<button type="button" data-action="del-sel" data-rule="' + r.id +
              '" data-idx="' + idx + '" title="删除框选">×</button></span>';
          })
          .join('');

        return (
          '<div class="rule-card" style="border-left-color:' + color + '">' +
            '<div class="rule-top">' +
              '<span class="rule-code" style="color:' + color + '">' + escapeHtml(r.code) + '</span>' +
              '<span class="rule-count">命中 ' + (hitCount[r.id] || 0) + ' 处</span>' +
              '<button type="button" class="rule-del" data-action="del-rule" data-rule="' +
                r.id + '" title="删除整条规则">🗑</button>' +
            '</div>' +
            '<div class="rule-section">' +
              '<div class="rule-section-label">称呼（' + r.aliases.length + '）</div>' +
              '<div class="chips">' + aliasChips +
                '<button type="button" class="chip-add" data-action="add-alias" data-rule="' +
                  r.id + '">＋称呼</button>' +
              '</div>' +
            '</div>' +
            '<div class="rule-section">' +
              '<div class="rule-section-label">显式框选（' + r.selections.length + '）</div>' +
              '<div class="chips">' + (selChips || '<span class="rule-section-label">无</span>') +
              '</div>' +
            '</div>' +
          '</div>'
        );
      })
      .join('');
  }

  /* ---------------- 高亮 / 双向联动 ---------------- */
  function clearActive() {
    state.activeIndex = -1;
    document.querySelectorAll('.hit.active').forEach(function (n) {
      n.classList.remove('active');
    });
  }

  function markActive(i, flash) {
    clearActive();
    state.activeIndex = i;
    document.querySelectorAll('.hit[data-i="' + i + '"]').forEach(function (n) {
      n.classList.add('active');
      n.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    });
  }

  /* ---------------- 框选 ---------------- */
  function selectionOffsets() {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    var root = el.srcContent;
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

    var pre = document.createRange();
    pre.selectNodeContents(root);
    var startRange = document.createRange();
    startRange.selectNodeContents(root);
    startRange.setEnd(range.startContainer, range.startOffset);
    var endRange = document.createRange();
    endRange.selectNodeContents(root);
    endRange.setEnd(range.endContainer, range.endOffset);

    var start = startRange.toString().length;
    var end = endRange.toString().length;
    if (!(end > start) || end > state.text.length) return null;
    return { start: start, end: end };
  }

  function refreshToolbar() {
    if (el.overlay && !el.overlay.hidden) {
      el.toolbar.hidden = true;
      return;
    }
    var off = selectionOffsets();
    if (!off) {
      state.pending = null;
      el.toolbar.hidden = true;
      return;
    }
    state.pending = off;

    el.selText.textContent = state.text.slice(off.start, off.end);
    if (state.rules.length) {
      el.selRule.innerHTML = state.rules
        .map(function (r) {
          return '<option value="' + r.id + '">' + escapeHtml(r.code) + '</option>';
        })
        .join('');
      el.selRule.disabled = false;
      el.selApply.disabled = false;
    } else {
      el.selRule.innerHTML = '<option>请先在右侧登记人物</option>';
      el.selRule.disabled = true;
      el.selApply.disabled = true;
    }

    var sel = window.getSelection();
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    el.toolbar.hidden = false;
    var tbH = el.toolbar.offsetHeight || 34;
    var top = rect.top > tbH + 12 ? rect.top - tbH - 8 : rect.bottom + 8;
    var left = Math.min(rect.left, window.innerWidth - el.toolbar.offsetWidth - 16);
    el.toolbar.style.top = Math.max(8, top) + 'px';
    el.toolbar.style.left = Math.max(8, left) + 'px';
  }

  function overlapsExistingSelection(start, end) {
    for (var i = 0; i < state.rules.length; i++) {
      var r = state.rules[i];
      for (var j = 0; j < r.selections.length; j++) {
        var s = r.selections[j];
        if (start < s.end && s.start < end) return r;
      }
    }
    return null;
  }

  function applyPendingSelection() {
    var pending = state.pending;
    if (!pending) return;
    if (!state.rules.length) {
      toast('请先在右侧登记一个人物');
      return;
    }
    var rule = findRule(el.selRule.value);
    if (!rule) return;

    var clash = overlapsExistingSelection(pending.start, pending.end);
    if (clash) {
      toast('该片段与已有的显式框选（人物「' + clash.code + '」）重叠，显式框选不可重叠');
      return;
    }

    rule.selections.push({ start: pending.start, end: pending.end });
    state.pending = null;
    el.toolbar.hidden = true;
    window.getSelection().removeAllRanges();
    render();
    var result = Anonymizer.anonymize(state.text, state.rules);
    var idx = result.hits.findIndex(function (h) {
      return h.type === 'explicit' && h.ruleId === rule.id &&
        h.start === pending.start && h.end === pending.end;
    });
    if (idx >= 0) markActive(idx, true);
    toast('已将框选片段登记给「' + rule.code + '」（显式框选优先）');
  }

  /* ---------------- 规则操作 ---------------- */
  function addRule(code, aliases) {
    code = code.trim();
    if (!code) {
      toast('请填写统一代号');
      return false;
    }
    if (state.rules.some(function (r) { return r.code === code; })) {
      toast('代号「' + code + '」已存在');
      return false;
    }
    var owner = null;
    aliases.some(function (a) {
      var r = state.rules.filter(function (rr) {
        return rr.aliases.indexOf(a) !== -1;
      })[0];
      if (r) owner = { alias: a, rule: r };
      return !!r;
    });
    if (owner) {
      toast('称呼「' + owner.alias + '」已属于人物「' + owner.rule.code + '」');
      return false;
    }

    state.rules.push({
      id: nextId(),
      code: code,
      aliases: aliases,
      selections: [],
    });
    state.undoStack.push({ id: state.rules[state.rules.length - 1].id, code: code });
    render();
    toast('已登记人物「' + code + '」');
    return true;
  }

  function undoLastRule() {
    var meta = state.undoStack.pop();
    if (!meta) return;
    var idx = state.rules.findIndex(function (r) {
      return r.id === meta.id;
    });
    if (idx !== -1) state.rules.splice(idx, 1);
    clearActive();
    render();
    toast('已撤销规则「' + meta.code + '」');
  }

  function inlineAddAlias(ruleId, anchor) {
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-add';
    input.placeholder = '称呼，回车确认';
    anchor.replaceWith(input);
    input.focus();

    function commit() {
      var values = splitAliases(input.value);
      var rule = findRule(ruleId);
      if (!rule) {
        render();
        return;
      }
      if (!values.length) {
        render();
        return;
      }
      var dupInRule = values.filter(function (a) {
        return rule.aliases.indexOf(a) !== -1;
      });
      var conflict = null;
      values.forEach(function (a) {
        if (conflict) return;
        var other = state.rules.filter(function (r) {
          return r.id !== ruleId && r.aliases.indexOf(a) !== -1;
        })[0];
        if (other) conflict = { alias: a, rule: other };
      });
      if (conflict) {
        toast('称呼「' + conflict.alias + '」已属于人物「' + conflict.rule.code + '」');
        return;
      }
      values.forEach(function (a) {
        if (rule.aliases.indexOf(a) === -1) rule.aliases.push(a);
      });
      render();
      if (!dupInRule.length) toast('已添加称呼');
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        render();
      }
    });
    input.addEventListener('blur', function () {
      setTimeout(render, 120);
    });
  }

  /* ---------------- 示例 / 载入 ---------------- */
  function loadSample(closeOverlay) {
    fetch('/api/sample')
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        state.text = data.text;
        state.rules = data.rules.map(function (r) {
          return {
            id: r.id || nextId(),
            code: r.code,
            aliases: r.aliases.slice(),
            selections: r.selections.map(function (s) {
              return { start: s.start, end: s.end };
            }),
          };
        });
        state.undoStack = []; // 示例规则不参与撤销栈
        state.pending = null;
        state.activeIndex = -1;
        if (closeOverlay) el.overlay.hidden = true;
        el.toolbar.hidden = true;
        render();
        toast('已加载内置示例');
      })
      .catch(function () {
        toast('示例加载失败');
      });
  }

  /* ---------------- 事件绑定 ---------------- */
  // 原稿框选
  document.addEventListener('selectionchange', refreshToolbar);
  el.srcPane.addEventListener('mousedown', function (e) {
    // 点在空白/普通文字上时清除上一次高亮；点在命中片段上交给 click 做双向联动
    if (!e.target.closest('.hit')) clearActive();
  });

  // 浮层按钮按下时不要夺走选区
  el.toolbar.addEventListener('mousedown', function (e) {
    e.preventDefault();
  });
  el.selApply.addEventListener('click', applyPendingSelection);

  // 两侧片段点击 → 双向高亮
  function bindPaneClick(container) {
    container.addEventListener('click', function (e) {
      var hit = e.target.closest('.hit');
      if (hit) {
        markActive(parseInt(hit.getAttribute('data-i'), 10), false);
      } else {
        clearActive();
      }
    });
  }
  bindPaneClick(el.srcContent);
  bindPaneClick(el.prevContent);

  // 规则列表事件委托
  el.rulesList.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var ruleId = btn.getAttribute('data-rule');
    var rule = findRule(ruleId);

    if (action === 'del-rule') {
      if (!rule) return;
      if (!window.confirm('删除人物「' + rule.code + '」的整条规则？')) return;
      state.rules.splice(state.rules.indexOf(rule), 1);
      state.undoStack = state.undoStack.filter(function (m) {
        return m.id !== ruleId;
      });
      clearActive();
      render();
      toast('已删除规则');
      return;
    }
    if (!rule) return;

    if (action === 'del-alias') {
      var alias = decodeURIComponent(btn.getAttribute('data-alias'));
      rule.aliases = rule.aliases.filter(function (a) {
        return a !== alias;
      });
      render();
      return;
    }

    if (action === 'del-sel') {
      var idx = parseInt(btn.getAttribute('data-idx'), 10);
      rule.selections.splice(idx, 1);
      render();
      return;
    }

    if (action === 'loc-sel') {
      var sIdx = parseInt(btn.getAttribute('data-idx'), 10);
      var sel = rule.selections[sIdx];
      if (!sel) return;
      var result = Anonymizer.anonymize(state.text, state.rules);
      var hIdx = result.hits.findIndex(function (h) {
        return h.start === sel.start && h.end === sel.end;
      });
      if (hIdx >= 0) markActive(hIdx, true);
      return;
    }

    if (action === 'add-alias') {
      inlineAddAlias(ruleId, btn);
    }
  });

  // 新人物表单
  el.ruleForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var aliases = splitAliases(el.inputAliases.value);
    if (addRule(el.inputCode.value, aliases)) {
      el.inputCode.value = '';
      el.inputAliases.value = '';
      el.inputCode.focus();
    }
  });

  el.btnUndo.addEventListener('click', undoLastRule);

  el.btnClear.addEventListener('click', function () {
    if (!state.rules.length) {
      toast('当前没有规则');
      return;
    }
    if (!window.confirm('清空全部人物规则？（原稿保留）')) return;
    state.rules = [];
    state.undoStack = [];
    state.pending = null;
    clearActive();
    render();
    toast('已清空规则');
  });

  el.btnSampleTop.addEventListener('click', function () {
    if (state.rules.length && !window.confirm('加载示例将替换当前原稿与规则，是否继续？')) return;
    loadSample(el.overlay.hidden);
  });
  el.btnSampleEntry.addEventListener('click', function () {
    loadSample(true);
  });

  el.btnLoad.addEventListener('click', function () {
    var txt = el.entryTextarea.value;
    if (!txt.trim()) {
      toast('请先粘贴原稿内容');
      return;
    }
    state.text = txt;
    state.rules = [];
    state.undoStack = [];
    state.pending = null;
    state.activeIndex = -1;
    el.overlay.hidden = true;
    render();
    toast('原稿已载入，可在左侧框选片段');
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      state.pending = null;
      el.toolbar.hidden = true;
      window.getSelection().removeAllRanges();
      clearActive();
    }
  });

  /* ---------------- 初始 ---------------- */
  render();
})();
