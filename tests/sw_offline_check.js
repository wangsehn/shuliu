/* SW 离线行为终检（Puppeteer-Core 驱动本机 Edge，同源探针页读写结果） */
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = __dirname;
const REPORT = {};
function log(msg) { console.log(msg); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--disable-gpu', '--no-first-run']
  });
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e).slice(0, 160)));

    /* 1. 打开应用（触发 SW 注册 + 运行时缓存） */
    await page.goto('http://localhost:8931/index.html', { waitUntil: 'load', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2500));
    REPORT.consoleErrorsAfterLoad = consoleErrors.slice();

    /* 2. 读取 SW 状态 */
    REPORT.swState = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      const keys = await caches.keys();
      const urls = {};
      for (const k of keys) {
        const reqs = await (await caches.open(k)).keys();
        urls[k] = reqs.map(r => r.url.replace(location.origin, ''));
      }
      return { regCount: regs.length, scopes: regs.map(r => r.scope), controlled: !!navigator.serviceWorker.controller, caches: keys, urls };
    });

    /* 3. 离线重载验证（拦截网络使全部请求失败） */
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await page.reload({ waitUntil: 'load', timeout: 20000 }).catch(e => { REPORT.reloadErr = String(e).slice(0, 120); });
    await new Promise(r => setTimeout(r, 800));
    REPORT.offline = await page.evaluate(() => ({
      hasSkip: !!document.querySelector('#st-skip'),
      hasApp: !!document.querySelector('#app') && !!document.querySelector('#app').innerHTML.length,
      url: location.href
    }));

    /* 4. 恢复在线，清掉 SW 与缓存（避免污染后续测试） */
    await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    REPORT.consoleErrorsAll = consoleErrors.slice();
  } finally {
    await browser.close();
  }
  fs.mkdirSync(path.join(ROOT, '验收截图'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '验收截图', 'sw_offline_result.json'), JSON.stringify(REPORT, null, 1));
  log('RESULT_WRITTEN');
})().catch(e => { log('FATAL ' + (e && e.message)); process.exit(1); });
