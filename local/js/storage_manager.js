/**
 * 本地存档适配：接口与原 H5 版 LocalStorageManager 保持一致，
 * 底层走 Platform（tt.storage / localStorage 降级）。
 * 除对局存档外，还承载本地排行榜与设置项。
 */
function StorageManager() {
  this.bestScoreKey = 'bestScore';
  this.gameStateKey = 'gameState';
  this.leaderboardKey = 'leaderboard';
  this.settingsKey = 'settings';
  this.collectionKey = 'collection';
}

StorageManager.prototype.getBestScore = function (size) {
  var raw = Platform.getStorage(this.bestScoreKey, 0);
  // 旧存档是纯数字，迁移成按棋盘尺寸分档的对象
  if (typeof raw === 'number') {
    if (!size || size === 4) return raw || 0;
    return 0;
  }
  if (!raw || typeof raw !== 'object') return 0;
  var v = raw[String(size || 4)];
  return typeof v === 'number' ? v : 0;
};

StorageManager.prototype.setBestScore = function (score, size) {
  var cur = Platform.getStorage(this.bestScoreKey, 0);
  var map = {};
  if (typeof cur === 'number') {
    map['4'] = cur || 0;
  } else if (cur && typeof cur === 'object') {
    map = cur;
  }
  map[String(size || 4)] = score || 0;
  Platform.setStorage(this.bestScoreKey, map);
};

StorageManager.prototype.getGameState = function () {
  return Platform.getStorage(this.gameStateKey, null);
};

StorageManager.prototype.setGameState = function (gameState) {
  Platform.setStorage(this.gameStateKey, gameState);
};

StorageManager.prototype.clearGameState = function () {
  Platform.removeStorage(this.gameStateKey);
};

/* ---------------- 本地排行榜：只留分数最高的 10 局 ---------------- */

/** 存储层面的全量战绩（跨尺寸共用一份），供导出与内部维护使用 */
StorageManager.prototype.getAllRuns = function () {
  var list = Platform.getStorage(this.leaderboardKey, []);
  return Array.isArray(list) ? list : [];
};

/** 某个棋盘尺寸下的榜单前 10；不传尺寸按 4×4，保持旧调用语义 */
StorageManager.prototype.getLeaderboard = function (size) {
  var list = this.getAllRuns();
  var n = size || 4;
  return list.filter(function (r) { return (r && (r.size || 4)) === n; }).slice(0, 10);
};

/** 追加一局成绩并返回该尺寸下排序后的前 10；存储层最多留 30 条供多尺寸共存 */
StorageManager.prototype.addRun = function (run) {
  var list = this.getAllRuns();
  var item = {
    score: run.score || 0,
    maxTile: run.maxTile || 0,
    size: run.size || 4,
    at: typeof run.at === 'number' ? run.at : Date.now()
  };
  list.push(item);
  list.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  list = list.slice(0, 30);
  Platform.setStorage(this.leaderboardKey, list);
  return this.getLeaderboard(item.size);
};

StorageManager.prototype.clearLeaderboard = function () {
  Platform.removeStorage(this.leaderboardKey);
};

/* ---------------- 设置项 ---------------- */

/**
 * fx: 特效强度 off/normal/strong；bg: 背景浓度 light/normal/deep；
 * erase: 每局消除次数（0 表示不限）；sfx: 音效开关；sfxVol: 音效音量(0~1)
 * music: 背景音乐开关；musicVol: 音乐音量(0~1)；size: 棋盘尺寸 4/5/6
 */
StorageManager.prototype.getSettings = function () {
  var def = {
    fx: 'normal', bg: 'normal', erase: 3,
    sfx: true, sfxVol: 0.7,
    music: true, musicVol: 0.35,
    size: 4
  };
  var saved = Platform.getStorage(this.settingsKey, null);
  if (!saved || typeof saved !== 'object') return def;

  var size = typeof saved.size === 'number' ? saved.size : def.size;
  if (size < 4 || size > 6) size = def.size;

  return {
    fx: saved.fx || def.fx,
    bg: saved.bg || def.bg,
    erase: typeof saved.erase === 'number' ? saved.erase : def.erase,
    sfx: typeof saved.sfx === 'boolean' ? saved.sfx : def.sfx,
    sfxVol: typeof saved.sfxVol === 'number' ? saved.sfxVol : def.sfxVol,
    music: typeof saved.music === 'boolean' ? saved.music : def.music,
    musicVol: typeof saved.musicVol === 'number' ? saved.musicVol : def.musicVol,
    size: size
  };
};

