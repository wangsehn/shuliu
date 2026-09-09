/* 书流 首版原型 app.js
   依据：PRD V1.0 FR-01~10 / PG-01~10 / AC-01~24 + UX V1.0 差异项（继续阅读、不感兴趣+撤销、轮末页）。
   口径：全部文字坐标使用 Unicode code point（Array.from），左闭右开 [start, end)。 */
(function () {
'use strict';

/* ============ 基础 ============ */
var $ = function (s, r) { return (r || document).querySelector(s); };
var esc = function (s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};
var C = window.CONTENT;
var STORE = window.SHULIU_STORE;
var RECOMMENDER = window.SHULIU_RECOMMENDER;
var TOPICS = ['自我认识', '亲密关系', '孤独与陪伴', '成长与选择', '情绪与压力', '人性与社会'];
var BOOK = {};
C.books.forEach(function (b) { BOOK[b.bookId] = b; });
var PASSAGE = {};
C.passages.forEach(function (p) { PASSAGE[p.passageId] = p; });

var cps = function (s) { return Array.from(s); };
var cpLen = function (s) { return cps(s).length; };
var sliceCP = function (s, a, b) { return cps(s).slice(a, b).join(''); };

/* 视口模拟（验收用，非产品功能） */
(function () {
  var m = location.search.match(/vp=(\d+)x(\d+)/);
  if (m) {
    document.body.classList.add('vp-frame');
    document.body.style.setProperty('--vp-w', m[1] + 'px');
    document.body.style.setProperty('--vp-h', m[2] + 'px');
  }
})();

/* ============ 本机状态 ============ */
var DEFAULTS = {
  onboarded: false, interests: [], interestsAt: 0,
  likes: {}, saves: {}, commentLikes: {},
  publishes: [], history: {}, hidden: [],
  feed: null, topicWeights: {}, topicLastTouched: {}, skipDebt: {}, recEvents: []
};
var S = {};
function loadState() {
  S = {
    onboarded: STORE.get('onboarded', DEFAULTS.onboarded),
    interests: STORE.get('interests', DEFAULTS.interests),
    interestsAt: STORE.get('interestsAt', DEFAULTS.interestsAt),
    likes: STORE.get('likes', DEFAULTS.likes),
    saves: STORE.get('saves', DEFAULTS.saves),
    commentLikes: STORE.get('commentLikes', DEFAULTS.commentLikes),
    publishes: STORE.get('publishes', DEFAULTS.publishes),
    history: STORE.get('history', DEFAULTS.history),
    hidden: STORE.get('hidden', DEFAULTS.hidden),
    feed: STORE.get('feed', DEFAULTS.feed),
    topicWeights: STORE.get('topicWeights', DEFAULTS.topicWeights),
    topicLastTouched: STORE.get('topicLastTouched', DEFAULTS.topicLastTouched),
    skipDebt: STORE.get('skipDebt', DEFAULTS.skipDebt),
    recEvents: STORE.get('recEvents', DEFAULTS.recEvents)
  };
  /* 损坏事件容忍：单条跳过（PRD 测试决策），不让坏数据阻塞启动 */
  if (RECOMMENDER && RECOMMENDER.sanitizeEvents) {
    S.recEvents = RECOMMENDER.sanitizeEvents(S.recEvents);
  }
}
function persist(key) {
  if (!STORE.set(key, S[key])) {
    toast('本机保存失败，已还原');
    loadState();
    return false;
  }
  return true;
}
function recordRecommendationFeedback(type, passage) {
  if (!RECOMMENDER || !passage) return;
  var user = {
    interests: S.interests, interestsAt: S.interestsAt,
    topicWeights: S.topicWeights, topicLastTouched: S.topicLastTouched, skipDebt: S.skipDebt,
    liked: Object.keys(S.likes), saved: Object.keys(S.saves), hidden: S.hidden,
    seen: Object.keys(S.history), events: S.recEvents
  };
  /* 埋点元数据：position=当前卡片位次、at=时间戳、sessionId=本轮轮次 ID（方案要求） */
  var next = RECOMMENDER.applyFeedback(user, {
    type: type,
    passage: passage,
    at: Date.now(),
    position: S.feed ? S.feed.cursor : -1,
    sessionId: S.feed ? S.feed.roundId : 0
  });
  S.topicWeights = next.topicWeights;
  S.topicLastTouched = next.topicLastTouched;
  S.skipDebt = next.skipDebt;
  S.recEvents = next.events;
  persist('topicWeights');
  persist('topicLastTouched');
  persist('skipDebt');
  persist('recEvents');
}
loadState();

/* ============ 混排队列（PRD 5.4：3 匹配 + 1 其他） ============ */
function shuffle(a) {
  a = a.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function visiblePassages() {
  return C.passages.filter(function (p) { return S.hidden.indexOf(p.passageId) < 0; });
}
function mixPool(match, other) {
  var out = [], mi = 0, oi = 0;
  while (mi < match.length || oi < other.length) {
    var take = 0;
    while (take < 3 && mi < match.length) { out.push(match[mi++]); take++; }
    if (oi < other.length) out.push(other[oi++]);
    if (take === 0 && oi >= other.length) break;
  }
  return out;
}
var _lastReasonMap = {}; /* buildFullOrder/rebuildTail 产出的「片段ID→推荐理由」映射，供 ensureFeed 写入 S.feed */
var _lastRelaxedMap = {}; /* 片段ID→豁免等级（引擎逐槽放宽探索/书约束时标记），供验收与测试审计 */
function buildFullOrder() {
  var vis = visiblePassages();
  var user = { interests: S.interests, interestsAt: S.interestsAt, topicWeights: S.topicWeights, topicLastTouched: S.topicLastTouched, liked: Object.keys(S.likes), saved: Object.keys(S.saves), hidden: S.hidden, seen: Object.keys(S.history) };
  var items = RECOMMENDER.buildFeed(vis, user, { limit: vis.length });
  _lastReasonMap = {};
  _lastRelaxedMap = {};
  items.forEach(function (p) {
    _lastReasonMap[p.passageId] = p.recommendationReason || '';
    if (p.relaxed) _lastRelaxedMap[p.passageId] = p.relaxed;
  });
  return items.map(function (p) { return 'p:' + p.passageId; });
}
function ensureFeed() {
  if (!S.feed || !S.feed.order || !S.feed.order.length) {
    S.feed = { roundId: Date.now(), order: buildFullOrder(), cursor: 0, reasonMap: _lastReasonMap, relaxedMap: _lastRelaxedMap };
    persist('feed');
  } else if (!S.feed.reasonMap) {
    /* 兼容 v37 前已持久化的存量 feed：按当前画像补算理由，不打乱既有顺序与进度 */
    var buser = { interests: S.interests, interestsAt: S.interestsAt, topicWeights: S.topicWeights, topicLastTouched: S.topicLastTouched, liked: Object.keys(S.likes), saved: Object.keys(S.saves), hidden: S.hidden, seen: Object.keys(S.history) };
    S.feed.reasonMap = {};
    S.feed.order.forEach(function (id) {
      if (id.charAt(0) === 'p' && PASSAGE[id.slice(2)]) S.feed.reasonMap[id.slice(2)] = RECOMMENDER.reasonFor(PASSAGE[id.slice(2)], buser, Date.now());
    });
    persist('feed');
  }
}
function rebuildTail(opts) {
  // 保留已浏览前缀；keepCurrent 时连当前卡片一起保留（PRD：修改兴趣不动当前卡片）；
  // 未浏览的本机发布（u:）不参与重混排，始终保留（AC-15/19 联动）
  ensureFeed();
  var keepN = opts && opts.keepCurrent ? S.feed.cursor + 1 : S.feed.cursor;
  var viewed = S.feed.order.slice(0, keepN);
  var viewedSet = {};
  viewed.forEach(function (id) { viewedSet[id] = 1; });
  var keep = S.feed.order.slice(keepN).filter(function (id) { return id.charAt(0) === 'u'; });
  var vis = visiblePassages().filter(function (p) { return !viewedSet['p:' + p.passageId]; });
  var user = { interests: S.interests, interestsAt: S.interestsAt, topicWeights: S.topicWeights, topicLastTouched: S.topicLastTouched, liked: Object.keys(S.likes), saved: Object.keys(S.saves), hidden: S.hidden, seen: viewed.map(function (id) { return id.slice(2); }) };
  var items = RECOMMENDER.buildFeed(vis, user, { limit: vis.length });
  var reasonMap = {};
  viewed.forEach(function (id) {
    if (id.charAt(0) === 'p' && S.feed.reasonMap && S.feed.reasonMap[id.slice(2)]) reasonMap[id.slice(2)] = S.feed.reasonMap[id.slice(2)];
  });
  items.forEach(function (p) { reasonMap[p.passageId] = p.recommendationReason || ''; });
  var relaxedMap = S.feed.relaxedMap || {};
  var newRelaxed = {};
  viewed.forEach(function (id) {
    if (id.charAt(0) === 'p' && relaxedMap[id.slice(2)]) newRelaxed[id.slice(2)] = relaxedMap[id.slice(2)];
  });
  items.forEach(function (p) { if (p.relaxed) newRelaxed[p.passageId] = p.relaxed; });
  var tail = items.map(function (p) { return 'p:' + p.passageId; });
  tail = keep.concat(tail);
  if (opts && opts.insertFirst) { tail = opts.insertFirst.concat(tail); }
  S.feed.order = viewed.concat(tail);
  S.feed.reasonMap = reasonMap;
  S.feed.relaxedMap = newRelaxed;
  persist('feed');
}
function feedItemOf(id) {
  if (id.charAt(0) === 'u') {
    var pub = S.publishes.filter(function (p) { return p.id === id.slice(2); })[0];
    return pub ? { kind: 'publish', pub: pub } : null;
  }
  var p = PASSAGE[id.slice(2)];
  return p ? { kind: 'passage', p: p } : null;
}

/* ============ 浮层 ============ */
var toastTimer = null;
function toast(msg, ms) {
  var t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 1900);
}
var sheetState = { onclose: null };
function openSheet(html, cls, onclose) {
  var root = $('#sheet-root');
  root.innerHTML = '<div class="sheet ' + (cls || '') + '"><div class="mask"></div><div class="panel">' + html + '</div></div>';
  sheetState.onclose = onclose || null;
  var sheet = root.firstElementChild;
  sheet.querySelector('.mask').addEventListener('click', closeSheet);
  return sheet;
}
function closeSheet() {
  var root = $('#sheet-root');
  if (root.innerHTML && sheetState.onclose) sheetState.onclose();
  root.innerHTML = '';
  sheetState.onclose = null;
}
function confirmSheet(opt) {
  var sh = openSheet(
    '<h3>' + opt.title + '</h3><p>' + (opt.text || '') + '</p>' +
    '<div class="row"><button class="b" data-c="cancel">' + (opt.cancel || '取消') + '</button>' +
    '<button class="c' + (opt.danger ? ' danger' : '') + '" data-c="ok">' + (opt.ok || '确认') + '</button></div>',
    'confirm');
  sh.querySelector('[data-c="cancel"]').addEventListener('click', closeSheet);
  sh.querySelector('[data-c="ok"]').addEventListener('click', function () {
    closeSheet();
    opt.onOk();
  });
}

/* ============ SVG 图标 ============ */
var ICON = {
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-9.3-8.6C1 8 2.6 4.6 6 4.2c2-.3 3.9.7 6 3 2.1-2.3 4-3.3 6-3 3.4.4 5 3.8 3.3 7.2C19 15.6 12 20 12 20z"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24"><path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1z"/></svg>',
  comment: '<svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 12v7h14v-7"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v9h-5v-6h-6v6H4z"/></svg>',
  compass: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M15 9l-2 5-4 2 2-5z"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-5.5 8-5.5s6.5 1.5 8 5.5"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M9 4v16"/></svg>'
};

/* ============ 导航栈 ============ */
var stack = [];
function go(page, data) {
  stack.push({ page: page, data: data || {} });
  render();
}
function back() {
  var t = top();
  /* AC-12：阅读链（reader/book 连续帧）退出时直接回任务来源，不逐级回退 */
  if (t.page === 'reader' && stack.length > 1) {
    var i = stack.length - 1;
    while (i > 0 && (stack[i].page === 'reader' || stack[i].page === 'book')) i--;
    stack = stack.slice(0, i + 1);
    render();
    return true;
  }
  if (stack.length > 1) { stack.pop(); render(); return true; }
  return false;
}
function resetTo(page, data) {
  stack = [{ page: page, data: data || {} }];
  render();
}
function top() { return stack[stack.length - 1]; }

/* ============ 渲染调度 ============ */
var app = $('#app');
var editorBack = null; /* AC-18：编辑页返回钩子（含放弃确认） */
function render() {
  closeSheet();
  editorBack = null;
  var t = top();
  if (t.page === 'start') renderStart();
  else if (t.page === 'home') renderHome(t.data);
  else if (t.page === 'endround') renderEndroundPage();
  else if (t.page === 'book') renderBook();
  else if (t.page === 'reader') renderReader(t.data);
  else if (t.page === 'choose') renderChoose();
  else if (t.page === 'editor') renderEditor(t.data);
  else if (t.page === 'preview') renderPreview(t.data);
  else if (t.page === 'share') renderShare(t.data);
  else if (t.page === 'mine') renderMine();
  else if (t.page === 'list') renderList(t.data);
  else if (t.page === 'pubdetail') renderPubDetail(t.data);
  else if (t.page === 'settings') renderSettings();
  if (t.page !== 'home') app.scrollTop = 0;
}

/* ============ PG-01 兴趣选择 ============ */
function renderStart() {
  var el = document.createElement('div');
  el.className = 'page';
  el.innerHTML =
    '<div class="start">' +
    '<h1>你想被哪种<br>文字遇见？</h1>' +
    '<p class="why">选 1–3 个此刻的兴趣，书流按它给你混排片段。<br>不想选也可以直接开始。</p>' +
    '<div class="chips">' + TOPICS.map(function (t) {
      return '<button class="chip' + (S.interests.indexOf(t) >= 0 ? ' on' : '') + '" data-t="' + t + '">' + t + '</button>';
    }).join('') + '</div>' +
    '<p class="chip-note">兴趣只保存在本机，随时可以在「我的」里调整。</p>' +
    '<div class="go">' +
    '<button class="btn-p" id="st-go">开始看书流</button>' +
    '<button class="btn-g" id="st-skip">跳过，随机遇见</button>' +
    '</div></div>';
  app.innerHTML = '';
  app.appendChild(el);
  el.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (chip) {
      var t = chip.dataset.t;
      var i = S.interests.indexOf(t);
      if (i >= 0) { S.interests.splice(i, 1); chip.classList.remove('on'); }
      else {
        if (S.interests.length >= 3) { toast('最多选 3 个兴趣'); return; }
        S.interests.push(t); chip.classList.add('on');
      }
      persist('interests');
      return;
    }
    if (e.target.closest('#st-go')) { S.onboarded = true; persist('onboarded'); S.feed = null; rebuildHomeAndGo(); }
    if (e.target.closest('#st-skip')) { S.interests = []; persist('interests'); S.onboarded = true; persist('onboarded'); S.feed = null; rebuildHomeAndGo(); }
  });
}
function rebuildHomeAndGo() {
  S.feed = null;
  ensureFeed();
  resetTo('home');
}

