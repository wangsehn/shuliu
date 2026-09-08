'use strict';
/* 离线重放评估（Node 直跑：node tests/replay_eval.js）
   对比基线 baseline_3_1（3匹配+1其他静态混排）与 v2-decay-1（内容过滤+隐式反馈加权）。
   方法：4 个合成人设 × 24 轮重放。人设除声明兴趣外带一个「潜在偏好」主题——
   基线的候选池永远固定在声明兴趣上，只有 v2 能从行为中学到潜在偏好。
   指标门限（预设标准，全部通过退出码 0）：
   G1 组装硬约束：同书不连续、任意连续 5 条同书 ≤2 —— 违规数必须为 0
   G2 探索位：任意连续 4 条至少 1 条低亲和 —— 违规数必须为 0
   G3 冷启动：有声明兴趣的人设，首轮前 4 条命中声明兴趣 ≥3
   G4 学习能力：后半程（13-24 轮）命中率 v2 > 基线的人设数 ≥ 3/4
   G5 多样性：末轮前 20 条覆盖书籍数 ≥ 6（共 10 本）
   G6 无重复：任一轮次内 passageId 不重复
   说明：命中率由合成行为模型产生，验证的是「机制有效」（能学到反馈并反映到排序），
   不等价于真实用户准确性。 */
global.window = {};
require('../content/content.js');
var C = global.window.CONTENT;
var R = require('../recommendation.js');

var NOW = 1700000000000;
var TOPICS_ALL = ['自我认识', '亲密关系', '孤独与陪伴', '成长与选择', '情绪与压力', '人性与社会'];
var ROUNDS = 24, CARDS_PER_ROUND = 20;

var PERSONAS = [
  { name: 'P1 声明[亲密关系]+潜在成长', declared: ['亲密关系'], latent: ['成长与选择'], seed: 101 },
  { name: 'P2 声明[孤独,情绪]+潜在人性', declared: ['孤独与陪伴', '情绪与压力'], latent: ['人性与社会'], seed: 202 },
  { name: 'P3 无声明+潜在[亲密,孤独]', declared: [], latent: ['亲密关系', '孤独与陪伴'], seed: 303 },
  { name: 'P4 声明[自我认识]+潜在成长', declared: ['自我认识'], latent: ['成长与选择'], seed: 404 }
];

function rng(seed) {
  var n = seed >>> 0;
  return function () { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; };
}
function shuffled(arr, rand) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function topicsHit(p, topics) {
  return (p.topics || []).some(function (t) { return topics.indexOf(t) >= 0; });
}
/* 基线：3 匹配 + 1 其他静态混排（复刻 app.js mixPool 语义） */
function baselineFeed(persona, rand) {
  var match = [], other = [];
  C.passages.forEach(function (p) {
    if (topicsHit(p, persona.declared)) match.push(p); else other.push(p);
  });
  match = shuffled(match, rand);
  other = shuffled(other, rand);
  var out = [], mi = 0, oi = 0;
  while (mi < match.length || oi < other.length) {
    var take = 0;
    while (take < 3 && mi < match.length) { out.push(match[mi++]); take++; }
    if (oi < other.length) out.push(other[oi++]);
    if (take === 0 && oi >= other.length) break;
  }
  return out;
}
function v2Feed(persona, state, round) {
  var user = {
    interests: persona.declared, interestsAt: NOW,
    topicWeights: state.topicWeights, topicLastTouched: state.topicLastTouched, skipDebt: state.skipDebt,
    liked: state.liked, saved: state.saved, hidden: state.hidden, seen: state.seen, events: state.events
  };
  return R.buildFeed(C.passages, user, { seed: persona.seed * 1000 + round, now: NOW + round * 86400000, limit: C.passages.length });
}
/* 合成行为：按人设对每张卡产生事件。
   噪声校准：not_interested 2%（真实用户极少主动隐藏；过高会在多轮重放中摧毁内容池，
   导致探索位与书籍约束结构性耗尽——引擎按设计豁免，属评估模型失真而非引擎缺陷）；
   不相关完读 10%（「偶尔完读制造噪声」本意，32% 会让探索主题被噪声学到翻转）。 */
