/* 书流 推荐引擎 v2 —— 内容过滤 + 隐式反馈加权（时间衰减）+ 探索位
   方案（评估版）：
     score(passage) = profile[topic] * decay(该主题最近一次反馈时间)
   反馈权重（CONFIG.deltas，全部可配置）：
     like +1.0 / save +1.2 / open_original +0.8 / continue_reading +0.6 / share +0.4 / view_complete(完读) +0.3
     unlike/unsave 等额撤销；not_interested −0.5（即时，并隐藏该片段）；
     quick_skip 不单独扣分——同一主题连续 2 次划走才记 −0.5（PRD 测试决策：快速划走不能单独造成过强负反馈）
   衰减：半衰期 7 天，正负权重对称地向 0 衰减（旧信号缓慢失效，允许用户改变兴趣）
   冷启动：显式兴趣按 1.0 权重、自 interestsAt（选择时间）起衰减；无兴趣时全部视为探索内容
   排序附加项（内容字段具备时生效，当前内容包暂无该数据，默认中性）：
     qualityScore * 0.15 + freshness * 0.10 − seen * 0.25
   组装硬约束（PRD 验收标准）：
     1) 不连续推荐同一本书；
     2) 任意连续 5 条中同一本书最多 2 条；
     3) 任意连续 4 条中至少 1 条低亲和（探索）卡片。
        前提：候选池中探索内容占比需 ≥ 1/4 才能全程满足；探索候选耗尽或与书约束冲突时，
        逐槽放宽探索约束（书约束仍尽量满足）；书约束也无法满足时按分数顺序兜底并计数。
   事件埋点：{id, type, passageId, position, at, sessionId, recVersion}，
     环形上限 CONFIG.eventCap（500 条，超出裁最旧）；加载时可用 sanitizeEvents 单条跳过损坏事件。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SHULIU_RECOMMENDER = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var RECO_VERSION = 'v2-decay-1';

  var CONFIG = {
    version: RECO_VERSION,
    halfLifeDays: 7,            /* 衰减半衰期（天） */
    exploreAffinity: 0.05,      /* 亲和低于该值视为探索内容 */
    seenPenalty: 0.25,          /* 已看过片段的排序惩罚 */
    qualityWeight: 0.15,        /* qualityScore 权重（缺省 0 分，中性） */
    freshnessWeight: 0.10,      /* freshness 权重（缺省 0 分，中性） */
    eventCap: 500,              /* 事件环形上限 */
    quickSkipStrikes: 2,        /* 同主题连续划走多少次才计负分 */
    baseInterestWeight: 1.0,    /* 冷启动显式兴趣权重 */
    deltas: {
      like: 1.0, save: 1.2, open_original: 0.8, continue_reading: 0.6,
      share: 0.4, view_complete: 0.3,
      unlike: -1.0, unsave: -1.2,
      not_interested: -0.5,
      quick_skip_strikes_penalty: -0.5  /* 连续 quickSkipStrikes 次后的单主题惩罚 */
    }
  };

  var HALF_LIFE_MS = CONFIG.halfLifeDays * 86400000;

  function cloneUser(user) {
    user = user || {};
    return {
      interests: (user.interests || []).slice(),
      interestsAt: user.interestsAt || 0,
      topicWeights: Object.assign({}, user.topicWeights || {}),
      topicLastTouched: Object.assign({}, user.topicLastTouched || {}),
      skipDebt: Object.assign({}, user.skipDebt || {}),
      liked: (user.liked || []).slice(), saved: (user.saved || []).slice(),
      hidden: (user.hidden || []).slice(), seen: (user.seen || []).slice(),
      events: (user.events || []).slice()
    };
  }

  function rng(seed) {
    var n = (seed == null ? Date.now() : seed) >>> 0;
    return function () { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; };
  }

  function has(list, value) { return (list || []).indexOf(value) >= 0; }

  /* 时间衰减：半衰期指数衰减，正负权重对称向 0 收敛 */
  function decayFactor(lastTouched, now) {
    if (!lastTouched || now <= lastTouched) return 1;
    return Math.pow(0.5, (now - lastTouched) / HALF_LIFE_MS);
  }

  /* 主题有效权重：显式反馈权重 × 衰减（含 0 与负值，正负对称衰减）；
     无任何显式反馈时回退冷启动兴趣权重 */
  function effectiveWeight(user, topic, now) {
    var w = user.topicWeights[topic];
    var ts = user.topicLastTouched[topic];
    if (typeof w === 'number') {
      return w * decayFactor(ts, now);
    }
    if (has(user.interests, topic)) {
      return CONFIG.baseInterestWeight * decayFactor(user.interestsAt || now, now);
    }
    return 0;
  }

  /* 片段亲和度：多主题取最大有效权重（方案公式 profile[topic]*decay 的多标签扩展） */
  function affinity(p, user, now) {
    var topics = (p && p.topics) || [];
    var best = 0;
    for (var i = 0; i < topics.length; i++) {
      var w = effectiveWeight(user, topics[i], now);
      if (w > best) best = w;
    }
    return best;
  }

  function isExplore(p, user, now) {
    return affinity(p, user, now) <= CONFIG.exploreAffinity;
  }

  /* 排序分：亲和度为主，质量/新鲜度为附加项（内容数据缺省时中性），已看惩罚 */
  function score(p, user, options) {
    var now = (options && options.now) || Date.now();
    var q = (p && p.qualityScore != null) ? p.qualityScore : 0;
    var fresh = (options && options.maxPublishedAt && p && p.publishedAt)
      ? Math.min(1, p.publishedAt / options.maxPublishedAt) : 0;
    var seen = user && has(user.seen, p.passageId) ? 1 : 0;
    return affinity(p, user, now) +
      CONFIG.qualityWeight * q +
      CONFIG.freshnessWeight * fresh -
      CONFIG.seenPenalty * seen;
  }

  /* 推荐理由：只能来自真实触发条件（PRD §6）。
     优先级：同 ID 喜欢/收藏 > 主题有正显式反馈（学到） > 声明兴趣（冷启动） > 探索文案 */
  function reasonFor(p, user, now) {
    now = now || Date.now();
    if (has(user.liked, p.passageId) || has(user.saved, p.passageId)) return '和你喜欢过的内容相似';
    var topics = (p && p.topics) || [];
    var i, t;
    for (i = 0; i < topics.length; i++) {
      t = topics[i];
      if (typeof user.topicWeights[t] === 'number' && user.topicWeights[t] > 0 && effectiveWeight(user, t, now) > 0.5) {
        return '因为你喜欢过「' + t + '」相关内容';
      }
    }
    for (i = 0; i < topics.length; i++) {
      t = topics[i];
      if (has(user.interests, t) && effectiveWeight(user, t, now) > 0.5) {
        return '因为你选择了「' + t + '」';
      }
    }
    return '给你一段新的文学发现';
  }

  /* ---------- 组装：单遍逐槽贪心 ----------
     对输出序列的每个槽位，从剩余候选中选「分数最高且可放置」者：
     - 书约束（连续同书 / 5 窗口同书 ≥3）不可违反；
     - 当前槽位若会与前 3 条构成全高亲和的 4 窗口，则本槽必须放探索卡；
     - 探索卡不存在或全部与书约束冲突时，放宽探索约束、保书约束；
     - 书约束也无法满足（池子结构耗尽）时按分数兜底并计数（relaxedBookCount 供评估）。
     逐槽选择避免了「延迟项集中补到尾部」造成的长段高亲和聚集。 */
  function violatesBookRules(out, p) {
    var n = out.length;
    if (n > 0 && out[n - 1].p.bookId === p.bookId) return true;      /* 不连续同书 */
    var c = 0;
    for (var i = Math.max(0, n - 4); i < n; i++) {
      if (out[i].p.bookId === p.bookId) c++;
    }
    return c >= 2;                                                    /* 5 窗口同书 ≤2 */
  }

  /* 放下 m 条同书所需的最小槽位数（每 5 窗 ≤2 且不连续的最优排列）：
     m=1→1, 2→3, 3→6, 4→8, 5→11 …（成对放置，每对占 5 槽） */
  function minSpan(m) {
    var pairs = Math.floor(m / 2);
    return m % 2 === 0 ? 5 * pairs - 2 : 5 * pairs + 1;
  }

  function assemble(ranked, limit, user, now) {
    var out = [];
    var remaining = ranked.slice(); /* 与 ranked 共享 item 引用 */
    var relaxedBookCount = 0;

    function bookOk(p) { return !violatesBookRules(out, p); }

    function last3AllHigh() {
      if (out.length < 3) return false;
      for (var i = out.length - 3; i < out.length; i++) {
        if (isExplore(out[i].p, user, now)) return false;
      }
      return true;
    }

    while (out.length < limit && remaining.length) {
      var slotsLeft = Math.min(limit - out.length, remaining.length);
      /* 尾部容量保护（紧急度）：某书剩余条数的最小占用跨度接近/超过剩余槽位时，
         再不占位违规将不可避免（贪心延迟会把大书堆到尾部造成被动违规）。
         紧急度 = minSpan(count) − slotsLeft，≥ −2 视为临界，按紧急度从高到低提前占位。 */
      var counts = {};
      remaining.forEach(function (it) { counts[it.p.bookId] = (counts[it.p.bookId] || 0) + 1; });
      var urgent = [];
      for (var b in counts) {
        var u = minSpan(counts[b]) - slotsLeft;
        if (u >= -2) urgent.push({ book: b, u: u, n: counts[b] });
      }
      urgent.sort(function (x, y) { return y.u - x.u || y.n - x.n; });

      var needExplore = last3AllHigh();
      var pick = -1, relaxed = 0, i;

      for (var ui = 0; ui < urgent.length && pick < 0; ui++) {
        for (i = 0; i < remaining.length; i++) {
          var rp = remaining[i].p;
          if (rp.bookId === urgent[ui].book && bookOk(rp)) {
            pick = i;
            if (needExplore && !isExplore(rp, user, now)) relaxed = 1;
            break;
          }
        }
      }
      if (pick < 0) {
        for (i = 0; i < remaining.length; i++) {
          if (bookOk(remaining[i].p) && (!needExplore || isExplore(remaining[i].p, user, now))) { pick = i; break; }
        }
      }
      if (pick < 0 && needExplore) {
        relaxed = 1; /* 放宽探索约束，仍保书约束 */
        for (i = 0; i < remaining.length; i++) {
          if (bookOk(remaining[i].p)) { pick = i; break; }
        }
      }
      if (pick < 0) {
        relaxed = 2; relaxedBookCount++; /* 书约束也无法满足，兜底 */
        pick = 0;
      }
      var item = remaining.splice(pick, 1)[0];
      item.relaxed = relaxed;
      out.push(item);
    }
    return { out: out, relaxedBookCount: relaxedBookCount };
  }

  /* ---------- 主入口：全量排序 + 组装。options: {limit, seed, now} ---------- */
  function buildFeed(passages, user, options) {
    options = options || {};
    user = cloneUser(user);
    var now = options.now || Date.now();
    var limit = options.limit == null ? passages.length : options.limit;
    var random = rng(options.seed);
    var maxDate = 0;
    passages.forEach(function (p) { if (p.publishedAt > maxDate) maxDate = p.publishedAt; });

    var candidates = passages.filter(function (p) { return !has(user.hidden, p.passageId); })
      .map(function (p) {
        return { p: p, s: score(p, user, { now: now, maxPublishedAt: maxDate }), tie: random() };
      })
      .sort(function (a, b) { return b.s - a.s || b.tie - a.tie; });

    var assembled = assemble(candidates, limit, user, now);
    return assembled.out.map(function (item) {
      var copy = Object.assign({}, item.p);
      copy.recommendationReason = reasonFor(item.p, user, now);
      return copy;
    });
  }

  /* ---------- 反馈：画像更新 + 事件落账 ---------- */
  var idSeq = 0;
  function genId(at) {
    idSeq = (idSeq + 1) % 1000;
    return 'ev-' + at.toString(36) + '-' + idSeq + '-' + Math.floor(Math.random() * 1e6).toString(36);
  }

  function clampWeight(w) {
    return Math.max(-4, Math.min(4, w));
  }

  /* event: {type, passage, at?, position?, sessionId?}
     返回新 user；事件对象补全 id/recVersion 后入环形队列。 */
  function applyFeedback(user, event) {
    var next = cloneUser(user);
    var p = (event && event.passage) || {};
    var type = event && event.type;
    var at = (event && event.at) || Date.now();
    var topics = p.topics || [];
    if (!type || !p.passageId || !topics.length) return next; /* 非法事件不入账 */

    var d = CONFIG.deltas;

    function bump(topic, delta) {
      next.topicWeights[topic] = clampWeight((next.topicWeights[topic] || 0) + delta);
      next.topicLastTouched[topic] = at;
      if (delta > 0) next.skipDebt[topic] = 0; /* 正向反馈清除划走连击 */
    }

    if (type === 'quick_skip') {
      topics.forEach(function (t) {
        var debt = (next.skipDebt[t] || 0) + 1;
        if (debt >= CONFIG.quickSkipStrikes) {
          bump(t, d.quick_skip_strikes_penalty);
          next.skipDebt[t] = 0;
        } else {
          next.skipDebt[t] = debt;
          next.topicLastTouched[t] = at;
        }
      });
    } else if (type === 'not_interested') {
      topics.forEach(function (t) { bump(t, d.not_interested); });
      if (!has(next.hidden, p.passageId)) next.hidden.push(p.passageId);
    } else if (d[type] != null) {
      topics.forEach(function (t) { bump(t, d[type]); });
    } else {
      /* 未登记类型：只记账，不影响画像 */
      topics.forEach(function (t) { next.topicLastTouched[t] = at; });
    }

    if (type !== 'not_interested' && !has(next.seen, p.passageId)) next.seen.push(p.passageId);

    next.events.push({
      id: (event && event.id) || genId(at),
      type: type,
      passageId: p.passageId,
      position: typeof (event && event.position) === 'number' ? event.position : -1,
      at: at,
      sessionId: (event && event.sessionId) || 0,
      recVersion: RECO_VERSION,
      topic: topics[0] || ''
    });
    if (next.events.length > CONFIG.eventCap) {
      next.events = next.events.slice(-CONFIG.eventCap);
    }
    return next;
  }

  /* 损坏容忍（PRD 测试决策：单条损坏事件可被跳过并记录） */
  function sanitizeEvents(events) {
    var bad = 0;
    var ok = (events || []).filter(function (e) {
      var valid = e && typeof e.type === 'string' && typeof e.passageId === 'string' && typeof e.at === 'number';
      if (!valid) bad++;
      return valid;
    });
    ok.badCount = bad;
    return ok;
  }

  return {
    RECO_VERSION: RECO_VERSION,
    CONFIG: CONFIG,
    buildFeed: buildFeed,
    score: score,
    affinity: affinity,
    effectiveWeight: effectiveWeight,
    decayFactor: decayFactor,
    reasonFor: reasonFor,
    applyFeedback: applyFeedback,
    cloneUser: cloneUser,
    sanitizeEvents: sanitizeEvents
  };
});