/* ============ PG-02 首页书流 ============ */
var RESUME_TOAST_MS = 10000; /* 「继续阅读」浮层停留时长（进入首页弹出，约 10s 后自动消失） */
function currentFeedItem() {
  ensureFeed();
  return feedItemOf(S.feed.order[S.feed.cursor]);
}
function dismissResume() {
  clearTimeout(S._resumeTimer);
  var t = $('#resume');
  if (!t || t.classList.contains('hide')) return;
  t.classList.add('hide');
  setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
}
function renderHome() {
  var el = document.createElement('div');
  el.className = 'page home';
  var resume = latestHistory();
  var item = currentFeedItem();
  el.innerHTML =
    '<div class="feed" id="feed"></div>' +
    '<div class="deck-dots" id="dots"></div>' +
    navHTML('home');
  app.innerHTML = '';
  app.appendChild(el);
  if (resume) {
    /* 继续阅读：浮动提示条，进入首页时滑入，停留 RESUME_TOAST_MS 后自动淡出；点 × 可提前关闭 */
    var rt = document.createElement('button');
    rt.className = 'resume-toast'; rt.id = 'resume';
    rt.innerHTML = '<span><span class="l1">继续阅读：' + BOOK[resume.bookId].title + ' · 第' + numCN(resume.number) + '回</span>' +
      '<span class="l2">上次读到 ' + resume.title + '</span></span><span class="x" aria-label="关闭">×</span>';
    el.appendChild(rt);
    rt.addEventListener('click', function (e) {
      var viaX = e.target.closest('.x');
      dismissResume();
      if (viaX) return;
      go('reader', { chapterId: resume.chapterId, resume: true, resumePara: resume.paraIdx, resumeOff: resume.off || 0 });
    });
    S._resumeTimer = setTimeout(dismissResume, RESUME_TOAST_MS);
  }
  var pending = S.store_pending;
  if (pending) {
    S.store_pending = null;
    STORE.remove('pending');
    rebuildTail({ insertFirst: ['u:' + pending], keepCurrent: true });
    toast('已把你的片段排进首页');
  }
  mountFeed($('#feed', el), currentFeedItem());
  bindFeedOnce(el);
  bindNav(el, 'home');
}
function bindFeedOnce(scope) {
  // 事件只绑一次（feed 容器在切卡时不重建），卡片行为用委托
  var feed = $('#feed', scope);
  feed.addEventListener('click', function (e) {
    if (e.target.closest('#er-again')) { S.feed = null; ensureFeed(); mountFeed(feed, currentFeedItem()); return; }
    if (e.target.closest('#er-tune')) { go('settings'); return; }
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var item = currentFeedItem();
    if (!item) return;
    var act = btn.dataset.act;
    if (act === 'go-src' || act === 'go-src2') {
      if (item.kind === 'publish') go('pubdetail', { id: item.pub.id });
      else { recordRecommendationFeedback('open_original', item.p); go('reader', { chapterId: item.p.chapterId, passageId: item.p.passageId }); }
    } else if (act === 'like') { toggleLike(item.p.passageId, btn); }
    else if (act === 'save') { toggleSave(item.p.passageId, btn); }
    else if (act === 'comment') { openComments(item.p.passageId); }
    else if (act === 'more') { moreMenu(item); }
    else if (act === 'share') {
      go('share', item.kind === 'publish' ? { pub: item.pub } : { passage: item.p });
    }
    else if (act === 'mine') { resetTo('mine'); }
  });
  var y0 = null;
  feed.addEventListener('touchstart', function (e) { y0 = e.touches[0].clientY; }, { passive: true });
  feed.addEventListener('touchend', function (e) {
    if (y0 === null) return;
    var dy = e.changedTouches[0].clientY - y0;
    y0 = null;
    if (dy < -44) feedNext(feed);
    else if (dy > 44) feedPrev(feed);
  }, { passive: true });

  /* 桌面端翻页：滚轮 / 鼠标拖拽 / 方向键（复用 feedNext/feedPrev，与触屏同一埋点口径） */
  var wheelLock = 0; /* 一次滚动手势会连发多个 wheel 事件，450ms 锁防连翻 */
  feed.addEventListener('wheel', function (e) {
    var now = Date.now();
    if (now < wheelLock || Math.abs(e.deltaY) < 30) return;
    wheelLock = now + 450;
    if (e.deltaY > 0) feedNext(feed); else feedPrev(feed);
  }, { passive: true });
  var my0 = null;
  feed.addEventListener('mousedown', function (e) { my0 = e.clientY; });
  feed.addEventListener('mouseup', function (e) {
    if (my0 === null) return;
    var dy = e.clientY - my0;
    my0 = null;
    if (String(window.getSelection())) return; /* 用户在划选文本，不翻页 */
    if (dy < -44) feedNext(feed);
    else if (dy > 44) feedPrev(feed);
  });
  var onFeedKey = function (e) {
    if (!document.contains(feed)) { document.removeEventListener('keydown', onFeedKey); return; }
    if ($('#sheet-root').innerHTML) return; /* 弹层打开时不翻页 */
    if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); feedNext(feed); }
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); feedPrev(feed); }
  };
  document.addEventListener('keydown', onFeedKey);
}
function latestHistory() {
  var best = null;
  Object.keys(S.history).forEach(function (bid) {
    var h = S.history[bid];
    if (!best || h.updatedAt > best.updatedAt) best = h;
  });
  return best;
}
function numCN(n) { return n; }
/* 作者显示文本：兼容遗留字符串与百本导入的 {dynasty, name, intro} 对象 */
function authorText(b) {
  var a = b && b.author;
  if (a && typeof a === 'object') {
    var d = a.dynasty && a.dynasty !== '未知' ? a.dynasty + ' · ' : '';
    return (d + (a.name || '')) || '';
  }
  return a || '';
}

