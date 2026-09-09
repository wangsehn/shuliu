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

  /* 空记录共享 shim：fastSet 对空数组免分配（indexOf 恒 -1） */
  var EMPTY_IDX_SHIM = { indexOf: function () { return -1; } };

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
  /* wcache 查表（effectiveWeight 纯函数的预计算值），未命中回退现算 */
  function effW(wcache, user, t, now) {
    if (wcache) {
      var v = wcache[t];
      if (v !== undefined) return v;
    }
    return effectiveWeight(user, t, now);
  }
  function reasonFor(p, user, now, wcache) {
    now = now || Date.now();
    if (has(user.liked, p.passageId) || has(user.saved, p.passageId)) return '和你喜欢过的内容相似';
    var topics = (p && p.topics) || [];
    var i, t;
    for (i = 0; i < topics.length; i++) {
      t = topics[i];
      if (typeof user.topicWeights[t] === 'number' && user.topicWeights[t] > 0 && effW(wcache, user, t, now) > 0.5) {
        return '因为你喜欢过「' + t + '」相关内容';
      }
    }
    for (i = 0; i < topics.length; i++) {
      t = topics[i];
      if (has(user.interests, t) && effW(wcache, user, t, now) > 0.5) {
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
  /* 放下 m 条同书所需的最小槽位数（每 5 窗 ≤2 且不连续的最优排列）：
     m=1→1, 2→3, 3→6, 4→8, 5→11 …（成对放置，每对占 5 槽） */
  function minSpan(m) {
    var pairs = Math.floor(m / 2);
    return m % 2 === 0 ? 5 * pairs - 2 : 5 * pairs + 1;
  }

  function assemble(ranked, limit, user, now) {
    /* 百本库性能改造（4636 条池）：语义与逐槽贪心完全一致。数据结构：
       - 存活候选维护为双向链表（O(1) 摘除，仍按 ranked 序遍历），取代 nextAlive 死前缀重扫；
       - 探索项单独维护一条 ranked 序存活链：needExplore 槽位直接取链首可行项，
         免去在全量存活表中线性寻找分散于分数尾部的探索项（exp 标记由 buildFeed 预算）；
       - 每书 FIFO 队列 + 头指针（头指针只前进，O(1) 摊还），取代 q.shift() 的 O(队列长) 搬移；
       - 紧急书按（剩余数降序, 首现序升序）维护（每槽仅消费之书需重新就位），逐槽只走满足
         minSpan ≥ slotsLeft−2 的连续前缀，取代每槽 for..in 全表重建 + 排序；
       - bookId 在入口一次性映射为整数序号，queues/counts/rank/pos/bookOrder 全部按整数
         下标存取（数组读代替每槽多次字符串哈希查找），候选对象附带 .b 书序号供约束比较。 */
    var out = [];
    var n = ranked.length;
    var alive = new Array(n);
    var nxt = new Array(n);
    var prv = new Array(n);
    var expNxt = new Array(n);   /* 探索项专用存活链（ranked 序） */
    var expPrv = new Array(n);
    var expHead = -1;
    var bInt = {};               /* bookId -> 整数序号（仅初始化期使用） */
    var bCount = [];             /* 书序号 -> 剩余条数 */
    var bRank = [];              /* 书序号 -> 首次出现序（等量书的稳定 tie-break） */
    var bPos = [];               /* 书序号 -> 在 bookOrder 中的下标 */
    var bQ = [];                 /* 书序号 -> [下标…]（按 ranked 顺序） */
    var bQh = [];                /* 书序号 -> 队首指针 */
    var bookOrder = [];          /* count>0 的书序号，按（剩余数降序, 首现序升序）维护 */
    var k, i, b;
    for (k = 0; k < n; k++) {
      alive[k] = 1;
      nxt[k] = k + 1 < n ? k + 1 : -1;
      prv[k] = k - 1;
      var bid = ranked[k].p.bookId;
      b = bInt[bid];
      if (b === undefined) { b = bCount.length; bInt[bid] = b; }
      ranked[k].b = b;
      (bQ[b] || (bQ[b] = [])).push(k);
      if (!bCount[b]) { bRank[b] = bookOrder.push(b) - 1; bPos[b] = bRank[b]; }
      bCount[b] = (bCount[b] || 0) + 1;
    }
    /* 探索链按 ranked 序串接（反向遍历 + 头插 → 升序） */
    for (k = n - 1; k >= 0; k--) {
      if (ranked[k].exp) {
        expNxt[k] = expHead; expPrv[k] = -1;
        if (expHead >= 0) expPrv[expHead] = k;
        expHead = k;
      }
    }
    bookOrder.sort(function (x, y) { return bCount[y] - bCount[x]; });
    for (k = 0; k < bookOrder.length; k++) bPos[bookOrder[k]] = k;
    var aliveHead = n > 0 ? 0 : -1;
    var relaxedBookCount = 0;

    function unlink(i) {
      if (prv[i] >= 0) nxt[prv[i]] = nxt[i]; else aliveHead = nxt[i];
      if (nxt[i] >= 0) prv[nxt[i]] = prv[i];
      if (ranked[i].exp) {
        if (expPrv[i] >= 0) expNxt[expPrv[i]] = expNxt[i]; else expHead = expNxt[i];
        if (expNxt[i] >= 0) expPrv[expNxt[i]] = expPrv[i];
      }
      alive[i] = 0;
    }

    function bookOk(item) {
      /* 内联书约束检查（同书不连续 + 5 窗 ≤2），整数序号比较 */
      var m = out.length;
      if (m > 0 && out[m - 1].b === item.b) return false;
      var c = 0;
      for (var j = Math.max(0, m - 4); j < m; j++) {
        if (out[j].b === item.b) c++;
      }
      return c < 2;
    }

    function last3AllHigh() {
      var L = out.length;
      if (L < 3) return false;
      for (var j = L - 3; j < L; j++) { if (out[j].exp) return false; }
      return true;
    }

    /* 该书队首（ranked 序最前的存活项）；头指针只前进，摊还 O(1) */
    function headOf(book) {
      var q = bQ[book], h = bQh[book] || 0;
      while (h < q.length && !alive[q[h]]) h++;
      bQh[book] = h;
      return h < q.length ? q[h] : -1;
    }

    while (out.length < limit) {
      var slotsLeft = Math.min(limit - out.length, n - out.length);
      /* 尾部容量保护（紧急度）：某书剩余条数的最小占用跨度接近/超过剩余槽位时，
         再不占位违规将不可避免（贪心延迟会把大书堆到尾部造成被动违规）。
         紧急度 = minSpan(count) − slotsLeft，≥ −2 视为临界，按紧急度从高到低提前占位。
         bookOrder 按剩余降序，紧急条件对降序序列连续成立，走前缀即可。 */
      var needExplore = last3AllHigh();
      var pick = -1, relaxed = 0;

      for (var oi = 0; oi < bookOrder.length; oi++) {
        var ob = bookOrder[oi];
        if (minSpan(bCount[ob]) < slotsLeft - 2) break;   /* 之后剩余更少，均不紧急 */
        var hi = headOf(ob);
        if (hi >= 0 && bookOk(ranked[hi])) {
          pick = hi;
          if (needExplore && !ranked[hi].exp) relaxed = 1;
          break;
        }
      }
      if (pick < 0) {
        if (needExplore) {
          /* 全量存活表中探索项分散于分数尾部，直接走探索链（同为 ranked 序，语义一致） */
          for (i = expHead; i >= 0; i = expNxt[i]) {
            if (bookOk(ranked[i])) { pick = i; break; }
          }
        } else {
          for (i = aliveHead; i >= 0; i = nxt[i]) {
            if (bookOk(ranked[i])) { pick = i; break; }
          }
        }
      }
      if (pick < 0 && needExplore) {
        relaxed = 1; /* 放宽探索约束，仍保书约束 */
        for (i = aliveHead; i >= 0; i = nxt[i]) {
          if (bookOk(ranked[i])) { pick = i; break; }
        }
      }
      if (pick < 0) {
        pick = aliveHead;
        if (pick < 0) break;
        relaxed = 2; relaxedBookCount++; /* 书约束也无法满足，兜底 */
      }
      var item = ranked[pick];
      unlink(pick);
      b = item.b;
      bCount[b]--;
      item.relaxed = relaxed;
      out.push(item);

      /* 维护紧急书序（剩余数降序, 首现序升序）：仅消费之书剩余减少，需向后就位；
         与原「每槽新鲜稳定排序」一致：越过剩余更多的书，以及剩余相同但首现更早的书；清零则移除。
         bPos[] 免去每槽 indexOf 的 O(书数) 扫描（移除/换位时同步维护） */
      var bi = bPos[b];
      if (bCount[b] === 0) {
        bookOrder.splice(bi, 1);
        for (k = bi; k < bookOrder.length; k++) bPos[bookOrder[k]] = k;
      } else {
        while (bi + 1 < bookOrder.length) {
          var nb = bookOrder[bi + 1];
          if (bCount[nb] > bCount[b] || (bCount[nb] === bCount[b] && bRank[nb] < bRank[b])) {
            bookOrder[bi] = nb;
            bookOrder[bi + 1] = b;
            bPos[b] = bi + 1;
            bPos[nb] = bi;
            bi++;
          } else break;
        }
      }
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

    /* 百本库：seen/hidden/liked/saved 随使用无上限增长，换 O(1) 成员查询，
       防止「片段数 × 记录长」的逐条 indexOf 二次方扫描（只影响本函数局部，不改外部数据）；
       空记录复用共享 shim，免 4 次 Set 分配 */
    function fastSet(arr) {
      if (!arr || arr.length === 0) return EMPTY_IDX_SHIM;
      var s = new Set(arr);
      return { indexOf: function (v) { return s.has(v) ? 0 : -1; } };
    }
    user.seen = fastSet(user.seen);
    user.hidden = fastSet(user.hidden);
    user.liked = fastSet(user.liked);
    user.saved = fastSet(user.saved);

    /* 百本库性能（4636 条池）：
       - 主题权重按主题缓存：effectiveWeight 为纯函数（仅依赖 topic/user/now），
         池中主题仅个位数，Math.pow 衰减从 O(条×主题) 次降为 O(主题) 次；
       - filter+map 合并为单遍；
       - affinity 每条只算一次，同时产出排序分与探索标记（exp 由 assemble 消费，
         isExplore = affinity <= exploreAffinity，与旧实现逐槽计算语义一致） */
    var topicW = {};
    var qw = CONFIG.qualityWeight, fw = CONFIG.freshnessWeight, sp = CONFIG.seenPenalty, ea = CONFIG.exploreAffinity;
    var hiddenSet = user.hidden, seenSet = user.seen;
    var candidates = [];
    for (var ci = 0; ci < passages.length; ci++) {
      var p = passages[ci];
      if (hiddenSet.indexOf(p.passageId) >= 0) continue;
      var topics = p.topics || [], a = 0, wv;
      for (var ti = 0; ti < topics.length; ti++) {
        var t = topics[ti];
        wv = topicW[t];
        if (wv === undefined) { wv = effectiveWeight(user, t, now); topicW[t] = wv; }
        if (wv > a) a = wv;
      }
      var q = p.qualityScore != null ? p.qualityScore : 0;
      var fresh = (maxDate && p.publishedAt) ? Math.min(1, p.publishedAt / maxDate) : 0;
      var seen = seenSet.indexOf(p.passageId) >= 0 ? 1 : 0;
      candidates.push({ p: p, exp: a <= ea, tie: random(),
        s: a + qw * q + fw * fresh - sp * seen });
    }
    candidates.sort(function (x, y) { return y.s - x.s || y.tie - x.tie; });

    var assembled = assemble(candidates, limit, user, now);
    return assembled.out.map(function (item) {
      var copy = Object.assign({}, item.p);
      copy.recommendationReason = reasonFor(item.p, user, now, topicW);
      /* 组装元信息：0=正常逐槽贪心 1=探索约束豁免 2=书约束兜底（供评估/调试，
         UI 不读取；百本库多轮反馈后探索池可能结构性耗尽，豁免必须显式可查） */
      copy.relaxed = item.relaxed;
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
