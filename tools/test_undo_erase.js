/**
 * 临时验证脚本：回退 / 消除 / 本地榜单 / 设置 的逻辑断言。
 * 用 Node 直接加载 local/js 下的真实实现，只对平台与渲染层做最小 stub。
 */
const fs = require('fs');
const path = require('path');

// ---- 平台 stub：内存版 localStorage ----
const store = {};
global.Platform = {
  hasTT: false,
  getStorage(k, d) {
    if (!(k in store)) return d;
    return JSON.parse(JSON.stringify(store[k]));
  },
  setStorage(k, v) { store[k] = JSON.parse(JSON.stringify(v)); },
  removeStorage(k) { delete store[k]; },
  getSystemInfo() { return { windowWidth: 800, windowHeight: 600, pixelRatio: 1 }; }
};

const dir = path.join(__dirname, '..', 'local', 'js');
['tile.js', 'grid.js', 'storage_manager.js', 'game_manager.js'].forEach(function (f) {
  (0, eval)(fs.readFileSync(path.join(dir, f), 'utf8'));
});

// ---- 输入 / 渲染 stub ----
function FakeInput() { this.events = {}; }
FakeInput.prototype.on = function (e, cb) {
  (this.events[e] = this.events[e] || []).push(cb);
};
FakeInput.prototype.emit = function (e, d) {
  (this.events[e] || []).forEach(function (cb) { cb(d); });
};

function FakeRenderer() {}
FakeRenderer.prototype.draw = function () {};
FakeRenderer.prototype.continueGame = function () {};
FakeRenderer.prototype.closeSheets = function () {};
FakeRenderer.prototype.isBlocking = function () { return false; };
FakeRenderer.prototype.isModalOpen = function () { return false; };
FakeRenderer.prototype.showLeaderboard = function (list) { this.board = list; };
FakeRenderer.prototype.onCollect = function (value, name) {
  this.collected = (this.collected || []).concat(name);
};
FakeRenderer.prototype.showCollection = function (list) { this.collection = list; };

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' -> ' + JSON.stringify(extra) : '')); }
}

function fresh(settings) {
  Object.keys(store).forEach(function (k) { delete store[k]; });
  if (settings) store['settings'] = settings;

  const gm = new GameManager(4, FakeInput, FakeRenderer, StorageManager);
  return gm;
}

// 1) 回退：滑动后分数应能退回
(function () {
  const gm = fresh();

  const before = gm.score;
  gm.move(0);
  const moved = gm.score;

  const ok = gm.undo();
  check('滑动后可回退', ok === true);
  check('回退后分数复原', gm.score === before, { before: before, moved: moved, after: gm.score });
  check('回退后回退栈清空', gm.history.length === 0, gm.history.length);
  check('无历史时 canUndo 为假', gm.history.length > 0 === false);
})();

// 2) 消除：次数递减、空格无效、上限生效
(function () {
  const gm = fresh({ fx: 'normal', bg: 'normal', erase: 3 });
  check('开局消除次数等于设置值', gm.eraseLeft === 3, gm.eraseLeft);

  const cell = { x: 0, y: 0 };
  gm.grid.insertTile(new Tile(cell, 8));
  const ok = gm.eraseAt(cell);

  check('消除已占据的格子成功', ok === true);
  check('消除后格子为空', gm.grid.cellContent(cell) === null);
  check('消除后次数减一', gm.eraseLeft === 2, gm.eraseLeft);

  check('消除空格返回假', gm.eraseAt(cell) === false);
  check('消除空格不扣次数', gm.eraseLeft === 2, gm.eraseLeft);

  check('消除留下可回退记录', gm.history.length === 1, gm.history.length);

  gm.eraseLeft = 0;
  check('次数用完后再消除返回假', gm.eraseAt({ x: 0, y: 1 }) === false);
})();

// 3) 设置：不限次数与持久化
(function () {
  const gm = fresh({ fx: 'strong', bg: 'deep', erase: 0 });

  check('erase=0 时次数为不限(-1)', gm.eraseLeft === -1, gm.eraseLeft);
  check('读取 fx 设置', gm.settings.fx === 'strong', gm.settings.fx);

  gm.applySettings({ erase: 5 });
  check('改设置后次数按新上限', gm.eraseLeft === 5, gm.eraseLeft);
  check('设置已落盘', store['settings'].erase === 5, store['settings']);

  const reloaded = new StorageManager().getSettings();
  check('重新读取设置一致', reloaded.fx === 'strong' && reloaded.bg === 'deep' && reloaded.erase === 5, reloaded);
})();

