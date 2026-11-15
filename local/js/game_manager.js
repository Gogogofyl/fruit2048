/**
 * 对局主控：把输入、棋盘、渲染与存档串成一局完整游戏。
 *
 * 一次有效的滑动包含四个阶段：
 *   1. 记录全部方块的当前位置，供合成后的位移动画使用；
 *   2. 按逆着移动方向的自远而近顺序逐格扫描，先把方块推到最远的空位；
 *   3. 被推到的下一格若存在同等级且未被合并的方块，则两者合成；
 *   4. 只要有任何方块挪动过位置，就在空位补一颗新方块并判断是否还能继续。
 *
 * 除基本玩法外还提供两项道具与本地榜单：
 *   - 回退：滑动前的棋盘快照进栈，可逐步退回；
 *   - 消除：指定格子的方块直接移除，每局限次（次数来自设置）。
 */

// 方向向量，索引即输入层约定的方向编号：0 上、1 右、2 下、3 左
const MOVE_VECTORS = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 }
];

// 收藏家里每一级的名字，顺序即面板展示顺序
const FRUIT_ORDER = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];

const FRUIT_NAMES = {
  2: "蓝莓",
  4: "青提",
  8: "橙子",
  16: "桃子",
  32: "菠萝",
  64: "椰子",
  128: "哈密瓜",
  256: "金果",
  512: "草莓",
  1024: "火龙果",
  2048: "金西瓜"
};

class GameManager {
  constructor(size, InputManager, Renderer, StorageManager) {
    this.size = size;
    this.inputManager = new InputManager();
    this.storageManager = new StorageManager();
    this.renderer = new Renderer(this.inputManager);

    this.startTiles = 2;
    this.reviveUsed = false;   // 本局是否已消耗过复活机会

    this.settings = this.storageManager.getSettings();
    this.collection = this.storageManager.getCollection();   // 已解锁的水果等级
    this.history = [];         // 回退栈：每次移动前的棋盘快照
    this.historyLimit = 30;
    this.eraseLimit = this.settings.erase;   // 0 表示不限次
    this.eraseLeft = 3;
    this.runLogged = false;    // 本局成绩是否已写入榜单

    this.inputManager.on("move", this.move.bind(this));
    this.inputManager.on("restart", this.restart.bind(this));
    this.inputManager.on("continueAfterWin", this.continueAfterWin.bind(this));
    this.inputManager.on("undo", this.undo.bind(this));
    this.inputManager.on("pickTile", this.eraseAt.bind(this));
    this.inputManager.on("settingsChanged", this.applySettings.bind(this));
    this.inputManager.on("resetData", this.resetData.bind(this));
    this.inputManager.on("requestLeaderboard", this.publishLeaderboard.bind(this));
    this.inputManager.on("requestCollection", this.publishCollection.bind(this));
    this.inputManager.on("startGame", this.startGame.bind(this));

    // 历史偏好里的棋盘尺寸优先于传进来的默认值
    this.applyModeSize();
    this.setup();
  }

  /** 主菜单的「开始游戏」：没结束就接着玩，已经结束就重开 */
  startGame() {
    this.renderer.closeSheets();

    if (this.isGameTerminated()) {
      this.restart();
    } else {
      this.renderer.continueGame();
    }
  }

  /* ---------------- 对局生命周期 ---------------- */

  /** 重开一局：清掉本地存档、关闭结算层、重置回退栈与道具 */
  restart() {
    this.storageManager.clearGameState();
    this.applyModeSize();
    this.renderer.continueGame();
    this.reviveUsed = false;
    this.setup();
  }

  /** 把设置里选定的棋盘尺寸落到对局与渲染层上 */
  applyModeSize() {
    const want = this.settings && this.settings.size ? this.settings.size : this.size;
    if (!(want >= 4 && want <= 6)) return;
    if (want === this.size) return;
    this.size = want;
    if (this.renderer && typeof this.renderer.setGridSize === 'function') {
      this.renderer.setGridSize(want);
    }
  }

  /** 切换模式：清掉当前对局，按新尺寸重开 */
  setMode(size) {
    const n = parseInt(size, 10);
    if (!(n >= 4 && n <= 6) || n === this.size) return false;
    this.settings.size = n;
    this.storageManager.setSettings(this.settings);
    this.restart();
    return true;
  }

  /** 通关后选择继续挑战，允许数值突破 2048 */
  continueAfterWin() {
    this.keepPlaying = true;
    this.renderer.continueGame();
  }

