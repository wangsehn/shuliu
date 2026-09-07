'use strict';

var assert = require('assert');
var recommender = require('../recommendation.js');

var passages = [
  { passageId: 'a', bookId: 'book-a', topics: ['亲密关系'], qualityScore: 0.9, publishedAt: 10 },
  { passageId: 'b', bookId: 'book-b', topics: ['亲密关系'], qualityScore: 0.8, publishedAt: 9 },
  { passageId: 'c', bookId: 'book-c', topics: ['孤独与陪伴'], qualityScore: 0.95, publishedAt: 8 },
  { passageId: 'd', bookId: 'book-a', topics: ['亲密关系'], qualityScore: 0.7, publishedAt: 7 },
  { passageId: 'e', bookId: 'book-d', topics: ['成长与选择'], qualityScore: 0.7, publishedAt: 6 }
];

function run() {
  var user = {
    interests: ['亲密关系'],
    topicWeights: { '亲密关系': 1 },
    liked: ['a'],
    saved: [],
    hidden: ['e'],
    seen: ['a'],
    events: []
  };
  var result = recommender.buildFeed(passages, user, { seed: 4, limit: 4 });
  assert.strictEqual(result.length, 4);
  assert.strictEqual(result[0].passageId, 'b');
  assert.ok(result.every(function (p) { return p.passageId !== 'e'; }));
  assert.ok(result.some(function (p) { return p.passageId === 'c'; }), '应该保留探索内容');
  assert.notStrictEqual(result[0].bookId, result[1].bookId, '不应连续推荐同一本书');

  var updated = recommender.applyFeedback(user, { type: 'not_interested', passage: passages[1] });
  assert.ok(updated.topicWeights['亲密关系'] < 1, '明确不感兴趣应降低主题偏好');
  assert.strictEqual(updated.hidden.indexOf('b') >= 0, true);
  assert.strictEqual(recommender.reasonFor(passages[0], user), '因为你喜欢过相似片段');
  console.log('recommendation tests passed');
}

run();
