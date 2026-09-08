/* 选段助手：node ctx_search.js <chapterId> <seed1> [seed2] ...
   在清洗后的章节文本中查找 seed，打印命中次数与上下文（用于确定锚点子串） */
'use strict';
const fs = require('fs');
const path = require('path');
const CH = path.join(__dirname, '..', 'content', 'chapters');
const [cid, ...seeds] = process.argv.slice(2);
const doc = JSON.parse(fs.readFileSync(path.join(CH, cid + '.json'), 'utf8'));
const text = doc.paragraphs.join('\n');
console.log('章节:', doc.title, '| 段落:', doc.paragraphs.length, '| 字数:', doc.cpLength);
for (const s of seeds) {
  const hits = [];
  let i = -1;
  while ((i = text.indexOf(s, i + 1)) >= 0) hits.push(i);
  console.log('\n=== seed "' + s + '" 命中 ' + hits.length + ' 处 ===');
  for (const h of hits.slice(0, 3)) {
    const a = Math.max(0, h - 40), b = Math.min(text.length, h + s.length + 160);
    console.log('--- @' + h + ' ---');
    console.log(text.slice(a, b).replace(/\n/g, '⏎'));
  }
}
