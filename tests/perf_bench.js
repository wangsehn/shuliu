'use strict';
/* 性能基准（Node 直跑：node tests/perf_bench.js）
   指标门限（预设标准，方案性能要求：76 条片段全量排序应在毫秒级完成）：
   - buildFeed（76 条全量）p95 ≤ 5ms
   - applyFeedback p95 ≤ 0.5ms
   任一门限不达标即退出码 1。 */
global.window = {};
require('../content/content.js');
var C = global.window.CONTENT;
var R = require('../recommendation.js');

var NOW = 1700000000000;
function user() {
  return {
    interests: ['亲密关系', '成长与选择'], interestsAt: NOW - 2 * 86400000,
    topicWeights: { '孤独与陪伴': 1.2, '人性与社会': -0.5 },
    topicLastTouched: { '孤独与陪伴': NOW - 3 * 86400000, '人性与社会': NOW - 8 * 86400000 },
    skipDebt: {}, liked: [], saved: [], hidden: [], seen: [], events: []
  };
}

function percentile(sorted, p) {
  var idx = Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length));
  return sorted[idx];
}
function bench(name, iterations, fn, gateP95) {
  /* 预热 50 次让 JIT 稳定 */
  for (var w = 0; w < 50; w++) fn(w);
  var samples = [];
  for (var i = 0; i < iterations; i++) {
    var t0 = process.hrtime.bigint();
    fn(i);
    var t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  samples.sort(function (a, b) { return a - b; });
  var p50 = percentile(samples, 50), p95 = percentile(samples, 95), p99 = percentile(samples, 99);
  var ok = p95 <= gateP95;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name +
    '  p50=' + p50.toFixed(3) + 'ms  p95=' + p95.toFixed(3) + 'ms  p99=' + p99.toFixed(3) + 'ms  (门限 p95≤' + gateP95 + 'ms, n=' + iterations + ')');
  return ok;
}

var u = user();
var ok1 = bench('buildFeed 全量 ' + C.passages.length + ' 条', 1000, function (i) {
  R.buildFeed(C.passages, u, { seed: i, now: NOW, limit: C.passages.length });
}, 5);
var ok2 = bench('buildFeed limit=10', 1000, function (i) {
  R.buildFeed(C.passages, u, { seed: i, now: NOW, limit: 10 });
}, 5);
var evPassage = C.passages[0];
var ok3 = bench('applyFeedback', 5000, function (i) {
  u.events = [];
  R.applyFeedback(u, { type: i % 2 ? 'view_complete' : 'like', passage: evPassage, at: NOW + i, position: i % 80, sessionId: 1 });
}, 0.5);

console.log('\n' + (ok1 && ok2 && ok3 ? 'ALL PERF GATES PASSED' : 'PERF GATE FAILED'));
process.exit(ok1 && ok2 && ok3 ? 0 : 1);
