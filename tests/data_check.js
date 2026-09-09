/* 临时终检脚本：数据完整性独立校验（Node 环境，镜像 app.js verifyLoc 口径）
   百本库架构：content.js 只含书籍/章节元数据与片段池；章节正文在 content/text/{bookId}.js 按书分包。 */
'use strict';
global.window = {};
require('../content/content.js');
var C = global.window.CONTENT;
var issues = [];
function ok(cond, msg) { if (!cond) issues.push(msg); }
function cps(s) { return Array.from(s); }
function sliceCP(s, a, b) { return b === undefined ? cps(s).slice(a).join('') : cps(s).slice(a, b).join(''); }
function rebuildSnapshot(paras, loc) {
  var p1 = paras[loc.sp], p2 = paras[loc.ep];
  if (loc.sp === loc.ep) return sliceCP(p1, loc.so, loc.eo);
  var parts = [sliceCP(p1, loc.so, undefined)]
    .concat(paras.slice(loc.sp + 1, loc.ep))
    .concat([sliceCP(p2, 0, loc.eo)]);
  return parts.join('\n');
}

/* 1. 结构（内容包已扩容至百本库） */
ok(Array.isArray(C.books) && C.books.length === 100, 'books 应为 100 本，实际 ' + (C.books || []).length);
ok(Array.isArray(C.passages) && C.passages.length === 4636, 'passages 应为 4636 条，实际 ' + (C.passages || []).length);
ok(C.chapters && typeof C.chapters === 'object', 'chapters 缺失');
var chIds = Object.keys(C.chapters);
ok(chIds.length === 4595, '章节元数据应为 4595 章，实际 ' + chIds.length);

/* 2. 书籍字段 + bookId 唯一 */
var TOPICS = ['自我认识', '亲密关系', '孤独与陪伴', '成长与选择', '情绪与压力', '人性与社会'];
var TOPIC_SET = {};
TOPICS.forEach(function (t) { TOPIC_SET[t] = 1; });
var bookIds = {};
C.books.forEach(function (b) {
  ok(b.bookId && !bookIds[b.bookId], '书籍 bookId 缺失或重复: ' + b.bookId);
  bookIds[b.bookId] = true;
  ok(b.title && b.author && b.dynasty && Array.isArray(b.chapters) && b.chapters.length > 0,
    '书籍字段不全: ' + (b.bookId || '?'));
});

/* 3. 章节正文分包完整性（每章元数据 ↔ 文本文件一一对应） */
var textMap = {};
var fs = require('fs');
var path = require('path');
C.books.forEach(function (b) {
  var f = path.join(__dirname, '..', 'content', 'text', b.bookId + '.js');
  ok(fs.existsSync(f), '缺文本分包: ' + b.bookId);
  if (fs.existsSync(f)) {
    delete global.window.SHULIU_TEXT;
    require(f);
    textMap[b.bookId] = global.window.SHULIU_TEXT[b.bookId] || {};
  }
});
var totalChars = 0;
chIds.forEach(function (cid) {
  var ch = C.chapters[cid];
  ok(ch.bookId && typeof ch.title === 'string' && ch.title.length > 0, '章节元数据缺失字段: ' + cid);
  ok(typeof ch.number === 'number' && ch.number >= 0, '章节序号非法: ' + cid);
  var paras = textMap[ch.bookId] && textMap[ch.bookId][cid];
  ok(Array.isArray(paras) && paras.length >= 1, '章节正文缺失: ' + cid);
  if (paras) {
    var cl = paras.reduce(function (s, t) { return s + cps(t).length + 1; }, 0) - 1;
    ok(cl === ch.chars, '章节字数与正文不一致: ' + cid);
    totalChars += cl;
  }
  ok(bookIds[ch.bookId], '章节引用未知书籍: ' + cid);
});

