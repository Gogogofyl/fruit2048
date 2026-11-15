/**
 * 对局主控：把输入、棋盘、渲染与存档串成一局完整游戏。
 *
 * 一次有效的滑动包含四个阶段：
 *   1. 记录全部方块的当前位置，供合成后的位移动画使用；
 *   2. 按逆着移动方向的自远而近顺序逐格扫描，先把方块推到最远的空位；
 *   3. 被推到的下一格若存在同等级且未被合并的方块，则两者合成；
 *   4. 只要有任何方块挪动过位置，就在空位补一颗新方块并判断是否还能继续。
 */

// 方向向量，索引即输入层约定的方向编号：0 上、1 右、2 下、3 左
const MOVE_VECTORS = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 }
];

class GameManager {
  constructor(size, InputManager, Renderer, StorageManager) {
    this.size = size;
    this.inputManager = new InputManager();
    this.storageManager = new StorageManager();
    this.renderer = new Renderer(this.inputManager);

    this.startTiles = 2;
    this.reviveUsed = false; // 本局是否已消耗过复活机会

    this.inputManager.on("move", this.move.bind(this));
    this.inputManager.on("restart", this.restart.bind(this));
    this.inputManager.on("continueAfterWin", this.continueAfterWin.bind(this));

    this.setup();
  }

  /* ---------------- 对局生命周期 ---------------- */

  /** 重开一局：清掉本地存档、关闭结算层、重置复活标记 */
  restart() {
    this.storageManager.clearGameState();
    this.renderer.continueGame();
    this.reviveUsed = false;
    this.setup();
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

    if (saved) {
      this.grid = new Grid(saved.grid.size, saved.grid.cells);
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
    if (this.score > this.storageManager.getBestScore()) {
      this.storageManager.setBestScore(this.score);
    }

    // 失败时清档，其余情况每步都保留快照，便于下次进入时续玩
    if (this.over) {
      this.storageManager.clearGameState();
    } else {
      this.storageManager.setGameState(this.serialize());
    }

    this.renderer.draw(this.grid, {
      score: this.score,
      over: this.over,
      won: this.won,
      bestScore: this.storageManager.getBestScore(),
      terminated: this.isGameTerminated(),
      reviveUsed: this.reviveUsed
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

  /* ---------------- 滑动与合成 ---------------- */

  /** 执行一次滑动，direction 取 0 至 3 */
  move(direction) {
    if (this.isGameTerminated()) return;

    const vector = MOVE_VECTORS[direction];
    if (!vector) return;

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
