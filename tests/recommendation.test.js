'use strict';
/* 推荐引擎 v2 单元测试（Node 直跑：node tests/recommendation.test.js）
   只验证外部行为（PRD 测试决策），不绑定内部实现数值细节。 */
var assert = require('assert');
var R = require('../recommendation.js');

var DAY = 86400000;
var T0 = 1700000000000;

/* 测试语料：5 本书、9 条片段、4 个主题 */
var P = [
  { passageId: 'a', bookId: 'b1', chapterId: 'b1-c1', topics: ['亲密关系'], text: 'a' },
  { passageId: 'b', bookId: 'b2', chapterId: 'b2-c1', topics: ['亲密关系'], text: 'b' },
  { passageId: 'c', bookId: 'b3', chapterId: 'b3-c1', topics: ['孤独与陪伴'], text: 'c' },
  { passageId: 'd', bookId: 'b1', chapterId: 'b1-c2', topics: ['亲密关系'], text: 'd' },
  { passageId: 'e', bookId: 'b4', chapterId: 'b4-c1', topics: ['成长与选择'], text: 'e' },
  { passageId: 'f', bookId: 'b5', chapterId: 'b5-c1', topics: ['亲密关系', '成长与选择'], text: 'f' },
  { passageId: 'g', bookId: 'b2', chapterId: 'b2-c2', topics: ['孤独与陪伴'], text: 'g' },
  { passageId: 'h', bookId: 'b3', chapterId: 'b3-c2', topics: ['成长与选择'], text: 'h' },
  { passageId: 'i', bookId: 'b4', chapterId: 'b4-c2', topics: ['情绪与压力'], text: 'i' }
];
function byId(id) { return P.filter(function (p) { return p.passageId === id; })[0]; }
function ids(feed) { return feed.map(function (p) { return p.passageId; }); }

function baseUser() {
  return {
    interests: ['亲密关系'], interestsAt: T0,
    topicWeights: {}, topicLastTouched: {}, skipDebt: {},
    liked: [], saved: [], hidden: [], seen: [], events: []
  };
}

var passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name); console.log('     ' + e.message); }
}

/* ---------- 1. 衰减与打分 ---------- */
t('衰减：半衰期后权重减半', function () {
  var user = baseUser();
  user.topicWeights['亲密关系'] = 1.0;
  user.topicLastTouched['亲密关系'] = T0;
  var w1 = R.effectiveWeight(user, '亲密关系', T0 + R.CONFIG.halfLifeDays * DAY);
  assert.ok(Math.abs(w1 - 0.5) < 1e-9, 'got ' + w1);
});
t('衰减：负权重对称向 0 收敛', function () {
  var user = baseUser();
  user.topicWeights['亲密关系'] = -1.0;
  user.topicLastTouched['亲密关系'] = T0;
  var w = R.effectiveWeight(user, '亲密关系', T0 + R.CONFIG.halfLifeDays * DAY);
  assert.ok(Math.abs(w + 0.5) < 1e-9, 'got ' + w);
});
t('冷启动：显式兴趣按 baseInterestWeight 计入并随 interestsAt 衰减', function () {
  var user = baseUser();
  assert.strictEqual(R.effectiveWeight(user, '亲密关系', T0), 1.0);
  var later = T0 + R.CONFIG.halfLifeDays * DAY;
  assert.ok(Math.abs(R.effectiveWeight(user, '亲密关系', later) - 0.5) < 1e-9);
  assert.strictEqual(R.effectiveWeight(user, '孤独与陪伴', T0), 0, '非兴趣主题为 0');
});
t('显式权重 0 不应回退到兴趣权重', function () {
  var user = baseUser();
  user.topicWeights['亲密关系'] = 0;
  user.topicLastTouched['亲密关系'] = T0;
  assert.strictEqual(R.effectiveWeight(user, '亲密关系', T0), 0);
});
t('亲和度取多主题最大值', function () {
  var user = baseUser();
  user.topicWeights['成长与选择'] = 2.0;
  user.topicLastTouched['成长与选择'] = T0;
  assert.strictEqual(R.affinity(byId('f'), user, T0), 2.0, 'f 双主题取 max(0, 2.0)');
});

