/*
 * anonymizer.js —— 匿名化核心引擎（浏览器 / Node 通用，UMD）
 *
 * 规则模型：
 *   rule = {
 *     id: string,          // 规则（人物）唯一 id
 *     code: string,        // 统一代号
 *     aliases: string[],   // 该人物的多个称呼
 *     selections: [{start, end}],  // 用户在原稿上显式框选的字符区间（半开区间）
 *   }
 *
 * 命中优先级：
 *   1) 显式框选优先于称呼自动命中；
 *   2) 同为称呼命中时，更长的称呼优先（最长称呼优先）；
 *   3) 同长度冲突取先出现者；
 *   4) 同一显式区间被多个人物声明时，先登记的人物生效。
 *
 * 输出不改动原稿：preview 为新字符串，命中处替换为【代号】，
 * 同时维护「原稿字符区间 ↔ 预览字符区间」的双向映射。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Anonymizer = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function normalizeRules(rules) {
    return (rules || []).map(function (r) {
      var aliasMap = Object.create(null);
      (r.aliases || []).forEach(function (a) {
        a = String(a == null ? '' : a);
        if (a.length > 0 && !Object.prototype.hasOwnProperty.call(aliasMap, a)) {
          aliasMap[a] = true;
        }
      });
      var seen = Object.create(null);
      var selections = (r.selections || [])
        .map(function (s) {
          return { start: s.start | 0, end: s.end | 0 };
        })
        .filter(function (s) {
          var key = s.start + ':' + s.end;
          if (s.end <= s.start || seen[key]) return false;
          seen[key] = true;
          return true;
        });
      return {
        id: String(r.id),
        code: String(r.code == null ? '' : r.code),
        aliases: Object.keys(aliasMap),
        selections: selections,
      };
    });
  }

  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  /**
   * 主入口：anonymize(text, rules)
   * 返回 {
   *   text, preview,
   *   hits: [{start,end, ruleId, code, type:'explicit'|'alias', alias?}],
   *   segments: 原稿被命中切成的顺序片段，
   *             [{origStart,origEnd,prevStart,prevEnd, hitIndex|null, kind:'plain'|'hit'}],
   * }
   */
  function anonymize(text, rawRules) {
    text = String(text == null ? '' : text);
    var rules = normalizeRules(rawRules);
    var n = text.length;
    var hits = [];

    // ---- 1. 收集显式框选命中（规则登记顺序即优先级，跨规则重叠先登记者胜）----
    var explicit = [];
    rules.forEach(function (rule) {
      rule.selections.forEach(function (sel) {
        var start = Math.max(0, sel.start);
        var end = Math.min(n, sel.end);
        if (end <= start) return;
        var clash = explicit.some(function (e) {
          return overlaps(start, end, e.start, e.end);
        });
        if (clash) return; // 显式框选之间：先登记优先，拒绝后到者
        explicit.push({
          start: start,
          end: end,
          ruleId: rule.id,
          code: rule.code,
          type: 'explicit',
        });
      });
    });

    // ---- 2. 收集所有称呼的全部出现位置 ----
    var aliasHits = [];
    rules.forEach(function (rule) {
      rule.aliases.forEach(function (alias) {
        if (!alias) return;
        var from = 0;
        var idx;
        while ((idx = text.indexOf(alias, from)) !== -1) {
          aliasHits.push({
            start: idx,
            end: idx + alias.length,
            len: alias.length,
            ruleId: rule.id,
            code: rule.code,
            type: 'alias',
            alias: alias,
          });
          from = idx + 1; // 允许重叠出现（不同称呼之间再按优先级裁决）
        }
      });
    });

    // ---- 3. 称呼自动命中：最长称呼优先；同长度按位置，位置相同按先扫描到者 ----
    aliasHits.sort(function (a, b) {
      if (b.len !== a.len) return b.len - a.len;
      if (a.start !== b.start) return a.start - b.start;
      return 0;
    });

    var occupied = explicit.map(function (e) {
      return { start: e.start, end: e.end };
    }); // 显式区间整体占位 → 显式优先
    var chosenAlias = [];
    aliasHits.forEach(function (cand) {
      var clash = occupied.some(function (o) {
        return overlaps(cand.start, cand.end, o.start, o.end);
      });
      if (clash) return;
      occupied.push({ start: cand.start, end: cand.end });
      chosenAlias.push(cand);
    });

    hits = explicit.concat(chosenAlias).sort(function (a, b) {
      return a.start - b.start || a.end - b.end;
    });

    // ---- 4. 切片：原稿保持不变，逐段构造预览，并建立双向字符区间映射 ----
    var segments = [];
    var preview = '';
    var cursor = 0;
    var prevPos = 0;
    hits.forEach(function (hit, i) {
      if (hit.start > cursor) {
        var plain = text.slice(cursor, hit.start);
        segments.push({
          origStart: cursor,
          origEnd: hit.start,
          prevStart: prevPos,
          prevEnd: prevPos + plain.length,
          kind: 'plain',
          hitIndex: null,
        });
        preview += plain;
        prevPos += plain.length;
      }
      var token = '【' + hit.code + '】';
      segments.push({
        origStart: hit.start,
        origEnd: hit.end,
        prevStart: prevPos,
        prevEnd: prevPos + token.length,
        kind: 'hit',
        hitIndex: i,
      });
      preview += token;
      prevPos += token.length;
      cursor = hit.end;
    });
    if (cursor < n) {
      var tail = text.slice(cursor);
      segments.push({
        origStart: cursor,
        origEnd: n,
        prevStart: prevPos,
        prevEnd: prevPos + tail.length,
        kind: 'plain',
        hitIndex: null,
      });
      preview += tail;
    }

    return { text: text, preview: preview, hits: hits, segments: segments };
  }

  // ---- 双向映射辅助 ----

  /** 原稿偏移 -> 命中索引（未命中返回 -1） */
  function origOffsetToHitIndex(result, offset) {
    return locate(result.segments, offset, 'orig');
  }

  /** 预览偏移 -> 命中索引（未命中返回 -1） */
  function previewOffsetToHitIndex(result, offset) {
    return locate(result.segments, offset, 'prev');
  }

  function locate(segments, offset, side) {
    if (!segments.length) return -1;
    // 末位偏移落在片段末端时，归属包含该末端的片段（命中片段优先）
    var lo = 0;
    var hi = segments.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var s = segments[mid];
      var a = side === 'orig' ? s.origStart : s.prevStart;
      var b = side === 'orig' ? s.origEnd : s.prevEnd;
      if (offset < a) hi = mid - 1;
      else if (offset >= b) lo = mid + 1;
      else break;
    }
    if (lo > hi) {
      // offset 恰好等于某片段末端：向前找一个以该偏移为起点的片段
      var idx = Math.min(lo, segments.length - 1);
      if (idx >= 0) {
        var t = segments[idx];
        var ta = side === 'orig' ? t.origStart : t.prevStart;
        if (ta === offset && t.kind === 'hit') return t.hitIndex;
      }
      if (idx > 0) {
        var u = segments[idx - 1];
        if (u.kind === 'hit') return u.hitIndex;
      }
      return -1;
    }
    var seg = segments[(lo + hi) >> 1];
    return seg.kind === 'hit' ? seg.hitIndex : -1;
  }

  /** 原稿命中区间 -> 预览区间 */
  function origToPreview(result, start, end) {
    var a = findEdge(result.segments, start, 'origStart', 'prevStart');
    var b = findEdge(result.segments, end, 'origEnd', 'prevEnd');
    return { start: a, end: b };
  }

  /** 预览命中区间 -> 原稿区间 */
  function previewToOrig(result, start, end) {
    var a = findEdge(result.segments, start, 'prevStart', 'origStart');
    var b = findEdge(result.segments, end, 'prevEnd', 'origEnd');
    return { start: a, end: b };
  }

  function findEdge(segments, value, fromKey, toKey) {
    // 边界值在相邻片段间相等（未命中区域），二分取任意匹配即可
    if (!segments.length) return value;
    var lo = 0;
    var hi = segments.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (segments[mid][fromKey] < value) lo = mid + 1;
      else hi = mid;
    }
    var seg = segments[lo];
    if (seg && seg[fromKey] === value) return seg[toKey];
    // 末端边界：尝试上一片段
    if (lo > 0 && segments[lo - 1][fromKey] === value) return segments[lo - 1][toKey];
    return seg ? seg[toKey] : value;
  }

  return {
    anonymize: anonymize,
    normalizeRules: normalizeRules,
    origOffsetToHitIndex: origOffsetToHitIndex,
    previewOffsetToHitIndex: previewOffsetToHitIndex,
    origToPreview: origToPreview,
    previewToOrig: previewToOrig,
  };
});
