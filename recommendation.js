(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SHULIU_RECOMMENDER = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var DEFAULTS = { topic: 0.30, behavior: 0.25, original: 0.15, quality: 0.10, freshness: 0.10, editor: 0.05, explore: 0.05 };
  function cloneUser(user) {
    user = user || {};
    return {
      interests: (user.interests || []).slice(),
      topicWeights: Object.assign({}, user.topicWeights || {}),
      liked: (user.liked || []).slice(), saved: (user.saved || []).slice(),
      hidden: (user.hidden || []).slice(), seen: (user.seen || []).slice(),
      events: (user.events || []).slice()
    };
  }
  function rng(seed) {
    var n = (seed == null ? Date.now() : seed) >>> 0;
    return function () { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; };
  }
  function has(list, value) { return (list || []).indexOf(value) >= 0; }
  function topicMatch(p, user) {
    var topics = p.topics || [], total = 0;
    topics.forEach(function (t) { if (has(user.interests, t)) total += 1; total += Math.max(0, user.topicWeights[t] || 0) * 0.25; });
    return Math.min(1, total / Math.max(1, topics.length));
  }
  function similarity(p, user) {
    if (has(user.liked, p.passageId) || has(user.saved, p.passageId)) return 1;
    var score = 0;
    (p.topics || []).forEach(function (t) { if ((user.topicWeights[t] || 0) > 0) score += user.topicWeights[t]; });
    return Math.min(1, score / Math.max(1, (p.topics || []).length));
  }
  function score(p, user, options) {
    var w = Object.assign({}, DEFAULTS, options && options.weights);
    var maxDate = options && options.maxPublishedAt || p.publishedAt || 1;
    var freshness = maxDate ? Math.min(1, (p.publishedAt || 0) / maxDate) : 0;
    var seenPenalty = has(user.seen, p.passageId) ? 1 : 0;
    var hiddenPenalty = has(user.hidden, p.passageId) ? 10 : 0;
    var topic = topicMatch(p, user);
    var behavior = similarity(p, user);
    var explore = topic < 0.35 ? 1 : 0;
    return w.topic * topic + w.behavior * behavior + w.original * (p.originalRead ? 1 : 0) +
      w.quality * (p.qualityScore == null ? 0.5 : p.qualityScore) + w.freshness * freshness +
      w.editor * (p.editorPick ? 1 : 0) + w.explore * explore - seenPenalty * 0.18 - hiddenPenalty;
  }
  function reasonFor(p, user) {
    if (has(user.liked, p.passageId) || has(user.saved, p.passageId)) return '因为你喜欢过相似片段';
    if ((p.topics || []).some(function (t) { return has(user.interests, t); })) return '因为你选择了相关兴趣';
    if (p.editorPick) return '编辑精选';
    return '给你一段新的文学发现';
  }
  function buildFeed(passages, user, options) {
    options = options || {}; user = cloneUser(user);
    var limit = options.limit || passages.length, random = rng(options.seed), maxDate = passages.reduce(function (m, p) { return Math.max(m, p.publishedAt || 0); }, 1);
    var candidates = passages.filter(function (p) { return !has(user.hidden, p.passageId); }).map(function (p) {
      return { p: p, score: score(p, user, { weights: options.weights, maxPublishedAt: maxDate }), tie: random() };
    }).sort(function (a, b) { return b.score - a.score || b.tie - a.tie; });
    var out = [], usedBooks = {}, usedTopics = {};
    candidates.forEach(function (item) {
      if (out.length >= limit) return;
      var p = item.p, primary = (p.topics || [])[0] || '';
      if (out.length && usedBooks[p.bookId] && Object.keys(usedBooks).length < 2) return;
      if (out.length >= 2 && usedTopics[primary] >= 2) return;
      out.push(p); usedBooks[p.bookId] = (usedBooks[p.bookId] || 0) + 1; usedTopics[primary] = (usedTopics[primary] || 0) + 1;
    });
    candidates.forEach(function (item) { if (out.length < limit && !has(out.map(function (p) { return p.passageId; }), item.p.passageId)) out.push(item.p); });
    return out.slice(0, limit).map(function (p) { var copy = Object.assign({}, p); copy.recommendationReason = reasonFor(p, user); return copy; });
  }
  function applyFeedback(user, event) {
    var next = cloneUser(user), p = event.passage || {}, topics = p.topics || [];
    if (event.type === 'like' || event.type === 'save' || event.type === 'open_original' || event.type === 'continue_reading') {
      topics.forEach(function (t) { next.topicWeights[t] = Math.min(4, (next.topicWeights[t] || 0) + (event.type === 'save' ? 0.45 : 0.2)); });
    }
    if (event.type === 'not_interested') {
      topics.forEach(function (t) { next.topicWeights[t] = Math.max(-2, (next.topicWeights[t] || 0) - 0.45); });
      if (!has(next.hidden, p.passageId)) next.hidden.push(p.passageId);
    }
    if (!has(next.seen, p.passageId) && event.type !== 'not_interested') next.seen.push(p.passageId);
    next.events.push({ type: event.type, passageId: p.passageId, at: event.at || Date.now() });
    return next;
  }
  return { buildFeed: buildFeed, score: score, reasonFor: reasonFor, applyFeedback: applyFeedback, cloneUser: cloneUser };
});