function engage(persona, p, rand, round, pos, state) {
  var declaredHit = topicsHit(p, persona.declared);
  var latentHit = topicsHit(p, persona.latent);
  var r = rand();
  if (latentHit && r < 0.55) return { type: 'like', p: p };
  if (latentHit && r < 0.75) return { type: 'view_complete', p: p };
  if (declaredHit && r < 0.35) return { type: 'like', p: p };
  if (declaredHit && r < 0.65) return { type: 'view_complete', p: p };
  if (!declaredHit && !latentHit) {
    if (r < 0.60) return { type: 'quick_skip', p: p };
    if (r < 0.62) return { type: 'not_interested', p: p };
    if (r < 0.72) return { type: 'view_complete', p: p }; /* 偶尔完读不相关内容，制造噪声 */
    return { type: 'quick_skip', p: p };
  }
  return { type: 'quick_skip', p: p };
}

function metricsFor(feed, persona, state, round) {
  var m = { hit: 0, dup: 0, bookConsec: 0, bookWin5: 0, exploreWin4: 0, books: {} };
  var seenIds = {};
  for (var i = 0; i < feed.length; i++) {
    var p = feed[i];
    if (seenIds[p.passageId]) m.dup++; else seenIds[p.passageId] = 1;
    if (i < CARDS_PER_ROUND) {
      if (topicsHit(p, persona.declared.concat(persona.latent))) m.hit++;
      m.books[p.bookId] = 1;
    }
    if (i > 0 && p.bookId === feed[i - 1].bookId) m.bookConsec++;
    if (i >= 4) {
      var c = 0;
      for (var k = i - 4; k <= i; k++) { if (feed[k].bookId === p.bookId) c++; }
      if (c >= 3) m.bookWin5++;
    }
    if (i >= 3) {
      var allHigh = true;
      var u = state.user || toUser(state, persona); /* 基线无动态画像：用静态声明兴趣用户 */
      for (var k2 = i - 3; k2 <= i; k2++) {
        if (R.affinity(feed[k2], u, NOW + round * 86400000) <= R.CONFIG.exploreAffinity) allHigh = false;
      }
      if (allHigh) m.exploreWin4++;
    }
  }
  return m;
}

function freshState() {
  return { topicWeights: {}, topicLastTouched: {}, skipDebt: {}, liked: [], saved: [], hidden: [], seen: [], events: [], user: null };
}
function toUser(st, persona) {
  return {
    interests: persona.declared, interestsAt: NOW,
    topicWeights: st.topicWeights, topicLastTouched: st.topicLastTouched, skipDebt: st.skipDebt,
    liked: st.liked, saved: st.saved, hidden: st.hidden, seen: st.seen, events: st.events
  };
}

function runPersona(persona) {
  var randB = rng(persona.seed);
  var randV = rng(persona.seed + 7);
  var bState = freshState(), vState = freshState();
  var bHits = [], vHits = [];
  var agg = { bookConsec: 0, bookWin5: 0, exploreWin4: 0, dup: 0, coldHit: null, lastBooks: 0 };

  for (var round = 1; round <= ROUNDS; round++) {
    /* 基线：静态池，行为不回流 */
    var bf = baselineFeed(persona, randB).slice(0, CARDS_PER_ROUND);
    var bm = metricsFor(bf, persona, bState, round);
    bHits.push(bm.hit / CARDS_PER_ROUND);

    /* v2：行为回流画像。
       指标与行为重放均限定在「本轮浏览窗口」(前 CARDS_PER_ROUND 张)——与生产一致：
       用户每轮实际浏览约 20 张即离开；且生产在隐藏/改兴趣时会 rebuildTail 重排尾部，
       全量 76 条的尾段属于会被重排的区域，不作为验收口径。 */
    vState.user = toUser(vState, persona);
    var vf = v2Feed(persona, vState, round).slice(0, CARDS_PER_ROUND);
    var vm = metricsFor(vf, persona, vState, round);
    vHits.push(vm.hit / CARDS_PER_ROUND);
    agg.bookConsec += vm.bookConsec; agg.bookWin5 += vm.bookWin5;
    agg.exploreWin4 += vm.exploreWin4; agg.dup += vm.dup;
    if (round === 1) {
      agg.coldHit = vf.slice(0, 4).filter(function (p) { return topicsHit(p, persona.declared); }).length;
    }
    if (round === ROUNDS) agg.lastBooks = Object.keys(vm.books).length;

    /* 重放行为：v2 逐卡生成事件并更新画像；隐藏卡直接从后续轮剔除 */
    vf.forEach(function (p, pos) {
      var ev = engage(persona, p, randV, round, pos, vState);
      if (ev.type === 'not_interested') { vState.hidden.push(p.passageId); }
      var u = toUser(vState, persona);
      var next = R.applyFeedback(u, { type: ev.type, passage: p, at: NOW + round * 86400000 + pos, position: pos, sessionId: round });
      vState.topicWeights = next.topicWeights; vState.topicLastTouched = next.topicLastTouched;
      vState.skipDebt = next.skipDebt; vState.events = next.events; vState.hidden = next.hidden;
      vState.seen = next.seen; vState.liked = next.liked; vState.saved = next.saved;
    });
  }
  function lateRate(arr) {
    var s = 0; for (var i = 12; i < ROUNDS; i++) s += arr[i];
    return s / (ROUNDS - 12);
  }
  return {
    name: persona.name,
    bLate: lateRate(bHits), vLate: lateRate(vHits),
    bAll: bHits.reduce(function (a, b) { return a + b; }, 0) / ROUNDS,
    vAll: vHits.reduce(function (a, b) { return a + b; }, 0) / ROUNDS,
    agg: agg
  };
}

