/* 书流 本机存储层（PRD FR-10 / AC-10 / AC-23）
   约定：key 前缀 shuliu.v1.；JSON 读写包裹 try/catch；写入失败返回 false，由调用方回滚并提示。 */
(function () {
  var PREFIX = 'shuliu.v1.';
  var store = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(PREFIX + key);
        if (raw === null) return fallback;
        return JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
        return true;
      } catch (e) { return false; }
    },
    remove: function (key) {
      try { localStorage.removeItem(PREFIX + key); return true; }
      catch (e) { return false; }
    },
    clearAll: function () {
      try {
        var ks = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k.indexOf(PREFIX) === 0) ks.push(k);
        }
        ks.forEach(function (k) { localStorage.removeItem(k); });
        return true;
      } catch (e) { return false; }
    }
  };
  window.SHULIU_STORE = store;
})();
