'use strict';
/* 全面实测走查（node tests/walkthrough.js）—— 真实用户视角，常驻回归工具
   覆盖：冷启动/兴趣选择/卡片交互/翻页三通道/完读埋点/原文阅读/本书精选/发布链路/
        我的/兴趣调整重混排/持久化/离线/触摸滑动；截图存 验收截图/manual_walk/。
   说明：与 e2e.html 的 DOM 断言互补，本脚本走真实交互事件（滚轮/键盘/双击/触摸/划选）。
   已知偶发：A11b 下一章在负载高时可能超时（异步文本加载竞态），复跑即可。 */
var path = require('path');
var http = require('http');
var fs = require('fs');
var ROOT = path.join(__dirname, '..');
var SHOTS = path.join(ROOT, '验收截图', 'manual_walk');
fs.mkdirSync(SHOTS, { recursive: true });
var PORT = 8933;
var MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

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
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function () {
  var pw = require('playwright-core');
  var server = http.createServer(serve);
  await new Promise(function (r) { server.listen(PORT, r); });
  var BASE = 'http://localhost:' + PORT;
  var browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  var ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  var page = await ctx.newPage();
  var consoleErrors = [];
  page.on('pageerror', function (e) { consoleErrors.push(e.message); });
  var results = [];
  function step(name, ok, detail) {
    results.push({ step: name, ok: !!ok, detail: detail == null ? '' : String(detail) });
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail != null ? ' | ' + detail : ''));
  }
  function S() { return page.evaluate(function () { return JSON.parse(JSON.stringify(window.__SHULIU_TEST__.getRawState())); }); }

  /* A1 冷启动页 */
  await page.goto(BASE + '/?test=1', { waitUntil: 'load' });
  await page.evaluate(function () { localStorage.clear(); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.start .chip', { timeout: 10000 });
  var chips = await page.$$eval('.chip', function (els) { return els.length; });
  step('A1 冷启动兴趣页渲染', chips === 6, 'chips=' + chips);
  await page.screenshot({ path: path.join(SHOTS, '01_start.png') });

  /* A2 选兴趣 */
  await page.click('.chip[data-t="亲密关系"]');
  await page.click('.chip[data-t="孤独与陪伴"]');
  var on = await page.$$eval('.chip.on', function (els) { return els.length; });
  var ints = await page.evaluate(function () { return JSON.parse(localStorage.getItem('shuliu.v1.interests') || '[]'); });
  step('A2 选择2个兴趣', on === 2 && ints.length === 2, JSON.stringify(ints));
  await page.screenshot({ path: path.join(SHOTS, '02_interests.png') });

  /* A3 开始看书流 */
  await page.click('#st-go');
  await page.waitForSelector('.card[data-pid]', { timeout: 10000 });
  var st = await S();
  var reason = await page.$eval('.card .reason', function (el) { return el.textContent.trim(); });
  var dots = await page.$eval('#dots', function (el) { return el.textContent; });
  step('A3 feed首卡渲染', !!st.feed && st.feed.order.length > 4000 && !!reason && /第 1 条/.test(dots),
    'order=' + st.feed.order.length + ' reason=' + reason.slice(0, 18) + '…');
  await page.screenshot({ path: path.join(SHOTS, '03_home.png') });

  /* A4 喜欢按钮 */
  var likeBefore = Object.keys(st.likes).length;
  await page.click('[data-act="like"]');
  var st4 = await S();
  if (!st4.recEvents) console.log('DEBUG S keys=' + Object.keys(st4).join(','));
  var ev4 = st4.recEvents ? st4.recEvents[st4.recEvents.length - 1] : null;
  step('A4 喜欢按钮+埋点', !!ev4 && Object.keys(st4.likes).length === likeBefore + 1 && ev4.type === 'like', ev4 ? ev4.type : 'recEvents缺失');

  /* A5 收藏按钮 */
  await page.click('[data-act="save"]');
  var st5 = await S();
  step('A5 收藏按钮', Object.keys(st5.saves).length === 1, 'saves=' + Object.keys(st5.saves).length);

  /* A6 键盘翻页（下/上） */
  var c6 = st5.feed.cursor;
  await page.keyboard.press('ArrowDown');
  var c6b = (await S()).feed.cursor;
  await page.keyboard.press('ArrowUp');
  var c6c = (await S()).feed.cursor;
  step('A6 键盘翻页', c6b === c6 + 1 && c6c === c6, c6 + '→' + c6b + '→' + c6c);

  /* A7 滚轮翻页 */
  await page.mouse.move(195, 420);
  await page.mouse.wheel(0, 150);
  await sleep(300);
  var c7 = (await S()).feed.cursor;
  step('A7 滚轮翻页', c7 === c6 + 1, 'cursor=' + c7);

  /* A8 双击点赞 */
  var likeBefore8 = Object.keys((await S()).likes).length;
  await page.locator('.card').dblclick();
  var st8 = await S();
  step('A8 双击点赞', Object.keys(st8.likes).length === likeBefore8 + 1, 'likes=' + Object.keys(st8.likes).length);

  /* A9 完读埋点（停留≥4s） */
  await sleep(4300);
  await page.keyboard.press('ArrowDown');
  var ev9 = (await S()).recEvents.slice(-1)[0];
  step('A9 完读埋点', ev9.type === 'view_complete', ev9.type);

  /* A10 更多→不感兴趣 */
  await page.click('[data-act="more"]');
  await page.waitForSelector('.sheet, #sheet-root .row', { timeout: 5000 });
  await page.screenshot({ path: path.join(SHOTS, '04_more_menu.png') });
  var hidBefore = (await S()).hidden.length;
  await page.click('[data-m="hide"]');
  await sleep(400);
  var st10 = await S();
  step('A10 不感兴趣隐藏', st10.hidden.length === hidBefore + 1, 'hidden=' + st10.hidden.length);

  /* A11 查看原文 → 阅读器 → 下一章 → 本书精选 */
  await page.click('[data-act="go-src"]');
  await page.waitForSelector('#rscroll .para', { timeout: 20000 });
  var rd = await page.evaluate(function () {
    var ps = document.querySelectorAll('#rscroll .para');
    var chars = 0;
    ps.forEach(function (p) { chars += p.textContent.length; });
    return { n: ps.length, chars: chars, mark: !!document.querySelector('#rscroll mark') };
  });
  step('A11a 原文懒加载', rd.n >= 1 && rd.chars >= 200 && rd.mark, 'paras=' + rd.n + ' 字数=' + rd.chars + ' 定位锚=' + rd.mark);
  await page.screenshot({ path: path.join(SHOTS, '05_reader.png') });
  var t1 = await page.$eval('.chapter-t', function (el) { return el.textContent; });
  var nextOk = true, t2 = t1;
  try {
    await page.click('[data-act="next-ch"]');
    await page.waitForFunction(function (t1) { var e = document.querySelector('.chapter-t'); return e && e.textContent !== t1; }, t1, { timeout: 15000 });
    t2 = await page.$eval('.chapter-t', function (el) { return el.textContent; });
  } catch (e) { nextOk = false; }
  step('A11b 下一章', nextOk && t2 !== t1, t1.slice(0, 12) + ' → ' + t2.slice(0, 12));
  await page.click('[data-act="book"]');
  await page.waitForSelector('.ch-item', { timeout: 10000 });
  var chN = await page.$$eval('.ch-item', function (els) { return els.length; });
  step('A11c 本书精选章节列表', chN > 10, 'chapters=' + chN);
  await page.screenshot({ path: path.join(SHOTS, '06_book.png') });
  await page.click('[data-b]');      /* 本书精选 → 阅读器 */
  await sleep(400);
  await page.keyboard.press('Escape'); /* AC-12：阅读链退出直达首页 */
  await page.waitForSelector('.card', { timeout: 8000 });

  /* A12 发布链路：选章 → 划选 → 编辑 → 预览 → 保存 */
  await page.click('[data-nav="publish"]');
  await page.waitForSelector('.choose .ch-item', { timeout: 5000 });
  await page.click('.choose .ch-item');
  await page.waitForSelector('#rscroll .para', { timeout: 20000 });
  var selOk = await page.evaluate(function () {
    var p = document.querySelector('#rscroll .para');
    var r = document.createRange();
    r.setStart(p.firstChild, 10); r.setEnd(p.firstChild, 80);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    document.querySelector('#rscroll').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  });
  await sleep(200);
  var pop = await page.$('.sel-pop');
  step('A12a 划选弹出发布按钮', selOk && !!pop, 'sel-pop=' + !!pop);
  if (pop) {
    await page.screenshot({ path: path.join(SHOTS, '07_sel_pop.png') });
    await page.evaluate(function () { document.querySelector('.sel-pop button').click(); });
    await page.waitForSelector('#thought', { timeout: 5000 });
    await page.fill('#thought', '实测走查：这段写得真好');
    await page.click('#to-preview');
    await page.waitForSelector('#pv-save', { timeout: 5000 });
    await page.screenshot({ path: path.join(SHOTS, '08_preview.png') });
    await page.click('#pv-save');
    await sleep(800);
    var st12 = await S();
    var hasU = st12.feed.order.some(function (id) { return id.charAt(0) === 'u'; });
    step('A12b 保存发布并排进首页', st12.publishes.length === 1 && hasU, 'publishes=' + st12.publishes.length);
  }

  /* A13 我的 + 收藏列表 + 兴趣调整重混排 */
  await page.click('[data-nav="mine"]');
  await page.waitForSelector('.mine .row-list', { timeout: 5000 });
  await page.screenshot({ path: path.join(SHOTS, '09_mine.png') });
  await page.click('.row[data-k="saves"]');
  await page.waitForSelector('.page .it', { timeout: 5000 });
  await page.screenshot({ path: path.join(SHOTS, '10_saves_list.png') });
  var st13 = await S();
  await page.click('[data-b]'); /* 收藏列表 → 我的 */
  await sleep(300);
  await page.click('[data-nav="home"]');
  await page.waitForSelector('.card', { timeout: 5000 });
  step('A13 我的页计数', Object.keys(st13.likes).length >= 2 && Object.keys(st13.saves).length >= 1,
    'likes=' + Object.keys(st13.likes).length + ' saves=' + Object.keys(st13.saves).length);

  /* A14 兴趣调整 → 重新混排（保留当前卡） */
  var oldOrder = (await S()).feed.order.join(',');
  await page.evaluate(function () { location.hash = ''; });
  await page.click('[data-nav="mine"]');
  await page.click('[data-x="settings"]');
  await page.waitForSelector('.chip', { timeout: 5000 });
  await page.click('.chip[data-t="成长与选择"]');
  await page.click('#sv');
  await page.waitForSelector('.mine', { timeout: 5000 }); /* 保存后 resetTo('mine') */
  await page.click('[data-nav="home"]');
  await page.waitForSelector('.card', { timeout: 5000 });
  var st14 = await S();
  var newOrder = st14.feed.order.join(',');
  step('A14 兴趣重混排', st14.interests.indexOf('成长与选择') >= 0 && newOrder !== oldOrder, 'interests=' + st14.interests.join('/'));
  await page.screenshot({ path: path.join(SHOTS, '11_after_retune.png') });

  /* A15 持久化（刷新后直达首页，状态保留，含继续阅读浮层） */
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.card', { timeout: 10000 });
  var st15 = await S();
  var noStart = await page.$('.start');
  var resumeToast = await page.$('.resume-toast');
  step('A15 刷新持久化', !noStart && st15.onboarded && Object.keys(st15.likes).length >= 2,
    '直达首页 likes=' + Object.keys(st15.likes).length + ' 继续阅读浮层=' + !!resumeToast);
  if (resumeToast) await page.screenshot({ path: path.join(SHOTS, '12_resume_toast.png') });

  /* A16 离线可用（SW 缓存） */
  var swOn = await page.waitForFunction(function () {
    return navigator.serviceWorker.controller !== null;
  }, null, { timeout: 15000 }).then(function () { return true; }).catch(function () { return false; });
  if (swOn) {
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'load' }).catch(function () {});
    await sleep(1500);
    var card = await page.$('.card, .start');
    step('A16 离线可用', !!card, '离线渲染=' + !!card);
    await page.screenshot({ path: path.join(SHOTS, '13_offline.png') });
    await ctx.setOffline(false);
  } else step('A16 离线可用', false, 'SW 未受控');

  /* A17 触摸滑动（独立触屏上下文） */
  var tctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  var tpage = await tctx.newPage();
  await tpage.goto(BASE + '/?test=1', { waitUntil: 'load' });
  await tpage.evaluate(function () { localStorage.clear(); });
  await tpage.reload({ waitUntil: 'load' });
  await tpage.click('#st-skip');
  await tpage.waitForSelector('.card', { timeout: 10000 });
  var c17a = (await tpage.evaluate(function () { return JSON.parse(JSON.stringify(window.__SHULIU_TEST__.getRawState())); })).feed.cursor;
  await tpage.evaluate(function () {
    function mkTouch(y) { return new Touch({ identifier: 1, target: document.querySelector('#feed'), clientX: 195, clientY: y }); }
    var feed = document.querySelector('#feed');
    feed.dispatchEvent(new TouchEvent('touchstart', { touches: [mkTouch(500)], changedTouches: [mkTouch(500)], bubbles: true }));
    feed.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [mkTouch(400)], bubbles: true }));
  });
  await sleep(300);
  var c17b = (await tpage.evaluate(function () { return JSON.parse(JSON.stringify(window.__SHULIU_TEST__.getRawState())); })).feed.cursor;
  step('A17 触摸上滑换卡', c17b === c17a + 1, c17a + '→' + c17b);
  await tctx.close();

  /* 汇总 */
  var fails = results.filter(function (r) { return !r.ok; });
  console.log('\n===== 走查汇总 =====');
  console.log('通过 ' + (results.length - fails.length) + '/' + results.length + (consoleErrors.length ? ' | 控制台错误 ' + consoleErrors.length + ' 条：' + consoleErrors.join(' ; ') : ' | 零控制台错误'));
  await browser.close();
  server.close();
  fs.writeFileSync(path.join(SHOTS, 'walk_result.json'), JSON.stringify({ results: results, consoleErrors: consoleErrors }, null, 2));
  process.exit(fails.length ? 1 : 0);
})().catch(function (e) { console.error('走查异常：' + (e && e.stack || e)); process.exit(1); });