function mountFeed(scope, item) {
  var feed = typeof scope === 'string' ? $('#feed', scope) : scope;
  var dots = $('#dots', scope.closest ? scope.closest('.page') || document : document);
  if (!item) { renderEndroundView(feed); return; }
  feed.innerHTML = cardHTML(item);
  /* 埋点：卡片曝光起点，供上滑时计算停留时长（≥4s 记完读，<4s 记快速划走） */
  S._cardShownAt = Date.now();
  // 双击点赞：仅设置，不取消（PRD 5.4）
  if (item.kind === 'passage') {
    $('.card', feed).addEventListener('dblclick', function () {
      var pid = item.p.passageId;
      if (!S.likes[pid]) {
        S.likes[pid] = Date.now();
        if (persist('likes')) {
          recordRecommendationFeedback('like', PASSAGE[pid]); /* 与点 ❤ 按钮同一事件入口，口径统一 */
          toast('已喜欢'); var b = $('[data-act="like"]', feed); if (b) b.classList.add('on');
        }
      } else { toast('已经在喜欢的列表里了'); }
    });
  }
  var label = item.kind === 'publish' ? '本机发布' : '第 ' + (S.feed.cursor + 1) + ' 条';
  var hint = ('ontouchstart' in window) ? '上滑换下一段' : '滚轮 / ↑↓ 键换段';
  dots.innerHTML = '<span style="font-size:11px;color:var(--sub)">' + label + ' · ' + hint + '</span>';
}
function commentCount(pid) {
  return (C.demo_comments || []).filter(function (c) { return c.passageId === pid; }).length;
}
function cardHTML(item) {
  var p, srcBook, srcCh;
  /* 底部书籍信息：垂直两层——《书名》(主) + 章节(截断) + 查看原文 CTA（UI 重构：书名 > 章节 > 原文入口） */
  if (item.kind === 'publish') {
    var pub = item.pub;
    srcBook = BOOK[pub.bookId]; srcCh = pub.chapterTitle;
    return '<div class="cardwrap"><div class="card" data-kind="publish">' +
      '<div class="kicker">我发布的片段</div>' +
      '<div class="body"><div class="text">' + esc(pub.text) + '</div></div>' +
      '<div class="src">' +
      (pub.thought ? '<div class="ct">感想：' + esc(pub.thought) + '</div>' : '') +
      '<div class="src-t">《' + srcBook.title + '》<span class="src-a"> · ' + esc(authorText(srcBook)) + '</span></div>' +
      '<div class="src-row"><span class="ct">' + esc(srcCh) + '</span>' +
      '<button class="go" data-act="go-src">查看原文 →</button></div></div>' +
      '<div class="actions">' +
      actBtn('go-src2', '原文') + actBtn('share', '分享') + actBtn('mine', '管理') +
      '</div></div>';
  }
  p = item.p;
  srcBook = BOOK[p.bookId];
  srcCh = chTitle(p.chapterId);
  var reason = (S.feed && S.feed.reasonMap && S.feed.reasonMap[p.passageId]) || '';
  return '<div class="cardwrap"><div class="card" data-pid="' + p.passageId + '">' +
    '<div class="kicker">' + esc(p.intro) + '</div>' +
    (reason ? '<div class="reason">' + esc(reason) + '</div>' : '') +
    '<div class="body"><div class="text">' + esc(p.text) + '</div></div>' +
    '<div class="src">' +
    '<div class="src-t">《' + srcBook.title + '》<span class="src-a"> · ' + esc(authorText(srcBook)) + '</span></div>' +
    '<div class="src-row"><span class="ct">' + esc(srcCh) + '</span>' +
    '<button class="go" data-act="go-src">查看原文 →</button></div></div>' +
    '<div class="actions">' +
    actBtn('like', '喜欢', !!S.likes[p.passageId], S.likes[p.passageId] ? 1 : 0) +
    actBtn('save', '收藏', !!S.saves[p.passageId], S.saves[p.passageId] ? 1 : 0) +
    actBtn('comment', '评论', false, commentCount(p.passageId)) +
    actBtn('more', '更多') +
    '</div></div>';
}
/* 右侧操作栏：默认只显示图标 + 计数（无文字标签），信息流口径 */
function actBtn(act, label, on, count) {
  var map = { 'go-src2': 'book', like: 'heart', save: 'bookmark', mine: 'user' };
  return '<button data-act="' + act + '"' + (on ? ' class="on"' : '') + ' aria-label="' + label + '">' + ICON[map[act] || act] +
    (count ? '<span class="n">' + count + '</span>' : '') + '</button>';
}
function bindCard() {} /* 已由 bindFeedOnce 委托替代 */
function feedNext(feed) {
  /* 上滑离开当前卡片：按停留时长记完读或快速划走（PRD §2 事件表；≥4s 记完读 +0.3，
     <4s 记 quick_skip——引擎内连续 2 次同主题才计 −0.5，避免误伤） */
  var cur = currentFeedItem();
  if (cur && cur.kind === 'passage' && RECOMMENDER) {
    var dwell = Date.now() - (S._cardShownAt || Date.now());
    recordRecommendationFeedback(dwell >= 4000 ? 'view_complete' : 'quick_skip', cur.p);
  }
  if (S.feed.cursor >= S.feed.order.length - 1) {
    // 轮末
    renderEndround(); return;
  }
  S.feed.cursor++;
  persist('feed');
  animateSwap(feed, 1);
}
function feedPrev(feed) {
  if (S.feed.cursor <= 0) { toast('已经是第一条了'); return; }
  S.feed.cursor--;
  persist('feed');
  animateSwap(feed, -1);
}
function animateSwap(feed, dir) {
  var cur = feed.firstElementChild;
  if (cur) cur.classList.add(dir > 0 ? 'out-up' : 'in-down');
  setTimeout(function () {
    mountFeed(feed, currentFeedItem());
  }, 160);
}
function renderEndroundView(feed) {
  // 按钮点击由 bindFeedOnce 委托处理
  feed.innerHTML = '<div class="endround"><h2>本轮精选已看完</h2>' +
    '<p>你可以再看一轮，或者调整兴趣，<br>遇见新的片段组合。</p>' +
    '<div class="col"><button class="btn-p" id="er-again">再看一轮</button>' +
    '<button class="btn-g" id="er-tune">调整兴趣</button></div></div>';
}
function renderEndround() { resetTo('endround'); }
function renderEndroundPage() {
  var el = document.createElement('div');
  el.className = 'page';
  el.innerHTML =
    '<div class="endround"><h2>本轮精选已看完</h2>' +
    '<p>你可以再看一轮，或者调整兴趣，<br>遇见新的片段组合。</p>' +
    '<div class="col"><button class="btn-p" id="ep-again">再看一轮</button>' +
    '<button class="btn-g" id="ep-tune">调整兴趣</button></div></div>' +
    navHTML('home');
  app.innerHTML = '';
  app.appendChild(el);
  el.addEventListener('click', function (e) {
    if (e.target.closest('#ep-again')) { S.feed = null; ensureFeed(); resetTo('home'); }
    if (e.target.closest('#ep-tune')) { go('settings'); }
  });
  bindNav(el, 'home');
}
function toggleLike(pid, btn) {
  var was = !!S.likes[pid];
  if (was) delete S.likes[pid]; else S.likes[pid] = Date.now();
  if (persist('likes')) {
    recordRecommendationFeedback(was ? 'unlike' : 'like', PASSAGE[pid]);
    btn.classList.toggle('on', !was);
    toast(was ? '已取消喜欢' : '已喜欢');
  } else { loadState(); }
}
function toggleSave(pid, btn) {
  var was = !!S.saves[pid];
  if (was) delete S.saves[pid]; else S.saves[pid] = Date.now();
  if (persist('saves')) {
    recordRecommendationFeedback(was ? 'unsave' : 'save', PASSAGE[pid]);
    btn.classList.toggle('on', !was);
    toast(was ? '已取消收藏' : '已收藏');
  } else { loadState(); }
}
function moreMenu(item) {
  var sh = openSheet(
    '<ul style="padding:8px 0 20px">' +
    '<li><button class="row" data-m="share" style="width:100%">生成分享卡</button></li>' +
    '<li><button class="row" data-m="hide" style="width:100%;color:#A5482E">不感兴趣，不再让我看到它</button></li>' +
    '<li><button class="row" data-m="cancel" style="width:100%">取消</button></li>' +
    '</ul>');
  sh.addEventListener('click', function (e) {
    var b = e.target.closest('[data-m]');
    if (!b) return;
    closeSheet();
    if (b.dataset.m === 'share') {
      go('share', { passage: item.p });
    } else if (b.dataset.m === 'hide') {
      var pid = item.p.passageId;
      S.hidden.push(pid);
      if (persist('hidden')) {
        recordRecommendationFeedback('not_interested', item.p);
        var sc = top();
        rebuildTail();
        toast('已隐藏这条片段', 2600);
        mountFeed($('#feed'), currentFeedItem());
      }
    }
  });
}