  /** 对局是否已终止：失败，或通关后尚未选择继续 */
  isGameTerminated() {
    return Boolean(this.over) || (Boolean(this.won) && !this.keepPlaying);
  }

  /** 初始化一局：优先还原本地存档，无存档则开新局 */
  setup() {
    const saved = this.storageManager.getGameState();

    this.history = [];
    this.runLogged = false;
    this.eraseLimit = this.settings.erase;
    this.eraseLeft = this.eraseLimit === 0 ? -1 : this.eraseLimit;

    if (saved) {
      this.grid = new Grid(saved.grid.size, saved.grid.cells);
      // 存档的棋盘尺寸优先，保证坐标体系与盘面一致
      if (saved.grid.size && saved.grid.size !== this.size) {
        this.size = saved.grid.size;
        if (this.renderer && typeof this.renderer.setGridSize === 'function') {
          this.renderer.setGridSize(this.size);
        }
      }
      this.score = saved.score;
      this.over = saved.over;
      this.won = saved.won;
      this.keepPlaying = saved.keepPlaying;
      this.reviveUsed = Boolean(saved.reviveUsed);
    } else {
      this.grid = new Grid(this.size);
      this.score = 0;
      this.over = false;
      this.won = false;
      this.keepPlaying = false;
      this.reviveUsed = false;
      this.spawnInitialTiles();
    }

    // 开盘或读档时扫一遍盘面，把已经出现过的等级收进图鉴（静默，不弹提示）
    this.unlockCollectibles(true);

    this.actuate();
  }

  /** 开局时的两颗起步方块 */
  spawnInitialTiles() {
    for (let i = 0; i < this.startTiles; i++) {
      this.spawnTile();
    }
  }

  /** 在随机空位补一颗新方块，九成概率为最低等级 */
  spawnTile() {
    const blank = this.grid.randomFreeCell();
    if (!blank) return null;

    const value = Math.random() < 0.9 ? 2 : 4;
    const tile = new Tile(blank, value);
    this.grid.insertTile(tile);
    return tile;
  }

  /** 结算并刷新界面：维护最高分、按需落盘、把快照交给渲染层 */
  actuate() {
    if (this.score > this.storageManager.getBestScore(this.size)) {
      this.storageManager.setBestScore(this.score, this.size);
    }

    // 无路可走时把这一局写进本地榜单，并清掉续玩存档
    if (this.over && !this.runLogged) {
      this.runLogged = true;
      this.storageManager.addRun({
        score: this.score,
        maxTile: this.maxTile(),
        size: this.size,
        at: Date.now()
      });
    }

    if (this.over) {
      this.storageManager.clearGameState();
    } else {
      this.storageManager.setGameState(this.serialize());
    }

    this.renderer.draw(this.grid, {
      score: this.score,
      over: this.over,
      won: this.won,
      bestScore: this.storageManager.getBestScore(this.size),
      terminated: this.isGameTerminated(),
      reviveUsed: this.reviveUsed,
      canUndo: this.history.length > 0,
      eraseLeft: this.eraseLeft,
      eraseLimit: this.eraseLimit,
      settings: this.settings
    });
  }

  /** 导出当前对局，供本地存档使用 */
  serialize() {
    return {
      grid: this.grid.serialize(),
      score: this.score,
      over: this.over,
      won: this.won,
      keepPlaying: this.keepPlaying,
      reviveUsed: this.reviveUsed
    };
  }

  /* ---------------- 棋盘快照与回退 ---------------- */

  /** 拍一份纯数据的棋盘快照（不含动画态） */
  snapshot() {
    return {
      size: this.grid.size,
      cells: this.grid.serialize().cells,
      score: this.score,
      won: this.won,
      keepPlaying: this.keepPlaying
    };
  }

  /** 快照入栈，超出上限就丢掉最老的一份 */
  pushHistory(snapshot) {
    this.history.push(snapshot);
    if (this.history.length > this.historyLimit) this.history.shift();
  }

  /** 用快照覆盖当前棋盘 */
  applySnapshot(snapshot) {
    this.grid = new Grid(snapshot.size, snapshot.cells);
    this.score = snapshot.score;
    this.won = snapshot.won;
    this.keepPlaying = snapshot.keepPlaying;
    this.over = false;
  }

