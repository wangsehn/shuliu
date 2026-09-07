/* 书流 www 构建脚本：把纯前端产物复制到 www/（Capacitor webDir）
   用法：node tools/build_www.js */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');

const COPY_FILES = [
  'index.html',
  'app.css',
  'app.js',
  'recommendation.js',
  'store.js',
  'manifest.webmanifest',
  'sw.js',
  'content/content.js',
  'content/SOURCES.md',
];

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });

for (const rel of COPY_FILES) {
  const src = path.join(ROOT, rel);
  const dest = path.join(WWW, rel);
  if (!fs.existsSync(src)) { console.error('missing:', rel); process.exitCode = 1; continue; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('copy', rel);
}

/* 图标 */
const ICONS = ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'maskable-192.png', 'maskable-512.png'];
for (const name of ICONS) {
  const src = path.join(ROOT, 'assets', name);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.join(WWW, 'assets'), { recursive: true });
    fs.copyFileSync(src, path.join(WWW, 'assets', name));
    console.log('copy assets/' + name);
  }
}

console.log('www ready ->', WWW);