/* ============ 底部导航 ============ */
function navHTML(on) {
  function t(id, label, icon) {
    return '<button data-nav="' + id + '"' + (on === id ? ' class="on"' : '') + '>' + ICON[icon] + '<span>' + label + '</span></button>';
  }
  return '<nav class="nav">' + t('home', '首页', 'home') + t('publish', '发布', 'compass') + t('mine', '我的', 'user') + '</nav>';
}
function bindNav(scope, on) {
  scope.addEventListener('click', function (e) {
    var b = e.target.closest('[data-nav]');
    if (!b) return;
    var id = b.dataset.nav;
    if (id === on) return;
    if (id === 'home') resetTo('home');
    else if (id === 'publish') resetTo('choose');
    else if (id === 'mine') resetTo('mine');
  });
}

/* ============ 本书精选（PG-04） ============ */
function renderBook() {
  var bid = top().data.bookId || 'hlm';
  var book = BOOK[bid];
  var el = document.createElement('div');
  el.className = 'page';
  var ps = C.passages.filter(function (p) { return p.bookId === bid; });
  el.innerHTML =
    '<div class="topbar"><button class="back" data-b>←</button><div><div class="tt">' + book.title + '</div><div class="crumb">本书精选</div></div></div>' +
    '<div class="scroll">' +
    '<div class="bk-head"><h2>本书精选片段</h2><p class="meta">' + esc(authorText(book)) + ' · ' + ps.length + ' 条 · 均来自已收录章节</p></div>' +
    '<div class="ps-list">' + ps.map(function (p) {
      return '<button class="ps-item" data-pid="' + p.passageId + '"><div class="p">' + esc(p.text) + '</div>' +
        '<div class="m">' + esc(p.intro) + '</div></button>';
    }).join('') + '</div>' +
    '<div class="bk-head" style="padding-top:0"><h2 style="font-size:16px">已收录章节</h2></div>' +
    '<div class="ch-list">' + book.chapters.map(function (c) {
      return '<button class="ch-item" data-cid="' + c.chapterId + '"><span class="n">第' + c.number + '回</span><span>' + esc(c.title) + '</span></button>';
    }).join('') + '</div></div>' +
    navHTML('home');
  app.innerHTML = '';
  app.appendChild(el);
  el.querySelector('[data-b]').addEventListener('click', back);
  el.addEventListener('click', function (e) {
    var ps2 = e.target.closest('.ps-item');
    if (ps2) { go('reader', { chapterId: PASSAGE[ps2.dataset.pid].chapterId, passageId: ps2.dataset.pid }); return; }
    var ch = e.target.closest('.ch-item');
    if (ch) { go('reader', { chapterId: ch.dataset.cid }); return; }
    if (e.target.closest('[data-nav]')) { /* handled below */ }
  });
  bindNav(el, 'home');
}

/* ============ 章节定位工具 ============ */
function chTitle(cid) {
  var doc = C.chapters[cid];
  if (!doc) return '（章节信息缺失）';
  var b = BOOK[doc.bookId];
  var c = b.chapters.filter(function (x) { return x.chapterId === cid; })[0];
  if (!c) return '（章节信息缺失）';
  return c.number > 0 ? '第' + c.number + '回　' + c.title : c.title;
}
function rebuildSnapshot(paras, loc) {
  // 与构建脚本一致：跨段以 \n 连接；code point 偏移
  var p1 = paras[loc.sp], p2 = paras[loc.ep];
  if (loc.sp === loc.ep) return sliceCP(p1, loc.so, loc.eo);
  var parts = [sliceCP(p1, loc.so, undefined)]
    .concat(paras.slice(loc.sp + 1, loc.ep))
    .concat([sliceCP(p2, 0, loc.eo)]);
  return parts.join('\n');
}
function verifyLoc(chapter, p) {
  try {
    var paras = chapter.paragraphs;
    var loc = p.loc;
    if (!paras || !loc || loc.sp < 0 || loc.sp > loc.ep || loc.ep >= paras.length) return false;
    return rebuildSnapshot(paras, loc) === p.text;
  } catch (e) { return false; }
}

/* ============ 章节正文懒加载（百本库：正文按书分包 content/text/{bookId}.js） ============ */
var _textLoading = {};
var _APP_BASE = (function () {
  var m = document.querySelector('script[src*="app.js"]');
  return m ? m.src.replace(/app\.js.*$/, '') : '';
})();
function getChapterParas(bookId, chapterId) {
  var T = window.SHULIU_TEXT;
  return (T && T[bookId] && T[bookId][chapterId]) || null;
}
function loadBookText(bookId, cb) {
  var T = window.SHULIU_TEXT;
  if (T && T[bookId]) { cb(null, T[bookId]); return; }
  if (_textLoading[bookId]) { _textLoading[bookId].push(cb); return; }
  _textLoading[bookId] = [cb];
  var s = document.createElement('script');
  s.src = _APP_BASE + 'content/text/' + bookId + '.js';
  s.onload = function () {
    var q = _textLoading[bookId] || []; delete _textLoading[bookId];
    var map = window.SHULIU_TEXT && window.SHULIU_TEXT[bookId];
    q.forEach(function (f) { f(map ? null : 'empty', map); });
  };
  s.onerror = function () {
    var q = _textLoading[bookId] || []; delete _textLoading[bookId];
    q.forEach(function (f) { f('load-fail'); });
  };
  document.head.appendChild(s);
}