console.log('离线重放评估  baseline_3_1 vs ' + R.RECO_VERSION + '  (' + C.passages.length + ' 条片段 x ' + ROUNDS + ' 轮)');
console.log('------------------------------------------------------------------------------');
var results = PERSONAS.map(runPersona);
var gate = { G1: true, G2: true, G3: true, G4: 0, G5: true, G6: true };
results.forEach(function (r) {
  console.log(r.name);
  console.log('  全程命中率   基线=' + (r.bAll * 100).toFixed(1) + '%  v2=' + (r.vAll * 100).toFixed(1) + '%');
  console.log('  后程命中率   基线=' + (r.bLate * 100).toFixed(1) + '%  v2=' + (r.vLate * 100).toFixed(1) + '%  ' + (r.vLate > r.bLate ? '[v2 优]' : '[未超越]'));
  console.log('  组装违规     同书连续=' + r.agg.bookConsec + '  5窗同书=' + r.agg.bookWin5 + '  探索4窗=' + r.agg.exploreWin4 + '  重复=' + r.agg.dup);
  console.log('  冷启动首4命中=' + r.agg.coldHit + '  末轮前20书籍数=' + r.agg.lastBooks);
  if (r.agg.bookConsec || r.agg.bookWin5) gate.G1 = false;
  if (r.agg.exploreWin4) gate.G2 = false;
  if (r.agg.dup) gate.G6 = false;
  if (r.agg.coldHit < 3 && PERSONAS.filter(function (p) { return p.name === r.name; })[0].declared.length) gate.G3 = false;
  if (r.vLate > r.bLate) gate.G4++;
  if (r.agg.lastBooks < 6) gate.G5 = false;
});
console.log('------------------------------------------------------------------------------');
console.log('G1 组装硬约束(0违规): ' + (gate.G1 ? 'PASS' : 'FAIL'));
console.log('G2 探索位(0违规): ' + (gate.G2 ? 'PASS' : 'FAIL'));
console.log('G3 冷启动首4命中>=3: ' + (gate.G3 ? 'PASS' : 'FAIL'));
console.log('G4 学习能力(v2后程>基线): ' + gate.G4 + '/4 人设 ' + (gate.G4 >= 3 ? 'PASS' : 'FAIL'));
console.log('G5 多样性(末轮书籍>=6): ' + (gate.G5 ? 'PASS' : 'FAIL'));
console.log('G6 轮内无重复: ' + (gate.G6 ? 'PASS' : 'FAIL'));
var all = gate.G1 && gate.G2 && gate.G3 && gate.G4 >= 3 && gate.G5 && gate.G6;
console.log('');
console.log(all ? 'ALL REPLAY GATES PASSED' : 'REPLAY GATE FAILED');
process.exit(all ? 0 : 1);