  /** 回退上一步：连按可逐步退回，死局时也能靠它救回来 */
  undo() {
    if (this.history.length === 0) return false;

    const snapshot = this.history.pop();
    this.applySnapshot(snapshot);
    this.actuate();
    return true;
  }

  /* ---------------- 消除道具 ---------------- */

  /** 移除指定格子上的方块；返回是否真的消除了一颗 */
  eraseAt(cell) {
    if (this.isGameTerminated()) return false;
    if (this.renderer.isModalOpen && this.renderer.isModalOpen()) return false;
    if (this.eraseLeft === 0) return false;
    if (!cell) return false;

    const tile = this.grid.cellContent(cell);
    if (!tile) return false;

    this.pushHistory(this.snapshot());
    this.grid.removeTile(tile);

    if (this.eraseLeft > 0) this.eraseLeft--;

    // 消掉一颗后可能重新有腾挪空间，也可能仍无路可走
    this.over = !this.canContinue();
    this.actuate();
    return true;
  }

  /** 当前盘面上的最高等级 */
  maxTile() {
    let max = 0;
    this.grid.eachCell((x, y, tile) => {
      if (tile && tile.value > max) max = tile.value;
    });
    return max;
  }

  /* ---------------- 设置与数据 ---------------- */

  applySettings(patch) {
    const prevSize = this.settings.size;
    this.settings = Object.assign({}, this.settings, patch || {});
    this.storageManager.setSettings(this.settings);

    this.eraseLimit = this.settings.erase;
    if (this.eraseLimit === 0) {
      this.eraseLeft = -1;
    } else if (this.eraseLeft < 0) {
      this.eraseLeft = this.eraseLimit;
    } else {
      this.eraseLeft = Math.min(this.eraseLeft, this.eraseLimit);
    }

    // 音效与背景音乐的音量/开关随设置项实时生效
    if (typeof Sfx !== 'undefined' && Sfx) {
      Sfx.setEnabled(this.settings.sfx !== false);
      if (typeof Sfx.setVolume === 'function') {
        Sfx.setVolume(typeof this.settings.sfxVol === 'number' ? this.settings.sfxVol : 0.7);
      }
      if (typeof Sfx.setMusicEnabled === 'function') {
        Sfx.setMusicEnabled(this.settings.music !== false);
      }
      if (typeof Sfx.setMusicVolume === 'function') {
        Sfx.setMusicVolume(typeof this.settings.musicVol === 'number' ? this.settings.musicVol : 0.35);
      }
    }

    // 棋盘尺寸变了就按新尺寸重开一局，避免盘面与坐标体系错位
    if (prevSize !== this.settings.size) {
      this.setMode(this.settings.size);
      return;
    }

    this.actuate();
  }

  /** 把本地榜单发给界面渲染（按当前棋盘尺寸过滤） */
  publishLeaderboard() {
    this.renderer.showLeaderboard(this.storageManager.getLeaderboard(this.size));
  }

  /* ---------------- 收藏家 ---------------- */

  /** 点亮一级水果；silent 为真时只记数据、不弹提示 */
  unlockCollectible(value, silent) {
    if (!value || value < 2) return false;
    if (this.collection.indexOf(value) !== -1) return false;

    this.collection.push(value);
    this.collection.sort(function (a, b) { return a - b; });
    this.storageManager.setCollection(this.collection);

    if (!silent) {
      // 渲染层可能没实现提示，别让图鉴把整局逻辑带崩
      if (typeof this.renderer.onCollect === "function") {
        this.renderer.onCollect(value, FRUIT_NAMES[value] || String(value));
      }
    }
    return true;
  }

  /** 扫一遍盘面，把已出现过的等级全部点亮（开局与读档时兜底） */
  unlockCollectibles(silent) {
    const values = [];
    this.grid.eachCell((x, y, tile) => {
      if (tile) values.push(tile.value);
    });
    values.forEach((value) => this.unlockCollectible(value, silent));
  }

  /** 图鉴面板需要的数据：等级、名字、有没有点亮 */
  collectionEntries() {
    return FRUIT_ORDER.map((value) => ({
      value: value,
      name: FRUIT_NAMES[value] || String(value),
      unlocked: this.collection.indexOf(value) !== -1
    }));
  }

  publishCollection() {
    this.renderer.showCollection(this.collectionEntries());
  }

  /** 清空最高分、榜单与续玩存档，随后开新局 */
  resetData() {
    this.storageManager.resetAll();
    this.restart();
    this.renderer.showLeaderboard(this.storageManager.getLeaderboard(this.size));
  }