/* ============ PG-03 原文阅读 ============ */
var readerState = null;
function renderReaderMissing() {
  var miss = document.createElement('div');
  miss.className = 'page reader';
  miss.innerHTML = '<div class="topbar"><button class="back" data-b>←</button><div><div class="tt">内容缺失</div><div class="crumb">本章暂未收录</div></div></div>' +
    '<div class="scroll"><div class="empty">这一章的内容暂时缺失，稍后再来看看。</div></div>';
  app.innerHTML = '';
  app.appendChild(miss);
  miss.querySelector('[data-b]').addEventListener('click', back);
}
function renderReader(data) {
  var meta = C.chapters[data.chapterId];
  if (!meta) { /* AC-11/23：缺章降级，不误打开、不崩溃 */
    renderReaderMissing();
    return;
  }
  var cached = getChapterParas(meta.bookId, data.chapterId);
  if (cached) { renderReaderBody(data, meta, cached); return; }
  /* 正文按书分包，首次打开需加载：先占位，成功后守卫渲染（快速切换不回写旧章） */
  var el = document.createElement('div');
  el.className = 'page reader';
  el.innerHTML = '<div class="topbar"><button class="back" data-b>←</button><div><div class="tt">' + esc(BOOK[meta.bookId] ? BOOK[meta.bookId].title : '') + '</div><div class="crumb">正在打开本章…</div></div></div>' +
    '<div class="scroll"><div class="empty">正在打开本章…</div></div>';
  app.innerHTML = '';
  app.appendChild(el);
  el.querySelector('[data-b]').addEventListener('click', back);
  loadBookText(meta.bookId, function (err, map) {
    var t = top();
    if (t.page !== 'reader' || t.data.chapterId !== data.chapterId) return;
    if (err || !map || !map[data.chapterId]) { renderReaderMissing(); return; }
    renderReaderBody(data, meta, map[data.chapterId]);
  });
}
function renderReaderBody(data, ch, paras) {
  var book = BOOK[ch.bookId];
  var el = document.createElement('div');
  el.className = 'page reader';
  var passage = data.passageId ? PASSAGE[data.passageId] : null;
  var locOK = false;
  if (passage) locOK = verifyLoc({ paragraphs: paras }, passage);

  // 组装段落 HTML（含高亮）
  var html = '';
  paras.forEach(function (t, i) {
    if (passage && locOK && i >= passage.loc.sp && i <= passage.loc.ep) {
      var seg;
      if (passage.loc.sp === passage.loc.ep) {
        seg = esc(sliceCP(t, 0, passage.loc.so)) + '<mark>' + esc(sliceCP(t, passage.loc.so, passage.loc.eo)) + '</mark>' + esc(sliceCP(t, passage.loc.eo, undefined));
      } else if (i === passage.loc.sp) {
        seg = esc(sliceCP(t, 0, passage.loc.so)) + '<mark>' + esc(sliceCP(t, passage.loc.so, undefined)) + '</mark>';
      } else if (i === passage.loc.ep) {
        seg = '<mark>' + esc(sliceCP(t, 0, passage.loc.eo)) + '</mark>' + esc(sliceCP(t, passage.loc.eo, undefined));
      } else {
        seg = '<mark>' + esc(t) + '</mark>';
      }
      html += '<p class="para" data-pi="' + i + '">' + seg + '</p>';
    } else {
      html += '<p class="para" data-pi="' + i + '">' + esc(t) + '</p>';
    }
  });
  var nextCh = nextChapter(ch);
  el.innerHTML =
    '<div class="topbar"><button class="back" data-b>←</button>' +
    '<div><div class="tt">' + book.title + '</div><div class="crumb">第' + ch.number + '回 · ' + esc(ch.title) + '</div></div>' +
    '<button class="go" data-act="book" style="margin-left:auto;font-size:13px;color:var(--pine);font-weight:600">本书精选</button></div>' +
    '<div class="scroll" id="rscroll"><div class="chapter-t">' + esc(ch.title) + '</div>' + html + '</div>' +
    '<div class="reader-tools">' +
    '<button class="tool-btn" data-act="prev-ch"' + (prevChapter(ch) ? '' : ' disabled') + '>上一章</button>' +
    '<button class="tool-btn pri" data-act="back-hl">回到片段</button>' +
    '<button class="tool-btn" data-act="next-ch"' + (nextCh ? '' : ' disabled') + '>下一章</button>' +
    '</div>';
  app.innerHTML = '';
  app.appendChild(el);

  readerState = { ch: ch, passage: passage, selPop: null };
  var scroll = $('#rscroll', el);

  el.querySelector('[data-b]').addEventListener('click', back);
  el.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.dataset.act;
    if (act === 'book') go('book', { bookId: ch.bookId });
    else if (act === 'prev-ch') {
      if (prevChapter(ch)) { stack[stack.length - 1] = { page: 'reader', data: { chapterId: prevChapter(ch) } }; render(); }
    }
    else if (act === 'next-ch') {
      var n = nextChapter(ch);
      if (n) { stack[stack.length - 1] = { page: 'reader', data: { chapterId: n } }; render(); }
      else toast('下一章尚未收录');
    }
    else if (act === 'back-hl') {
      if (passage && locOK) scrollToLoc(scroll, passage);
      else if (data.resume && data.resumePara != null) restoreResume(scroll, data);
      else toast('没有可回的片段');
    }
  });

  // 定位或续读（同步执行，不依赖 rAF——隐藏帧/预渲染环境下 rAF 不触发）
  (function () {
    if (passage) {
      if (locOK) {
        scrollToLoc(scroll, passage);
        if (data.noNote !== true) showLocNote('已定位到片段', el);
      } else {
        // AC-20：定位失败降级——不伪装成功
        scroll.scrollTop = 0;
        showLocNote('暂时无法定位，已打开本章', el);
      }
    } else if (data.resume && data.resumePara != null) {
      restoreResume(scroll, data);
    }
  })();

  // 滚动保存阅读历史（PRD 13.2 ReadingHistory / AC-05 返回保位）
  // PRD 260：正文成功打开且处于前台时即更新阅读位置，不等首次滚动
  function saveHistory() {
    var mid = scroll.scrollTop + scroll.clientHeight / 2;
    var pi = 0, off = 0;
    var ps = scroll.querySelectorAll('.para');
    for (var i = 0; i < ps.length; i++) {
      if (ps[i].offsetTop <= mid) { pi = i; off = scroll.scrollTop - ps[i].offsetTop; }
    }
    S.history[ch.bookId] = {
      bookId: ch.bookId, chapterId: ch.chapterId, number: ch.number, title: ch.title,
      paraIdx: pi, off: off, updatedAt: Date.now()
    };
    persist('history');
  }
  saveHistory();
  var st = null;
  scroll.addEventListener('scroll', function () {
    if (st) clearTimeout(st);
    st = setTimeout(saveHistory, 700);
  }, { passive: true });

  // 划选发布（PRD FR-07 / AC-11）
  bindSelection(el, scroll, ch, data, paras);

  // Esc 返回（AC-09）
  readerState.escHandler = function (e) { if (e.key === 'Escape') back(); };
  document.addEventListener('keydown', readerState.escHandler);
}
function showLocNote(text, scope) {
  var n = document.createElement('div');
  n.className = 'locate-note';
  n.textContent = text;
  scope.appendChild(n);
  setTimeout(function () { n.remove(); }, 2400);
}
function scrollToLoc(scroll, passage) {
  var m = scroll.querySelector('mark');
  if (!m) return;
  var y = m.offsetTop - scroll.clientHeight * 0.22;
  scroll.scrollTop = Math.max(0, y);
}
function restoreResume(scroll, data) {
  var ps = scroll.querySelectorAll('.para');
  var p = ps[data.resumePara];
  if (p) scroll.scrollTop = Math.max(0, p.offsetTop + (data.resumeOff || 0));
}
function prevChapter(ch) {
  var book = BOOK[ch.bookId];
  var i = book.chapters.map(function (c) { return c.chapterId; }).indexOf(ch.chapterId);
  return i > 0 ? book.chapters[i - 1].chapterId : null;
}
function nextChapter(ch) {
  var book = BOOK[ch.bookId];
  var i = book.chapters.map(function (c) { return c.chapterId; }).indexOf(ch.chapterId);
  return i < book.chapters.length - 1 ? book.chapters[i + 1].chapterId : null;
}