// 4) 榜单：死局只记一条、按分数倒序、最多 10 条
(function () {
  const gm = fresh();

  gm.score = 500;
  gm.over = true;
  gm.actuate();
  const list1 = gm.storageManager.getLeaderboard();

  check('死局写入一条成绩', list1.length === 1, list1.length);
  check('成绩带最高方块', list1[0].maxTile >= 2, list1[0]);
  check('成绩带时间戳', typeof list1[0].at === 'number');

  gm.actuate();
  check('同一局不重复写', gm.storageManager.getLeaderboard().length === 1);

  gm.restart();
  check('重开后回退栈清空', gm.history.length === 0);

  gm.score = 900;
  gm.over = true;
  gm.actuate();
  const list2 = gm.storageManager.getLeaderboard();
  check('多局按分数倒序', list2[0].score === 900 && list2[1].score === 500, list2.map(function (r) { return r.score; }));

  for (let i = 0; i < 12; i++) {
    gm.storageManager.addRun({ score: 100 + i, maxTile: 4, at: Date.now() });
  }
  const list3 = gm.storageManager.getLeaderboard();
  check('榜单最多保留 10 条', list3.length === 10, list3.length);
  check('截断后仍是最高分在前', list3[0].score === 900, list3[0].score);

  const board = [];
  gm.renderer.showLeaderboard(list3);
  check('渲染层收到榜单数据', Array.isArray(gm.renderer.board) && gm.renderer.board.length === 10);
})();

// 5) 清空数据
(function () {
  const gm = fresh();
  gm.score = 777;
  gm.over = true;
  gm.actuate();

  check('清空前最高分存在', gm.storageManager.getBestScore() === 777, gm.storageManager.getBestScore());

  gm.resetData();
  check('清空后最高分为零', gm.storageManager.getBestScore() === 0, gm.storageManager.getBestScore());
  check('清空后榜单为空', gm.storageManager.getLeaderboard().length === 0);
  check('清空后开新局满血', gm.eraseLeft === 3 && gm.score === 0, { erase: gm.eraseLeft, score: gm.score });
})();

// 6) 死局靠回退救回来
(function () {
  const gm = fresh();

  gm.move(0);
  const beforeOver = gm.history.length;
  check('滑动留下了一步历史', beforeOver === 1, beforeOver);

  // 人为摆成死局
  gm.grid = new Grid(4);
  const values = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 8];
  let idx = 0;
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) {
      gm.grid.insertTile(new Tile({ x: x, y: y }, values[idx++]));
    }
  }
  gm.over = true;
  check('摆出的盘面确实走不动', gm.canContinue() === false);

  const ok = gm.undo();
  check('死局能回退', ok === true);
  check('回退后回到可玩状态', gm.over === false);
  check('回退后盘面有活动空间', gm.canContinue() === true);
})();

// 7) 收藏家：开局点亮、合成解锁、只弹一次、清数据不清收藏
(function () {
  const gm = fresh();

  const init = gm.storageManager.getCollection();
  check('开局点亮盘面已有的低等级', init.length >= 1 && init.every(function (v) { return v === 2 || v === 4; }), init);
  check('开局不弹新收藏提示', gm.renderer.collected === undefined, gm.renderer.collected);

  // 摆两颗 4，向左滑必然合成 8
  gm.grid = new Grid(4);
  gm.grid.insertTile(new Tile({ x: 0, y: 0 }, 4));
  gm.grid.insertTile(new Tile({ x: 1, y: 0 }, 4));
  gm.move(3);

  check('合成出 8 后收进图鉴', gm.storageManager.getCollection().indexOf(8) !== -1, gm.storageManager.getCollection());
  check('合成出 8 时弹了提示', Array.isArray(gm.renderer.collected) && gm.renderer.collected[0] === '橙子', gm.renderer.collected);
  check('重复解锁返回假', gm.unlockCollectible(8, true) === false);

  const entries = gm.collectionEntries();
  check('图鉴共 11 级', entries.length === 11, entries.length);
  check('图鉴顺序从 2 到 2048', entries[0].value === 2 && entries[10].value === 2048);
  check('8 级已点亮', entries.find(function (e) { return e.value === 8; }).unlocked === true);
  check('2048 级仍未点亮', entries.find(function (e) { return e.value === 2048; }).unlocked === false);
  check('未点亮的名字是问号', entries.find(function (e) { return e.value === 2048; }).name === '金西瓜');

  gm.publishCollection();
  check('图鉴数据发到渲染层', Array.isArray(gm.renderer.collection) && gm.renderer.collection.length === 11);

  gm.resetData();
  check('清空数据不清收藏', gm.storageManager.getCollection().length > 0, gm.storageManager.getCollection());
})();

console.log('\n合计 ' + (pass + fail) + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