/* ---------- 2. 反馈权重 ---------- */
t('完读 +0.3，like +1.0（方案反馈权重）', function () {
  var user = baseUser();
  var u1 = R.applyFeedback(user, { type: 'view_complete', passage: byId('a'), at: T0 });
  assert.ok(Math.abs(u1.topicWeights['亲密关系'] - 0.3) < 1e-9);
  var u2 = R.applyFeedback(u1, { type: 'like', passage: byId('a'), at: T0 });
  assert.ok(Math.abs(u2.topicWeights['亲密关系'] - 1.3) < 1e-9);
});
t('unlike 等额撤销正向贡献', function () {
  var user = baseUser();
  var u1 = R.applyFeedback(user, { type: 'like', passage: byId('a'), at: T0 });
  var u2 = R.applyFeedback(u1, { type: 'unlike', passage: byId('a'), at: T0 });
  assert.ok(Math.abs(u2.topicWeights['亲密关系']) < 1e-9);
});
t('not_interested 负 0.5 且隐藏片段', function () {
  var user = baseUser();
  var u = R.applyFeedback(user, { type: 'not_interested', passage: byId('a'), at: T0 });
  assert.ok(Math.abs(u.topicWeights['亲密关系'] + 0.5) < 1e-9);
  assert.ok(u.hidden.indexOf('a') >= 0);
});
t('quick_skip 连续 2 次才计负分，1 次不扣（防误伤）', function () {
  var user = baseUser();
  var u1 = R.applyFeedback(user, { type: 'quick_skip', passage: byId('a'), at: T0 });
  assert.strictEqual(u1.topicWeights['亲密关系'], undefined, '单次划走不扣分');
  assert.strictEqual(u1.skipDebt['亲密关系'], 1);
  var u2 = R.applyFeedback(u1, { type: 'quick_skip', passage: byId('b'), at: T0 });
  assert.ok(Math.abs(u2.topicWeights['亲密关系'] + 0.5) < 1e-9, 'got ' + u2.topicWeights['亲密关系']);
  assert.strictEqual(u2.skipDebt['亲密关系'], 0, '计分后连击清零');
});
t('正向反馈清除划走连击', function () {
  var user = baseUser();
  var u1 = R.applyFeedback(user, { type: 'quick_skip', passage: byId('a'), at: T0 });
  var u2 = R.applyFeedback(u1, { type: 'like', passage: byId('b'), at: T0 });
  assert.strictEqual(u2.skipDebt['亲密关系'], 0);
});

/* ---------- 3. 事件埋点 ---------- */
t('事件包含 id/type/passageId/position/at/sessionId/recVersion', function () {
  var user = baseUser();
  var u = R.applyFeedback(user, { type: 'like', passage: byId('a'), at: T0, position: 3, sessionId: 42 });
  var ev = u.events[0];
  assert.ok(/^ev-/.test(ev.id), 'event id 格式');
  assert.strictEqual(ev.position, 3);
  assert.strictEqual(ev.at, T0);
  assert.strictEqual(ev.sessionId, 42);
  assert.strictEqual(ev.recVersion, R.RECO_VERSION);
  assert.strictEqual(ev.passageId, 'a');
});
t('事件环形上限 500，裁最旧', function () {
  var user = baseUser();
  var u = user;
  for (var i = 0; i < 505; i++) {
    u = R.applyFeedback(u, { type: 'view_complete', passage: byId('a'), at: T0 + i, position: i, sessionId: 1 });
  }
  assert.strictEqual(u.events.length, R.CONFIG.eventCap);
  assert.strictEqual(u.events[0].position, 5, '最旧的 5 条被裁掉');
  assert.strictEqual(u.events[u.events.length - 1].position, 504);
});
t('sanitizeEvents 跳过损坏事件并计数', function () {
  var bad = [{ type: 'like', passageId: 'a', at: 1 }, null, { type: 'like' }, { type: 'x', passageId: 5, at: 'no' }, { type: 'save', passageId: 'b', at: 2 }];
  var ok = R.sanitizeEvents(bad);
  assert.strictEqual(ok.length, 2);
  assert.strictEqual(ok.badCount, 3);
  assert.strictEqual(R.sanitizeEvents(null).length, 0);
});