/* 划选 → 发布片段（from 区分两种入口：publish=导航发布，其他=正文阅读中划选） */
function bindSelection(scope, scroll, ch, data, paras) {
  function cpOffsetInPara(pEl, node, no) {
    var acc = 0, found = false;
    Array.prototype.forEach.call(pEl.childNodes, function (c) {
      if (found) return;
      if (c === node || c.contains(node)) {
        var txt = c.textContent;
        if (c === node) acc += cpLen(txt.slice(0, no));
        else acc += cpLen(txt.slice(0, Math.min(no, cpLen(txt))));
        found = true;
      } else {
        acc += cpLen(c.textContent);
      }
    });
    return acc;
  }
  function paraOf(node) {
    while (node && node !== scroll) {
      if (node.nodeType === 1 && node.dataset && node.dataset.pi != null) return node;
      node = node.parentNode;
    }
    return null;
  }
  function showPop(x, y, selInfo) {
    hidePop();
    var pop = document.createElement('div');
    pop.className = 'sel-pop';
    pop.style.left = Math.max(8, Math.min(x - 40, scroll.clientWidth - 130)) + 'px';
    pop.style.top = Math.max(8, y - 52) + 'px';
    pop.innerHTML = '<button style="color:#fff;font-size:14px">发布这段</button>';
    pop.addEventListener('click', function () {
      hidePop();
      go('editor', { chapterId: ch.chapterId, loc: selInfo.loc, text: selInfo.text, from: data.from });
    });
    scroll.appendChild(pop);
    readerState.selPop = pop;
  }
  function hidePop() {
    if (readerState.selPop) { readerState.selPop.remove(); readerState.selPop = null; }
  }
  function computeSel() {
    var s = window.getSelection();
    if (!s || s.isCollapsed || s.rangeCount === 0) return null;
    var r = s.getRangeAt(0);
    var p1 = paraOf(r.startContainer), p2 = paraOf(r.endContainer);
    if (!p1 || !p2) return null;
    var sp = +p1.dataset.pi, ep = +p2.dataset.pi;
    if (sp > ep) { var t = p1; p1 = p2; p2 = t; t = sp; sp = ep; ep = t; }
    var so = cpOffsetInPara(p1, r.startContainer === p1 ? r.startContainer : r.startContainer, r.startOffset);
    so = cpOffsetInPara(p1, r.startContainer, r.startOffset);
    var eo = cpOffsetInPara(p2, r.endContainer, r.endOffset);
    if (sp === ep && so >= eo) return null;
    var text = rebuildSnapshot(paras, { sp: sp, so: so, ep: ep, eo: eo });
    if (cpLen(text) < 2) return null;
    return { loc: { sp: sp, so: so, ep: ep, eo: eo }, text: text };
  }
  function onUp(e) {
    setTimeout(function () {
      var info = computeSel();
      if (!info) { hidePop(); return; }
      var rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
      var host = scroll.getBoundingClientRect();
      showPop(rect.left - host.left + rect.width / 2, rect.top - host.top, info);
    }, 10);
  }
  scroll.addEventListener('mouseup', onUp);
  scroll.addEventListener('touchend', onUp);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hidePop(); });
}

/* ============ 评论（FR-06 / AC-19） ============ */
function openComments(passageId) {
  var list = C.demo_comments.filter(function (c) { return c.passageId === passageId; });
  function rows() {
    if (!list.length) return '<div class="empty">这条片段还没有示例评论</div>';
    return list.map(function (c) {
      var key = passageId + '|' + c.author;
      var on = !!S.commentLikes[key];
      return '<li class="cm"><div class="a">' + esc(c.author) + '</div><div class="t">' + esc(c.text) + '</div>' +
        '<div class="ag"><button data-k="' + esc(key) + '"' + (on ? ' class="on"' : '') + '>认同 · ' + (on ? '已' : '未') + '</button></div></li>';
    }).join('');
  }
  var sh = openSheet(
    '<div class="ph"><h3>片段评论</h3><span class="demo">示例评论 · 仅用于体验展示</span></div>' +
    '<p class="pc">正式版中这里是真实读者的交流；演示版不代表真实用户数据。</p>' +
    '<ul id="cm-list">' + rows() + '</ul>');
  sh.querySelector('#cm-list').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-k]');
    if (!b) return;
    var k = b.dataset.k;
    var backup = S.commentLikes;
    if (S.commentLikes[k]) delete S.commentLikes[k]; else S.commentLikes[k] = Date.now();
    if (persist('commentLikes')) b.classList.toggle('on');
  });
}

/* ============ 发布（PG-05/06） ============ */
function renderChoose() {
  var el = document.createElement('div');
  el.className = 'page';
  el.innerHTML =
    '<div class="topbar"><div><div class="tt">发布</div><div class="crumb">从本书选一段，写下你的想法</div></div></div>' +
    '<div class="scroll"><div class="choose">' +
    C.books.map(function (b) {
      return '<h2>' + b.title + ' <span style="font-size:12px;color:var(--sub)">' + esc(authorText(b)) + '</span></h2>' +
        '<p class="tip">先打开一章，划选想发布的原文。</p>' +
        '<div class="ch-list">' + b.chapters.map(function (c) {
          return '<button class="ch-item" data-cid="' + c.chapterId + '"><span class="n">第' + c.number + '回</span><span>' + esc(c.title) + '</span></button>';
        }).join('') + '</div>';
    }).join('') +
    '</div></div>' + navHTML('publish');
  app.innerHTML = '';
  app.appendChild(el);
  el.addEventListener('click', function (e) {
    var ch = e.target.closest('.ch-item');
    if (ch) go('reader', { chapterId: ch.dataset.cid, from: 'publish' });
  });
  bindNav(el, 'publish');
}
function renderEditor(data) {
  var el = document.createElement('div');
  el.className = 'page editor';
  var ch = C.chapters[data.chapterId];
  el.innerHTML =
    '<div class="topbar"><button class="back" data-b>←</button><div><div class="tt">编辑发布</div><div class="crumb">' + esc(chTitle(data.chapterId)) + '</div></div></div>' +
    '<div class="ex"><p>' + esc(data.text) + '</p><div class="m">原文不可改动；确认无误后写下感想。</div></div>' +
    '<div class="lb"><span>感想（可不填）</span><small><span id="tc">' + 0 + '</span>/50</small></div>' +
    '<textarea id="thought" maxlength="60" placeholder="一句话说说这段打动了你什么"></textarea>' +
    '<button class="btn-p go" id="to-preview">下一步：预览</button>';
  app.innerHTML = '';
  app.appendChild(el);
  var ta = $('#thought', el);
  // AC-18：编辑中返回需确认放弃（有输入时）
  editorBack = function () {
    if (cpLen(ta.value.trim()) > 0) {
      confirmSheet({ title: '放弃这次发布？', text: '返回后，所选原文与感想不会保存。', ok: '放弃', danger: true, onOk: back });
    } else { back(); }
  };
  el.querySelector('[data-b]').addEventListener('click', editorBack);
  ta.addEventListener('input', function () {
    var n = cpLen(ta.value);
    if (n > 50) { ta.classList.add('over'); $('#tc', el).textContent = n; $('#tc', el).classList.add('over'); }
    else { ta.classList.remove('over'); $('#tc', el).textContent = n; $('#tc', el).classList.remove('over'); }
  });
  $('#to-preview', el).addEventListener('click', function () {
    var thought = ta.value.trim();
    if (cpLen(thought) > 50) { toast('感想最长 50 字，现在还不能保存'); return; }
    go('preview', { chapterId: data.chapterId, loc: data.loc, text: data.text, thought: thought, from: data.from });
  });
}
function renderPreview(data) {
  var el = document.createElement('div');
  el.className = 'page preview';
  var ch = C.chapters[data.chapterId];
  var book = BOOK[ch.bookId];
  el.innerHTML =
    '<div class="topbar"><button class="back" data-b>←</button><div><div class="tt">预览</div><div class="crumb">首页将按这个样子展示</div></div></div>' +
    '<div class="pv" id="pv"><div class="kicker">我发布的片段</div>' +
    '<div class="text" id="pv-text">' + esc(data.text) + '</div>' +
    (data.thought ? '<div class="src">感想：' + esc(data.thought) + '</div>' : '') +
    '<div class="src">' + book.title + ' · ' + esc(chTitle(data.chapterId)) + '</div></div>' +
    '<div id="pv-warn"></div>' +
    '<p class="pv-note">预览按首页片段版式检查：超出一屏会提示，不会压缩字号或截断原文。</p>' +
    '<div class="go"><button class="btn-p" id="pv-save">保存到本机</button><button class="btn-g" data-b2>返回修改</button></div>';
  app.innerHTML = '';
  app.appendChild(el);
  el.querySelector('[data-b]').addEventListener('click', back);
  el.querySelector('[data-b2]').addEventListener('click', back);
  var over = false;
  // 同步实测（不依赖 rAF，避免隐藏帧/预渲染环境下检查失效）：
  // 用与首页同高的隐藏容器装一张同构卡片，比较正文自然高度与首页正文区可用高度
  (function () {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;display:flex;flex-direction:column;visibility:hidden;pointer-events:none;width:' + $('#app').clientWidth + 'px;height:' + $('#app').clientHeight + 'px;';
    probe.innerHTML = '<div class="card" style="flex:1;display:flex;flex-direction:column">' +
      '<div class="kicker">我发布的片段</div>' +
      '<div class="body"><div class="text">' + esc(data.text) + '</div></div>' +
      '<div class="src"><span class="bt">' + BOOK[ch.bookId].title + '</span><span class="ct">' + esc(chTitle(data.chapterId)) + '</span></div></div>';
    el.appendChild(probe);
    var bodyEl = probe.querySelector('.body');
    var textEl = probe.querySelector('.text');
    over = textEl.scrollHeight > bodyEl.clientHeight + 1;
    probe.remove();
    if (over) {
      $('#pv-warn', el).innerHTML = '<div class="pv-warn">这段文字在首页会超出一屏，暂时不能发布。你可以返回原文，换一个更短的段落。</div>';
      $('#pv-save', el).disabled = true;
    }
  })();
  $('#pv-save', el).addEventListener('click', function () {
    if (over) return;
    // 查重（AC-14）：同章同范围 + 同感想
    var dup = S.publishes.some(function (p) {
      return p.chapterId === data.chapterId &&
        JSON.stringify(p.loc) === JSON.stringify(data.loc) &&
        (p.thought || '') === (data.thought || '');
    });
    if (dup) { toast('这条片段已经保存过了'); return; }
    var pub = {
      id: 'pub-' + Date.now(), bookId: ch.bookId, chapterId: data.chapterId,
      chapterTitle: chTitle(data.chapterId), loc: data.loc, text: data.text,
      thought: data.thought || '', createdAt: Date.now()
    };
    var backup = S.publishes.slice(); /* 真拷贝：失败回滚时不能引用同一数组 */
    S.publishes.unshift(pub);
    if (persist('publishes')) {
      closeSheet();
      if (data.from === 'publish') {
        // 导航发布：保留浏览位置，插到当前位置之后（PRD 9.4）
        rebuildTail({ insertFirst: ['u:' + pub.id], keepCurrent: true });
        toast('已保存并排进首页');
        resetTo('home');
      } else {
        // 正文阅读中发布：回到阅读页，下次回首页时插入（AC-15 正文入口）
        S.store_pending = pub.id;
        STORE.set('pending', pub.id);
        toast('已保存，片段将在下次回到首页时出现', 2600);
        stack.pop(); back(); /* 连退 editor+preview，回到阅读页 */
      }
    } else {
      S.publishes = backup;
    }
  });
}
function renderPubDetail(data) {
  var pub = S.publishes.filter(function (p) { return p.id === data.id; })[0];
  var el = document.createElement('div');
  el.className = 'page';
  el.innerHTML =
    '<div class="topbar"><button class="back" data-b>←</button><div><div class="tt">我的发布</div><div class="crumb">' + esc(pub.chapterTitle) + '</div></div></div>' +
    '<div class="pv" style="margin-top:14px"><div class="kicker">我发布的片段</div>' +
    '<div class="text">' + esc(pub.text) + '</div>' +
    (pub.thought ? '<div class="src">感想：' + esc(pub.thought) + '</div>' : '') +
    '<div class="src">' + BOOK[pub.bookId].title + ' · ' + esc(pub.chapterTitle) + '</div></div>' +
    '<div class="lt" style="padding-top:16px">' +
    '<div style="display:flex;gap:12px">' +
    '<button class="btn-g" id="pd-src" style="flex:1">去原文看看</button>' +
    '<button class="btn-g" id="pd-share" style="flex:1">生成分享卡</button></div>' +
    '<button class="btn-g" id="pd-del" style="color:#A5482E">删除这条发布</button></div>';
  app.innerHTML = '';
  app.appendChild(el);
  el.querySelector('[data-b]').addEventListener('click', back);
  $('#pd-src', el).addEventListener('click', function () {
    go('reader', { chapterId: pub.chapterId, pubLoc: pub.loc, pubText: pub.text });
  });
  $('#pd-share', el).addEventListener('click', function () { go('share', { pub: pub }); });
  $('#pd-del', el).addEventListener('click', function () {
    confirmSheet({
      title: '删除这条发布？', text: '删除后，首页与列表中的这条内容都会移除。',
      ok: '删除', danger: true,
      onOk: function () {
        S.publishes = S.publishes.filter(function (p) { return p.id !== pub.id; });
        if (persist('publishes')) {
          // 从队列里也移除（AC-15 联动）
          S.feed.order = S.feed.order.filter(function (x) { return x !== 'u:' + pub.id; });
          if (S.feed.cursor >= S.feed.order.length) S.feed.cursor = Math.max(0, S.feed.order.length - 1);
          persist('feed');
          toast('已删除');
          back();
        }
      }
    });
  });
}

