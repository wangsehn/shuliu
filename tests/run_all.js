'use strict';
/* 一键回归总入口（node tests/run_all.js）
   串行执行全部测试，任一环节失败即停止并返回非零退出码：
     1) data_check          内容包完整性（100 本书 / 章书关联 / loc 锚点）
     2) recommendation.test 推荐引擎单元测试（Node 直跑）
     3) replay_eval         4 人设 × 24 轮重放评估（G1-G6 门限）
     4) perf_bench          性能基准（buildFeed p95 ≤ 5ms 等）
     5) browser_run         无头浏览器测试（unit.html + e2e.html） */
var path = require('path');
var spawn = require('child_process').spawnSync;
var HERE = __dirname;

var STEPS = [
  ['data_check 内容完整性', 'data_check.js'],
  ['推荐引擎单元测试', 'recommendation.test.js'],
  ['重放评估 G1-G6', 'replay_eval.js'],
  ['性能基准', 'perf_bench.js'],
  ['浏览器测试 unit+e2e', 'browser_run.js']
];

var failed = false;
for (var i = 0; i < STEPS.length; i++) {
  var label = STEPS[i][0], file = STEPS[i][1];
  process.stdout.write('\n===== [' + (i + 1) + '/' + STEPS.length + '] ' + label + ' (' + file + ') =====\n');
  var r = spawn(process.execPath, [path.join(HERE, file)], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('\n>>> 回归在「' + label + '」失败（退出码 ' + r.status + '），中止后续环节');
    failed = true;
    break;
  }
}

console.log('\n===== 回归汇总 =====');
if (failed) { console.error('结果：FAIL'); process.exit(1); }
console.log('结果：ALL PASS（' + STEPS.length + ' 个环节全部通过）');
