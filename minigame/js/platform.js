/**
 * 平台桥接层：统一封装抖音小游戏运行时（tt）与浏览器调试降级。
 * 存储、系统信息已落地；登录 / 战绩上报 / 全网榜 / 名次走抖音云 callContainer；
 * 激励视频广告为 P4 占位。
 */
var Platform = (function () {
  var hasTT = typeof tt !== 'undefined';

  // 抖音云服务配置（控制台「服务详情」获取）
  var CLOUD = { envID: 'env-MJjcGKiA26', serviceID: '1mk35w5fhh1re' };
  var cloudInstance = null;

  function getSystemInfo() {
    if (hasTT && tt.getSystemInfoSync) {
      return tt.getSystemInfoSync();
    }
    // 浏览器调试降级
    return {
      windowWidth: typeof window !== 'undefined' ? window.innerWidth : 375,
      windowHeight: typeof window !== 'undefined' ? window.innerHeight : 667,
      pixelRatio: typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1,
      safeArea: null
    };
  }

  // ---- 同步存储（tt.storage / localStorage 降级）----
  function getStorage(key, def) {
    try {
      if (hasTT) {
        var v = tt.getStorageSync(key);
        return v === '' || v === undefined ? def : v;
      }
      if (typeof localStorage !== 'undefined') {
        var lv = localStorage.getItem(key);
        return lv === null ? def : JSON.parse(lv);
      }
    } catch (e) {}
    return def;
  }

  function setStorage(key, value) {
    try {
      if (hasTT) {
        tt.setStorageSync(key, value);
      } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(value));
      }
    } catch (e) {}
  }

  function removeStorage(key) {
    try {
      if (hasTT) {
        tt.removeStorageSync(key);
      } else if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key);
      }
    } catch (e) {}
  }

  // ---- 抖音云调用（callContainer HTTP 模式）----
  function getCloud() {
    if (!cloudInstance) {
      cloudInstance = tt.createCloud({ envID: CLOUD.envID, serviceID: CLOUD.serviceID });
    }
    return cloudInstance;
  }

  // path: '/api/login' | '/api/report' | '/api/leaderboard' | '/api/myRank'；cb(err, data)
  function callApi(path, body, cb) {
    if (!hasTT) {
      cb(new Error('cloud unavailable in browser debug'), null);
      return;
    }
    try {
      getCloud().callContainer({
        path: path,
        init: {
          method: 'POST',
          header: { 'content-type': 'application/json' },
          body: body || {},
          timeout: 10000
        },
        success: function (res) {
          var data = res.data;
          if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) {} }
          if (data && data.err_no !== undefined && data.err_no !== 0) {
            cb(new Error(data.err_msg || 'cloud error'), data);
          } else {
            cb(null, data && data.data !== undefined ? data.data : data);
          }
        },
        fail: function (err) { cb(err || new Error('cloud fail'), null); }
      });
    } catch (e) { cb(e, null); }
  }

  // ---- 静默登录：tt.login 建立登录态 -> 网关自动带 openid，服务端建档/取档 ----
  // 免登录链路：端侧不把 code/openid 发给服务端，身份由请求头 x-tt-openid 提供。
  // cb(err, profile)，profile: { openid, nickname, bestScore, maxTile, games }
  function login(cb) {
    if (!hasTT) {
      cb(null, { openid: 'local-debug', nickname: '玩家', bestScore: 0, maxTile: 0, games: 0 });
      return;
    }
    tt.login({
      success: function () {
        callApi('/api/login', {}, function (err, data) {
          if (err) { cb(err, null); return; }
          cb(null, data);
        });
      },
      fail: function (err) { cb(err || new Error('login fail')); }
    });
  }

  // 上报一局战绩：{ score, maxTile, revived } -> { bestScore, maxTile, rank, games }（openid 由网关头提供）
  function reportScore(payload, cb) { callApi('/api/report', payload, cb); }

  // 全网榜：limit -> { list: [{ openid, nickname, bestScore, maxTile, games }] }
  function getLeaderboard(limit, cb) { callApi('/api/leaderboard', { limit: limit }, cb); }

  // 本人名次：-> { rank, bestScore, maxTile, total }（openid 由网关头提供）
  function getMyRank(openid, cb) { callApi('/api/myRank', {}, cb); }

  // P4 激励视频广告：看完回调 onReward(true)，未看完/失败 onReward(false)
  function showRewardedAd(onReward) {
    if (!hasTT) {
      // 浏览器调试：直接视为看完，便于走通复活流程
      onReward(true);
      return;
    }
    // TODO(P4): tt.createRewardedVideoAd({ adUnitId })，监听 onClose 判断 isEnded
    onReward(false);
  }

  // 兼容旧占位：name 作为 path 段
  function callCloud(name, data, cb) { callApi('/api/' + name, data, cb); }

  return {
    hasTT: hasTT,
    getSystemInfo: getSystemInfo,
    getStorage: getStorage,
    setStorage: setStorage,
    removeStorage: removeStorage,
    login: login,
    reportScore: reportScore,
    getLeaderboard: getLeaderboard,
    getMyRank: getMyRank,
    showRewardedAd: showRewardedAd,
    callCloud: callCloud
  };
})();

globalThis.Platform = Platform;
