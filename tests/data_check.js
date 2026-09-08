/* 临时终检脚本：数据完整性独立校验（Node 环境，镜像 app.js verifyLoc 口径） */
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

/* 1. 结构（内容包已扩容至 10 本 / 76 条） */
ok(Array.isArray(C.books) && C.books.length === 10, 'books 应为 10 本');
ok(Array.isArray(C.passages) && C.passages.length === 76, 'passages 应为 76 条');
ok(C.chapters && typeof C.chapters === 'object', 'chapters 缺失');

/* 2. 书籍字段 */
var TOPICS = ['自我认识', '亲密关系', '孤独与陪伴', '成长与选择', '情绪与压力', '人性与社会'];
var TOPIC_SET = {};
TOPICS.forEach(function (t) { TOPIC_SET[t] = 1; });
var bookIds = {};
C.books.forEach(function (b) {
  bookIds[b.bookId] = true;
  ok(b.bookId && b.title && b.author, '书籍字段不全: ' + b.bookId);
});

/* 3. 片段字段 + 坐标口径（镜像 verifyLoc） */
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
  var ch = C.chapters[p.chapterId];
  if (ch && p.loc) {
    var paras = ch.paragraphs;
    ok(Array.isArray(paras) && paras.length > 0, '章节 paragraphs 缺失: ' + p.chapterId);
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

/* 4. 章节完整性 */
var chCount = 0, totalChars = 0;
Object.keys(C.chapters).forEach(function (cid) {
  chCount++;
  var ch = C.chapters[cid];
  ok(Array.isArray(ch.paragraphs) && ch.paragraphs.length >= 1, '章节段落缺失: ' + cid);
  ok(ch.bookId && ch.title && (/^(第)?[一二三四五六七八九十百]+[卷回]/.test(ch.title) || /^卷[一二三四五六七八九十百]+/.test(ch.title)), '章节标题异常: ' + cid);
  var cl = ch.paragraphs.reduce(function (s, t) { return s + cps(t).length + 1; }, 0);
  ok(typeof ch.cpLength === 'number' && ch.cpLength > 500, '章节 cpLength 异常: ' + cid);
  totalChars += cl;
});
ok(chCount >= 4, '章节数量过少: ' + chCount);

/* 5. 主题分布：每个兴趣至少 2 条匹配 */
TOPICS.forEach(function (t) {
  var n = C.passages.filter(function (p) { return p.topics.indexOf(t) >= 0; }).length;
  ok(n >= 2, '主题 "' + t + '" 匹配片段仅 ' + n + ' 条');
});

/* 6. 片段 id 唯一 + chapterId 一致性（bookId 与章节 bookId 一致） */
C.passages.forEach(function (p) {
  var ch = C.chapters[p.chapterId];
  if (ch) ok(ch.bookId === p.bookId, '片段与章节 bookId 不一致: ' + p.passageId);
});

var stats = {
  books: C.books.length,
  passages: C.passages.length,
  chapters: chCount,
  totalChapterKChars: Math.round(totalChars / 100) / 10,
  passageLenRange: [Math.min.apply(null, C.passages.map(function (p) { return cps(p.text).length; })),
                    Math.max.apply(null, C.passages.map(function (p) { return cps(p.text).length; }))],
  topicDist: TOPICS.map(function (t) {
    return t + ':' + C.passages.filter(function (p) { return p.topics.indexOf(t) >= 0; }).length;
  }).join(' '),
  bookChapterMap: C.books.map(function (b) {
    return b.bookId + '(' + b.title + '): ' + Object.keys(C.chapters).filter(function (k) { return C.chapters[k].bookId === b.bookId; }).length + ' 章';
  }).join(', ')
};
console.log(JSON.stringify(stats, null, 1));
if (issues.length) { console.log('ISSUES(' + issues.length + '):'); issues.forEach(function (m) { console.log('  - ' + m); }); process.exit(1); }
console.log('DATA_CHECK_ALL_PASS');