/* ---------- 4. Feed 组装约束 ---------- */
t('隐藏片段不出现', function () {
  var user = baseUser();
  user.hidden = ['a'];
  var feed = R.buildFeed(P, user, { seed: 1, now: T0 });
  assert.ok(ids(feed).indexOf('a') < 0);
});
t('同书不连续出现', function () {
  var user = baseUser();
  var feed = R.buildFeed(P, user, { seed: 7, now: T0 });
  for (var i = 1; i < feed.length; i++) {
    assert.notStrictEqual(feed[i].bookId, feed[i - 1].bookId, '位置 ' + i + ' 连续同书 ' + feed[i].bookId);
  }
});
t('任意连续 5 条同书至多 2', function () {
  var user = baseUser();
  var feed = R.buildFeed(P, user, { seed: 9, now: T0 });
  for (var s = 0; s + 5 <= feed.length; s++) {
    var count = {};
    for (var i = s; i < s + 5; i++) {
      count[feed[i].bookId] = (count[feed[i].bookId] || 0) + 1;
      assert.ok(count[feed[i].bookId] <= 2, '窗口 ' + s + ' 中 ' + feed[i].bookId + ' 出现 ' + count[feed[i].bookId] + ' 次');
    }
  }
});
t('冷启动首 4 条至少 3 条命中兴趣', function () {
  var user = baseUser();
  var feed = R.buildFeed(P, user, { seed: 3, now: T0 });
  var hit = feed.slice(0, 4).filter(function (p) { return p.topics.indexOf('亲密关系') >= 0; }).length;
  assert.ok(hit >= 3, '首4条命中 ' + hit);
});
t('探索位：每 4 连窗口至少 1 条低亲和内容（候选充足时）', function () {
  /* 探索占比需 ≥ 1/4 才可能全程满足（12 高亲和 + 5 探索 = 29%） */
  var pool = [];
  for (var i = 0; i < 12; i++) {
    pool.push({ passageId: 'x' + i, bookId: 'k' + (i % 6), chapterId: 'k-c', topics: ['亲密关系'], text: '' });
  }
  var zBooks = ['kz1', 'kz2', 'kz3', 'kz4', 'kz5'];
  var zTopics = ['情绪与压力', '人性与社会', '自我认识', '孤独与陪伴', '成长与选择'];
  for (var j = 0; j < 5; j++) {
    pool.push({ passageId: 'z' + j, bookId: zBooks[j], chapterId: 'kz-c', topics: [zTopics[j]], text: '' });
  }
  var user = baseUser();
  user.topicWeights['亲密关系'] = 5;
  user.topicLastTouched['亲密关系'] = T0;
  var feed = R.buildFeed(pool, user, { seed: 11, now: T0 });
  for (var s = 0; s + 4 <= feed.length; s++) {
    var hasExplore = false;
    for (var i = s; i < s + 4; i++) {
      if (feed[i].topics.indexOf('亲密关系') < 0) hasExplore = true;
    }
    assert.ok(hasExplore, '窗口 ' + s + ' 全为高亲和');
  }
});
t('探索候选耗尽时豁免且同书约束仍生效', function () {
  var user = baseUser();
  ['亲密关系', '成长与选择', '孤独与陪伴'].forEach(function (tp) {
    user.topicWeights[tp] = 5;
    user.topicLastTouched[tp] = T0;
  });
  var feed = R.buildFeed(P, user, { seed: 5, now: T0 });
  for (var i = 1; i < feed.length; i++) {
    assert.notStrictEqual(feed[i].bookId, feed[i - 1].bookId);
  }
});
t('同 seed 结果确定', function () {
  var user = baseUser();
  var f1 = ids(R.buildFeed(P, user, { seed: 99, now: T0 }));
  var f2 = ids(R.buildFeed(P, user, { seed: 99, now: T0 }));
  assert.strictEqual(JSON.stringify(f1), JSON.stringify(f2));
});
t('limit 截断生效', function () {
  var user = baseUser();
  assert.strictEqual(R.buildFeed(P, user, { seed: 1, now: T0, limit: 4 }).length, 4);
});

/* ---------- 5. 推荐理由 ---------- */
t('理由：兴趣选择触发', function () {
  var user = baseUser();
  assert.strictEqual(R.reasonFor(byId('a'), user, T0), '因为你选择了「亲密关系」');
});
t('理由：喜欢过触发', function () {
  var user = baseUser();
  user.liked = ['a'];
  var u = R.applyFeedback(user, { type: 'like', passage: byId('a'), at: T0 });
  assert.strictEqual(R.reasonFor(byId('b'), u, T0), '因为你喜欢过「亲密关系」相关内容');
});
t('理由：零亲和给探索文案，不编造行为', function () {
  var user = baseUser();
  assert.strictEqual(R.reasonFor(byId('i'), user, T0), '给你一段新的文学发现');
});

/* ---------- 6. 学习闭环（重放） ---------- */
t('重放：喜欢「成长与选择」后该主题排序上升', function () {
  var user = baseUser();
  user.interests = ['亲密关系'];
  var u = user;
  for (var i = 0; i < 3; i++) {
    u = R.applyFeedback(u, { type: 'like', passage: byId('e'), at: T0 + i, position: i, sessionId: 1 });
  }
  var feed = R.buildFeed(P, u, { seed: 21, now: T0 + 3 });
  var posE = ids(feed).indexOf('e');
  var posC = ids(feed).indexOf('c');
  assert.ok(posE >= 0 && posE < 4, 'e 应进前 4，got 位置 ' + posE);
  assert.ok(posC < 0 || posC > posE, '未互动的孤独与陪伴不应排在 e 前');
});

/* ---------- 结果 ---------- */
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
