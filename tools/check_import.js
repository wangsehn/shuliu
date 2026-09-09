/* 百本导入 · 抽样校验（Node） */
const fs = require('fs');
global.window = {};
require('../content/content.js');
const C = window.CONTENT;
console.log('books:', C.books.length, 'passages:', C.passages.length, 'chapterMeta:', Object.keys(C.chapters).length);

/* 遗留章节正文一致性 */
global.window.SHULIU_TEXT = {};
require('../content/text/hlm.js');
const old = JSON.parse(fs.readFileSync(__dirname + '/../content/chapters/hlm-03.json', 'utf8'));
const now = window.SHULIU_TEXT['hlm']['hlm-03'];
console.log('hlm-03 paras match:', JSON.stringify(now) === JSON.stringify(old.paragraphs));

/* 全部文本文件可执行 + 章-文完整性 */
let files = 0, missing = 0, paras = 0;
for (const b of C.books) {
  const f = __dirname + '/../content/text/' + b.bookId + '.js';
  if (!fs.existsSync(f)) { console.log('MISSING text:', b.bookId); missing++; continue; }
  require('../content/text/' + b.bookId + '.js');
  files++;
  for (const ch of b.chapters) {
    if (!window.SHULIU_TEXT[b.bookId][ch.chapterId]) { missing++; if (missing < 5) console.log('missing ch text:', ch.chapterId); }
  }
}
console.log('text files loaded:', files, 'missing chapters:', missing);

/* loc 重建校验（全部片段） */
function rebuild(paras, loc) {
  if (loc.sp === loc.ep) return Array.from(paras[loc.sp]).slice(loc.so, loc.eo).join('');
  const parts = [Array.from(paras[loc.sp]).slice(loc.so).join('')]
    .concat(paras.slice(loc.sp + 1, loc.ep).map(p => p))
    .concat([Array.from(paras[loc.ep]).slice(0, loc.eo).join('')]);
  return parts.join('\n');
}
let bad = 0, lenBad = 0;
for (const p of C.passages) {
  const paras = window.SHULIU_TEXT[p.bookId] && window.SHULIU_TEXT[p.bookId][p.chapterId];
  if (!paras) continue;
  const snap = rebuild(paras, p.loc);
  if (snap !== p.text) { bad++; if (bad < 4) console.log('LOC BAD:', p.passageId); }
  if (p.cpLength < 60 || p.cpLength > 220) lenBad++;
}
console.log('loc bad:', bad, 'len out of range:', lenBad);

/* 抽样 + 主题分布 + 书均片段 */
[100, 2000, 4000].forEach(i => {
  const p = C.passages[i];
  console.log('---', p.passageId, 'cp=' + p.cpLength, '[' + p.topics.join('/') + ']');
  console.log('intro:', p.intro);
  console.log('text:', p.text.slice(0, 80) + '…');
});
const dist = {};
C.passages.forEach(p => p.topics.forEach(t => { dist[t] = (dist[t] || 0) + 1; }));
console.log('topic dist:', JSON.stringify(dist));
const byBook = {};
C.passages.forEach(p => { byBook[p.bookId] = (byBook[p.bookId] || 0) + 1; });
const top = Object.entries(byBook).sort((a, b) => b[1] - a[1]);
console.log('books with passages:', top.length, 'top5:', JSON.stringify(top.slice(0, 5)), 'bottom3:', JSON.stringify(top.slice(-3)));