/* ============ 分享卡（FR-08 / AC-17/18） ============ */
function renderShare(data) {
  var el = document.createElement('div');
  el.className = 'page share';
  var text, src, thought, intro;
  if (data.pub) {
    text = data.pub.text; src = BOOK[data.pub.bookId].title + ' · ' + data.pub.chapterTitle;
    thought = data.pub.thought; intro = '我发布的片段';
  } else {
    var p = data.passage;
    text = p.text; src = BOOK[p.bookId].title + ' · ' + chTitle(p.chapterId);
    thought = ''; intro = p.intro;
  }
  el.innerHTML =
    '<div class="topbar"><button class="back" data-b>←</button><div><div class="tt">分享卡</div><div class="crumb">保存为图片，配文自行编辑</div></div></div>' +
    '<div class="canvas-wrap"><canvas id="sh-cv"></canvas></div>' +
    '<div class="row"><button class="btn-g" data-b2>取消</button><button class="btn-p" id="sh-save">保存到本机</button></div>';
  app.innerHTML = '';
  app.appendChild(el);
  el.querySelector('[data-b]').addEventListener('click', back);
  el.querySelector('[data-b2]').addEventListener('click', back);

  var cv = $('#sh-cv', el);
  drawShareCard(cv, text, src, thought, intro);
  var saving = false;
  $('#sh-save', el).addEventListener('click', function () {
    if (saving) return;
    saving = true;
    var btn = $('#sh-save', el);
    btn.textContent = '正在生成…';
    var done = function () { btn.textContent = '保存到本机'; saving = false; };
    var fail = function () { btn.textContent = '重试'; saving = false; toast('生成失败，请重试'); };
    try {
      // AC-21：toBlob 的失败发生在异步回调里，须在回调内处理
      cv.toBlob(function (blob) {
        if (!blob) { fail(); return; }
        try {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'shuliu-share-' + Date.now() + '.png';
          document.body.appendChild(a); a.click(); a.remove();
          done();
          toast('已发起下载：图片保存到本机后即可分享');
        } catch (e) { fail(); }
      }, 'image/png');
    } catch (e) {
      // 环境不支持 toBlob 等同步异常
      fail();
    }
  });
}
function drawShareCard(cv, text, src, thought, intro) {
  var W = 1080, pad = 96, maxW = W - pad * 2;
  var probe = document.createElement('canvas').getContext('2d');
  var fText = '44px "Songti SC","SimSun",serif';
  probe.font = fText;
  // 换行计算（code point 逐字累计）
  function wrap(str, font, maxw) {
    probe.font = font;
    var lines = [];
    cps(str).forEach(function (c) {
      var last = lines.length - 1;
      if (last < 0) { lines.push(c); return; }
      if (probe.measureText(lines[last] + c).width > maxw) lines.push(c);
      else lines[last] += c;
    });
    return lines;
  }
  var linesText = wrap(text, fText, maxW);
  var linesTh = thought ? wrap(thought, fText, maxW - 40) : [];
  var H = pad + 46 + 24 + linesText.length * 84 + 60 + (linesTh.length ? linesTh.length * 70 + 70 : 0) + 120 + pad;
  cv.width = W; cv.height = H;
  var g = cv.getContext('2d');
  g.fillStyle = '#F8F7F2'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#547366';
  g.font = '600 30px "PingFang SC","Microsoft YaHei",sans-serif';
  g.fillText(intro, pad, pad + 30);
  g.fillStyle = '#303A35';
  g.font = fText;
  var y = pad + 110;
  linesText.forEach(function (l) { g.fillText(l, pad, y); y += 84; });
  y += 16;
  g.fillStyle = '#6D786F'; g.font = '28px "PingFang SC","Microsoft YaHei",sans-serif';
  g.fillText(src, pad, y); y += 64;
  if (linesTh.length) {
    g.fillStyle = '#547366'; g.font = '26px "PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('感想', pad, y); y += 44;
    g.fillStyle = '#303A35'; g.font = '32px "Songti SC","SimSun",serif';
    linesTh.forEach(function (l) { g.fillText(l, pad + 20, y); y += 70; });
    y += 20;
  }
  g.fillStyle = '#6D786F'; g.font = '30px "PingFang SC","Microsoft YaHei",sans-serif';
  g.fillText('书流 · 从一段文字，遇见一本书', pad, H - pad + 14);
}