StorageManager.prototype.setSettings = function (settings) {
  Platform.setStorage(this.settingsKey, settings);
};

/* ---------------- 收藏家：记录第一次合成过的水果等级 ---------------- */

StorageManager.prototype.getCollection = function () {
  var list = Platform.getStorage(this.collectionKey, []);
  return Array.isArray(list) ? list : [];
};

StorageManager.prototype.setCollection = function (list) {
  Platform.setStorage(this.collectionKey, list);
};

StorageManager.prototype.clearCollection = function () {
  Platform.removeStorage(this.collectionKey);
};

// 注意：清空数据只清分数与榜单，收藏属于成就，保留
StorageManager.prototype.resetAll = function () {
  this.clearGameState();
  this.clearLeaderboard();
  this.setBestScore(0, 4);
  this.setBestScore(0, 5);
  this.setBestScore(0, 6);
};

/* ---------------- 存档导出 / 导入 ---------------- */

var SAVE_VERSION = 1;
var SAVE_APP = '2048-fruits';

/** 打包全部本地数据，供导出成 .json 文件 */
StorageManager.prototype.exportData = function () {
  return {
    app: SAVE_APP,
    version: SAVE_VERSION,
    at: Date.now(),
    bestScore: Platform.getStorage(this.bestScoreKey, 0),
    leaderboard: this.getAllRuns(),
    gameState: this.getGameState(),
    collection: this.getCollection(),
    settings: this.getSettings()
  };
};

/**
 * 从导出的对象恢复本地数据。
 * 成绩/对局/设置直接覆盖；收藏只做并集，避免恢复旧备份把新成就抹掉。
 * 返回 { ok: boolean, reason: string, added: number }
 */
StorageManager.prototype.importData = function (obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: '文件内容不是有效的存档对象', added: 0 };
  if (obj.app && obj.app !== SAVE_APP) return { ok: false, reason: '不是本游戏的存档文件', added: 0 };

  var hits = 0;

  if (obj.bestScore !== undefined) {
    if (typeof obj.bestScore === 'number' || (obj.bestScore && typeof obj.bestScore === 'object')) {
      Platform.setStorage(this.bestScoreKey, obj.bestScore);
      hits++;
    }
  }

  if (Array.isArray(obj.leaderboard)) {
    var runs = obj.leaderboard.filter(function (r) {
      return r && typeof r.score === 'number';
    }).map(function (r) {
      return {
        score: r.score,
        maxTile: typeof r.maxTile === 'number' ? r.maxTile : 0,
        size: typeof r.size === 'number' ? r.size : 4,
        at: typeof r.at === 'number' ? r.at : Date.now()
      };
    });
    Platform.setStorage(this.leaderboardKey, runs.slice(0, 30));
    hits++;
  }

  if (obj.gameState && typeof obj.gameState === 'object' && obj.gameState.grid) {
    Platform.setStorage(this.gameStateKey, obj.gameState);
    hits++;
  }

  var added = 0;
  if (Array.isArray(obj.collection)) {
    var mine = this.getCollection();
    obj.collection.forEach(function (v) {
      var n = typeof v === 'number' ? v : parseInt(v, 10);
      if (!isNaN(n) && mine.indexOf(n) === -1) { mine.push(n); added++; }
    });
    mine.sort(function (a, b) { return a - b; });
    Platform.setStorage(this.collectionKey, mine);
    hits++;
  }

  if (obj.settings && typeof obj.settings === 'object') {
    var merged = obj.settings;
    merged.size = typeof merged.size === 'number' && merged.size >= 4 && merged.size <= 6 ? merged.size : 4;
    Platform.setStorage(this.settingsKey, merged);
    hits++;
  }

  if (hits === 0) return { ok: false, reason: '存档里没有可识别的数据字段', added: added };
  return { ok: true, reason: '已恢复', added: added };
};

globalThis.StorageManager = StorageManager;
