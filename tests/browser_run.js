'use strict';
/* 无头浏览器测试入口（node tests/browser_run.js）
   用 playwright-core 驱动本机 Edge/Chrome（无需下载内核），
   依次跑 unit.html?test=1 与 e2e.html（自带极简静态服务器），
   读取 window.UNIT_RESULT / window.E2E_RESULT 汇总输出；任一失败退出码 1。 */
var path = require('path');
var http = require('http');
var fs = require('fs');
var ROOT = path.join(__dirname, '..');
var PORT = 8932;

/* 极简静态服务器（仅本地测试用；路径白名单即 ROOT 内） */
var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon'
};
function serve(req, res) {
  var u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  var fp = path.normalize(path.join(ROOT, u));
  if (fp.indexOf(ROOT) !== 0) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, function (err, buf) {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

(async function () {
  var pw;
  try { pw = require('playwright-core'); }
  catch (e) { console.error('缺少依赖：请先执行 npm i -D playwright-core'); process.exit(2); }

  var server = http.createServer(serve);
  await new Promise(function (r) { server.listen(PORT, r); });
  var base = 'http://localhost:' + PORT;

  var browser = null;
  try { browser = await pw.chromium.launch({ channel: 'msedge', headless: true }); }
  catch (e1) {
    try { browser = await pw.chromium.launch({ channel: 'chrome', headless: true }); }
    catch (e2) {
      console.error('未找到本机 Edge/Chrome，请安装其一或改用 npx playwright install chromium');
      console.error('详情：' + e2.message);
      server.close();
      process.exit(2);
    }
  }

  async function runPage(url, resultKey, label) {
    var ctx = await browser.newContext(); /* 独立上下文：unit/e2e 的 localStorage 互不污染 */
    var page = await ctx.newPage();
    var consoleErrors = [];
    page.on('pageerror', function (e) { consoleErrors.push('pageerror: ' + e.message); });
    try { await page.goto(base + url, { waitUntil: 'load', timeout: 60000 }); }
    catch (e) {
      consoleErrors.push('goto: ' + e.message);
    }
    var r;
    try {
      await page.waitForFunction('window.' + resultKey + ' !== undefined', null, { timeout: 300000 });
      r = await page.evaluate('window.' + resultKey);
    } catch (e) {
      r = { total: 0, passed: 0, failed: [{ name: label + ' 超时/异常', err: resultKey + ' 未产出：' + e.message }] };
    }
    r.consoleErrors = consoleErrors;
    await ctx.close();
    return r;
  }

  var unit = await runPage('/tests/unit.html?test=1&run=AUTO', 'UNIT_RESULT', 'unit');
  var e2e = await runPage('/tests/e2e.html?run=AUTO', 'E2E_RESULT', 'e2e');
  await browser.close();
  server.close();

  var allOk = true;
  [unit, e2e].forEach(function (r, i) {
    var label = i === 0 ? 'unit' : 'e2e';
    console.log('[' + label + '] ' + r.passed + '/' + r.total + ' 通过');
    (r.failed || []).forEach(function (f) {
      allOk = false;
      console.log('  FAIL ' + f.name + (f.err ? ' — ' + f.err : f.info ? ' — ' + f.info : ''));
    });
    (r.consoleErrors || []).forEach(function (m) { console.log('  [console] ' + m); });
  });
  if (allOk) console.log('浏览器测试全部通过');
  process.exit(allOk ? 0 : 1);
})().catch(function (e) { console.error('运行异常：' + (e && e.stack || e)); process.exit(1); });