/* ============ 我的（PG-08/09） ============ */
function renderMine() {
  var el = document.createElement('div');
  el.className = 'page mine';
  el.innerHTML =
    '<div class="topbar"><div><div class="tt">我的</div><div class="crumb">内容都保存在本机</div></div></div>' +
    '<div class="scroll">' +
    '<div class="who"><div class="av">读</div><div><div class="n">本机读者</div><div class="d">演示版 · 无登录 · 数据仅存于此设备</div></div></div>' +
    '<div class="sec">内容</div>' +
    '<div class="row-list">' +
    row('likes', '喜欢的片段', Object.keys(S.likes).length) +
    row('saves', '收藏', Object.keys(S.saves).length) +
    row('publishes', '我的发布', S.publishes.length) +
    row('history', '阅读历史', Object.keys(S.history).length) +
    '</div>' +
    '<div class="sec">偏好与数据</div>' +
    '<div class="row-list">' +
    '<button class="row" data-x="settings">兴趣设置<span class="arr">→</span></button>' +
    row('hidden', '已隐藏的片段', S.hidden.length) +
    '<button class="row danger" data-x="clear">清除本机记录<span class="arr">→</span></button>' +
    '</div></div>' +
    navHTML('mine');
  app.innerHTML = '';
  app.appendChild(el);
  el.addEventListener('click', function (e) {
    var r = e.target.closest('.row');
    if (!r) return;
    var k = r.dataset.k, x = r.dataset.x;
    if (k === 'likes' || k === 'saves') go('list', { kind: k });
    else if (k === 'publishes') go('list', { kind: 'publishes' });
    else if (k === 'history') go('list', { kind: 'history' });
    else if (k === 'hidden') go('list', { kind: 'hidden' });
    else if (x === 'settings') go('settings');
    else if (x === 'clear') {
      confirmSheet({
        title: '清除本机记录？', text: '喜欢、收藏、发布、阅读历史与兴趣都会删除，此操作不可撤销。',
        ok: '清除', danger: true,
        onOk: function () {
          if (STORE.clearAll()) { loadState(); S.feed = null; resetTo('start'); toast('已清除，重新开始'); }
        }
      });
    }
  });
  bindNav(el, 'mine');
  function row(k, label, n) {
    return '<button class="row" data-k="' + k + '">' + label + '<span class="ct">' + n + '</span><span class="arr">→</span></button>';
  }
}
function renderList(data) {
  var el = document.createElement('div');
  el.className = 'page';
  var titles = { likes: '喜欢的片段', saves: '收藏', publishes: '我的发布', history: '阅读历史', hidden: '已隐藏的片段' };
  var body = '';
  if (data.kind === 'likes' || data.kind === 'saves') {
    var map = data.kind === 'likes' ? S.likes : S.saves;
    var ids = Object.keys(map).sort(function (a, b) { return map[b] - map[a]; });
    body = ids.length ? '<div class="lt">' + ids.map(function (pid) {
      var p = PASSAGE[pid];
      if (!p) return '';
      return '<button class="it" data-pid="' + pid + '"><div class="p">' + esc(p.text) + '</div>' +
        '<div class="m">' + BOOK[p.bookId].title + ' · ' + esc(chTitle(p.chapterId)) + '</div></button>';
    }).join('') + '</div>' : emptyHTML('还没有内容，去首页遇见吧');
  } else if (data.kind === 'publishes') {
    body = S.publishes.length ? '<div class="lt">' + S.publishes.map(function (p) {
      return '<button class="it" data-pub="' + p.id + '"><div class="p">' + esc(p.text) + '</div>' +
        (p.thought ? '<div class="th">' + esc(p.thought) + '</div>' : '') +
        '<div class="m">' + esc(p.chapterTitle) + '<span class="act"><span>管理</span></span></div></button>';
    }).join('') + '</div>' : emptyHTML('还没有发布，去正文里划选一段试试');
  } else if (data.kind === 'history') {
    var hs = Object.keys(S.history).map(function (k) { return S.history[k]; })
      .filter(function (h) { return BOOK[h.bookId]; }) /* AC-23：损坏条目跳过，不清空全部 */
      .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    body = hs.length ? '<div class="lt">' + hs.map(function (h) {
      return '<button class="it" data-h="' + h.bookId + '|' + h.chapterId + '|' + h.paraIdx + '|' + (h.off || 0) + '">' +
        '<div class="p" style="font-family:var(--hei)">' + BOOK[h.bookId].title + ' · 第' + h.number + '回 ' + esc(h.title) + '</div>' +
        '<div class="m">读到第 ' + (h.paraIdx + 1) + ' 段附近</div></button>';
    }).join('') + '</div>' : emptyHTML('还没有阅读记录');
  } else if (data.kind === 'hidden') {
    body = S.hidden.length ? '<div class="lt">' + S.hidden.map(function (pid) {
      var p = PASSAGE[pid];
      if (!p) return '';
      return '<div class="it"><div class="p">' + esc(p.text) + '</div>' +
        '<div class="m">' + BOOK[p.bookId].title + '<span class="act"><button data-restore="' + pid + '">恢复到首页</button></span></div></div>';
    }).join('') + '</div>' : emptyHTML('没有隐藏任何片段');
  }
  el.innerHTML =
    '<div class="topbar"><button class="back" data-b>←</button><div><div class="tt">' + titles[data.kind] + '</div><div class="crumb">保存在本机</div></div></div>' +
    '<div class="scroll">' + body + '</div>';
  app.innerHTML = '';
  app.appendChild(el);
  el.querySelector('[data-b]').addEventListener('click', back);
  el.addEventListener('click', function (e) {
    var it = e.target.closest('.it');
    if (!it) return;
    if (it.dataset.pid) { go('reader', { chapterId: PASSAGE[it.dataset.pid].chapterId, passageId: it.dataset.pid }); }
    else if (it.dataset.pub) { go('pubdetail', { id: it.dataset.pub }); }
    else if (it.dataset.h) {
      var a = it.dataset.h.split('|');
      go('reader', { chapterId: a[1], resume: true, resumePara: +a[2], resumeOff: +a[3] });
    }
    var rs = e.target.closest('[data-restore]');
    if (rs) {
      var pid2 = rs.dataset.restore;
      S.hidden = S.hidden.filter(function (x) { return x !== pid2; });
      if (persist('hidden')) {
        rebuildTail();
        toast('已恢复，下轮会出现在首页');
        render();
      }
    }
  });
  function emptyHTML(t) { return '<div class="empty">' + t + '</div>'; }
}
function renderSettings() {
  var el = document.createElement('div');
  el.className = 'page';
  el.innerHTML =
    '<div class="topbar"><button class="back" data-b>←</button><div><div class="tt">兴趣设置</div><div class="crumb">只影响之后的内容，不动已浏览的</div></div></div>' +
    '<div class="start" style="height:auto;padding-bottom:0">' +
    '<div class="chips">' + TOPICS.map(function (t) {
      return '<button class="chip' + (S.interests.indexOf(t) >= 0 ? ' on' : '') + '" data-t="' + t + '">' + t + '</button>';
    }).join('') + '</div>' +
    '<p class="chip-note">最多 3 个；保存后未浏览的片段会重新混排。</p></div>' +
    '<div style="padding:24px 24px 0"><button class="btn-p" id="sv">保存并重新混排</button></div>';
  app.innerHTML = '';
  app.appendChild(el);
  var tmp = S.interests.slice();
  el.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (chip) {
      var t = chip.dataset.t;
      var i = tmp.indexOf(t);
      if (i >= 0) { tmp.splice(i, 1); chip.classList.remove('on'); }
      else { if (tmp.length >= 3) { toast('最多选 3 个兴趣'); return; } tmp.push(t); chip.classList.add('on'); }
      return;
    }
    if (e.target.closest('#sv')) {
      S.interests = tmp;
      persist('interests');
      rebuildTail({ keepCurrent: true });
      toast('已保存，未浏览内容重新混排');
      resetTo('mine');
    }
  });
  el.querySelector('[data-b]').addEventListener('click', back);
}

/* ============ 启动 ============ */
function bootstrap() {
  ensureFeed();
  var pending = STORE.get('pending', null);
  if (pending) S.store_pending = pending;
  if (!S.onboarded) resetTo('start');
  else resetTo('home');
}
document.addEventListener('keydown', function (e) {
  // 全局 Esc：关弹层 → 编辑页确认返回 → 返回（AC-09 / AC-18）
  if (e.key !== 'Escape') return;
  if ($('#sheet-root').innerHTML) { closeSheet(); return; }
  var t = top();
  if (t && t.page === 'editor' && editorBack) { editorBack(); return; }
  if (t && t.page !== 'home' && t.page !== 'start' && !back()) resetTo('home');
});
bootstrap();

/* 测试钩子：仅 ?test=1 时暴露纯函数与状态读写（自动化测试用，不影响产品路径） */
if (location.search.indexOf('test=1') >= 0) {
  window.__SHULIU_TEST__ = {
    cps: cps, cpLen: cpLen, sliceCP: sliceCP, esc: esc,
    shuffle: shuffle, mixPool: mixPool, buildFullOrder: buildFullOrder,
    visiblePassages: visiblePassages,
    chTitle: chTitle, rebuildSnapshot: rebuildSnapshot, verifyLoc: verifyLoc,
    setRawState: function (patch) { for (var k in patch) S[k] = patch[k]; },
    getRawState: function () { return S; },
    setCardShownAt: function (v) { S._cardShownAt = v; }, /* 埋点：模拟卡片停留起点 */
    recordRecommendationFeedback: recordRecommendationFeedback,
    RECO_VERSION: RECOMMENDER ? RECOMMENDER.RECO_VERSION : null
  };
}

/* Android 实体返回键（仅 Capacitor 环境）：关弹层 → 编辑确认 → 首页/引导时退出 → 应用内返回 → 栈底 tab 页回首页。
   注意：Capacitor 6 默认不在 UA 中追加 "Capacitor" 字样，必须用 isNativePlatform() 判断。 */
var IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
if (IS_NATIVE && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
  window.Capacitor.Plugins.App.addListener('backButton', function () {
    if ($('#sheet-root').innerHTML) { closeSheet(); return; }
    var t = top();
    if (t && t.page === 'editor' && editorBack) { editorBack(); return; }
    if (t && (t.page === 'start' || t.page === 'home')) { window.Capacitor.Plugins.App.exitApp(); return; }
    if (back()) return;
    resetTo('home'); /* 发布/我的等栈底 tab 页：返回首页而非无效 */
  });
}
})();