/* 4. 片段字段 + 坐标口径（全量重建校验） */
var seenPid = {};
C.passages.forEach(function (p) {
  ok(p.passageId && !seenPid[p.passageId], '片段 id 缺失或重复: ' + p.passageId);
  seenPid[p.passageId] = 1;
  ok(bookIds[p.bookId], '片段引用未知书籍: ' + p.bookId);
  ok(C.chapters[p.chapterId], '片段引用未知章节: ' + p.chapterId);
  ok(Array.isArray(p.topics) && p.topics.length > 0, '片段无主题: ' + p.passageId);
  (p.topics || []).forEach(function (t) { ok(TOPIC_SET[t], '非法主题 "' + t + '" @ ' + p.passageId); });
  ok(typeof p.text === 'string' && p.text.length > 0, '片段文本为空: ' + p.passageId);
  ok(p.loc && typeof p.loc.sp === 'number' && p.loc.sp <= p.loc.ep, 'loc 非法: ' + p.passageId);
  var paras = textMap[p.bookId] && textMap[p.bookId][p.chapterId];
  if (paras && p.loc) {
    ok(p.loc.ep < paras.length, 'loc.ep 越界: ' + p.passageId);
    try {
      ok(rebuildSnapshot(paras, p.loc) === p.text, '坐标重建不一致: ' + p.passageId);
    } catch (e) { issues.push('重建异常: ' + p.passageId + ' ' + e.message); }
  }
  ok(p.cpLength === cps(p.text).length, 'cpLength 口径不一致: ' + p.passageId);
  var len = cps(p.text || '').length;
  ok(len >= 40 && len <= 320, '片段字数越界(' + len + '): ' + p.passageId);
  ok(typeof p.intro === 'string' && p.intro.length > 0, 'intro 缺失: ' + p.passageId);
});

/* 5. 主题分布：每个兴趣至少 2 条匹配 */
TOPICS.forEach(function (t) {
  var n = C.passages.filter(function (p) { return p.topics.indexOf(t) >= 0; }).length;
  ok(n >= 2, '主题 "' + t + '" 匹配片段仅 ' + n + ' 条');
});

/* 6. 片段与章节 bookId 一致 */
C.passages.forEach(function (p) {
  var ch = C.chapters[p.chapterId];
  if (ch) ok(ch.bookId === p.bookId, '片段与章节 bookId 不一致: ' + p.passageId);
});

/* 7. 百本覆盖：每本书至少 1 条片段，每本书至少 1 章 */
C.books.forEach(function (b) {
  var chN = b.chapters.length;
  ok(chN >= 1, '书籍无章节: ' + b.bookId);
  var n = C.passages.filter(function (p) { return p.bookId === b.bookId; }).length;
  ok(n >= 1, '书籍无片段: ' + b.bookId);
});

var catCount = {};
var byBook = {};
C.passages.forEach(function (p) { byBook[p.bookId] = (byBook[p.bookId] || 0) + 1; });
C.books.forEach(function (b) { catCount[b.dynasty] = (catCount[b.dynasty] || 0) + 1; });
var perBook = C.books.map(function (b) { return byBook[b.bookId] || 0; });
var stats = {
  books: C.books.length,
  passages: C.passages.length,
  chapters: chIds.length,
  totalChapterMChars: Math.round(totalChars / 1000) / 100 + 'M',
  passageLenRange: [Math.min.apply(null, perBook.concat([0])) ? undefined : undefined, undefined],
  topicDist: TOPICS.map(function (t) {
    return t + ':' + C.passages.filter(function (p) { return p.topics.indexOf(t) >= 0; }).length;
  }).join(' '),
  booksMinPassage: Math.min.apply(null, perBook),
  booksMaxPassage: Math.max.apply(null, perBook),
  dynastyDist: catCount
};
delete stats.passageLenRange;
console.log(JSON.stringify(stats, null, 1));
if (issues.length) { console.log('ISSUES(' + issues.length + '):'); issues.slice(0, 40).forEach(function (m) { console.log('  - ' + m); }); process.exit(1); }
console.log('DATA_CHECK_ALL_PASS');