  /* ---------------- 滑动与合成 ---------------- */

  /** 执行一次滑动，direction 取 0 至 3 */
  move(direction) {
    if (this.isGameTerminated()) return;
    if (this.renderer.isBlocking && this.renderer.isBlocking()) return;

    const vector = MOVE_VECTORS[direction];
    if (!vector) return;

    const before = this.snapshot();   // 滑动前留档，供回退使用

    this.resetMotionTrail();

    const sweep = this.sweepOrder(vector);
    let changed = false;

    for (let ci = 0; ci < sweep.cols.length; ci++) {
      const col = sweep.cols[ci];

      for (let ri = 0; ri < sweep.rows.length; ri++) {
        const row = sweep.rows[ri];
        const origin = { x: col, y: row };
        const tile = this.grid.cellContent(origin);
        if (!tile) continue;

        const slide = this.slideToEnd(origin, vector);
        const blocker = this.grid.cellContent(slide.next);

        if (blocker && blocker.value === tile.value && !blocker.mergedFrom) {
          // 同等级且对方本步尚未参与合成，两者合并升一级
          this.absorb(tile, blocker, slide.next);
        } else if (slide.farthest.x !== origin.x || slide.farthest.y !== origin.y) {
          // 前方仍有空位，推到尽头
          this.transfer(tile, slide.farthest);
        }

        if (tile.x !== origin.x || tile.y !== origin.y) {
          changed = true;
        }
      }
    }

    if (!changed) return;

    this.pushHistory(before);
    this.spawnTile();

    if (!this.canContinue()) {
      this.over = true;
    }

    this.actuate();
  }

  /** 每步开始前清掉上一步的合并标记，并记录位移起点 */
  resetMotionTrail() {
    this.grid.eachCell((x, y, tile) => {
      if (!tile) return;
      tile.mergedFrom = null;
      tile.savePosition();
    });
  }

  /** 生成扫描顺序：自移动方向的尽头往回扫，避免方块被反复推动 */
  sweepOrder(vector) {
    const cols = [];
    const rows = [];

    for (let i = 0; i < this.size; i++) {
      cols.push(i);
      rows.push(i);
    }

    if (vector.x > 0) cols.reverse();
    if (vector.y > 0) rows.reverse();

    return { cols: cols, rows: rows };
  }

  /** 从起点沿向量推进，直到下一格出界或被占据 */
  slideToEnd(origin, vector) {
    let last = origin;
    let next = { x: origin.x + vector.x, y: origin.y + vector.y };

    while (this.grid.withinBounds(next) && this.grid.cellAvailable(next)) {
      last = next;
      next = { x: last.x + vector.x, y: last.y + vector.y };
    }

    return { farthest: last, next: next };
  }

  /** 把方块平移到目标格 */
  transfer(tile, to) {
    this.grid.cells[tile.x][tile.y] = null;
    this.grid.cells[to.x][to.y] = tile;
    tile.updatePosition(to);
  }

  /** 合并：源方块并入目标格，生成升一级的新方块并累加分数 */
  absorb(source, target, at) {
    const merged = new Tile(at, source.value * 2);
    merged.markMergedFrom(source, target);

    this.grid.insertTile(merged);
    this.grid.removeTile(source);

    // 源方块坐标补到合并点，让它的位移动画收束在正确位置
    source.updatePosition(at);

    this.score += merged.value;

    // 第一次合出这一级水果时点亮收藏
    this.unlockCollectible(merged.value, false);

    if (merged.value === 2048) {
      this.won = true;
    }
  }

  /** 是否还能继续：有空位，或存在可合并的相邻同级方块 */
  canContinue() {
    if (this.grid.cellsAvailable()) return true;
    return this.hasMergePair();
  }

  /** 全盘扫描相邻同值方块 */
  hasMergePair() {
    for (let d = 0; d < MOVE_VECTORS.length; d++) {
      const vector = MOVE_VECTORS[d];

      for (let x = 0; x < this.size; x++) {
        for (let y = 0; y < this.size; y++) {
          const tile = this.grid.cellContent({ x: x, y: y });
          if (!tile) continue;

          const neighbour = this.grid.cellContent({ x: x + vector.x, y: y + vector.y });
          if (neighbour && neighbour.value === tile.value) {
            return true;
          }
        }
      }
    }

    return false;
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.GameManager = GameManager;
}
