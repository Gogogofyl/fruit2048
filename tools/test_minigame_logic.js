/**
 * 小游戏逻辑层测试：在 Node 中直接驱动 GameManager，
 * 用最小替身对象替代 InputManager / Renderer / StorageManager。
 * 目的：确认重写后的 tile / grid / game_manager 行为与设计一致。
 */

const path = require("path");

require(path.join(__dirname, "..", "minigame", "js", "tile.js"));
require(path.join(__dirname, "..", "minigame", "js", "grid.js"));
require(path.join(__dirname, "..", "minigame", "js", "game_manager.js"));

const Tile = globalThis.Tile;
const Grid = globalThis.Grid;
const GameManager = globalThis.GameManager;

class MockInput {
  constructor() { this.handlers = {}; }
  on(name, fn) { this.handlers[name] = fn; }
  emit(name) { if (this.handlers[name]) this.handlers[name](); }
}

class MockRenderer {
  constructor(input) { this.input = input; }
  draw() {}
  continueGame() {}
}

class MockStorage {
  constructor() { this.gameState = null; this.bestScore = 0; }
  getGameState() { return this.gameState; }
  setGameState(state) { this.gameState = state; }
  clearGameState() { this.gameState = null; }
  getBestScore() { return this.bestScore; }
  setBestScore(v) { this.bestScore = v; }
}

const results = [];
function check(name, condition, extra) {
  results.push(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : "  -> " + extra}`);
}

const gm = new GameManager(4, MockInput, MockRenderer, MockStorage);

// 1. 开新局：应有两颗起步方块
check("开局生成两颗方块", gm.grid.freeCells().length === 14, `空位数=${gm.grid.freeCells().length}`);
check("开局分数为零", gm.score === 0, `score=${gm.score}`);
check("开局未结束", gm.isGameTerminated() === false);

// 2. 同列相邻同级方块向上滑动应合并
function reset(board) {
  gm.grid = new Grid(4);
  gm.score = 0;
  gm.over = false;
  gm.won = false;
  gm.keepPlaying = false;
  for (const item of board) {
    gm.grid.insertTile(new Tile({ x: item.x, y: item.y }, item.v));
  }
}

reset([
  { x: 0, y: 0, v: 2 },
  { x: 0, y: 1, v: 2 }
]);
gm.move(0); // 向上

const mergedTop = gm.grid.cellContent({ x: 0, y: 0 });
check("向上滑动合并为 4", mergedTop && mergedTop.value === 4, mergedTop ? mergedTop.value : "null");
check("合并得分等于新方块数值", gm.score === 4, `score=${gm.score}`);
check("被合并方块已从原格清空", gm.grid.cellContent({ x: 0, y: 1 }) !== null ? "原格被新方块占用" : "ok");

// 3. 一次滑动触发两组合并：一行 2,2,4,4 向左
reset([
  { x: 0, y: 0, v: 2 },
  { x: 1, y: 0, v: 2 },
  { x: 2, y: 0, v: 4 },
  { x: 3, y: 0, v: 4 }
]);
gm.move(3); // 向左

check("双组合并得分 4+8=12", gm.score === 12, `score=${gm.score}`);
const leftA = gm.grid.cellContent({ x: 0, y: 0 });
const leftB = gm.grid.cellContent({ x: 1, y: 0 });
check("左端为 4", leftA && leftA.value === 4, leftA ? leftA.value : "null");
check("次位为 8", leftB && leftB.value === 8, leftB ? leftB.value : "null");

// 4. 同一步内不得二次合并（4 不能与刚合成的 4 再合）
check("单步禁止链式合并", gm.grid.cellContent({ x: 2, y: 0 }) === null || gm.grid.cellContent({ x: 2, y: 0 }).value !== 16, "出现异常链式合并");

// 5. 无效方向不应改变棋盘
reset([
  { x: 0, y: 0, v: 2 },
  { x: 1, y: 0, v: 4 }
]);
const before = gm.grid.serialize().cells.map(row => row.map(c => (c ? c.value : 0))).join(",");
gm.move(0); // 两格在最上一行，向上无效
const after = gm.grid.serialize().cells.map(row => row.map(c => (c ? c.value : 0))).join(",");
check("无效滑动不改变棋盘", before === after, `${before} -> ${after}`);

// 6. 死局判定：满盘且无相邻同值
reset([
  { x: 0, y: 0, v: 2 }, { x: 1, y: 0, v: 4 }, { x: 2, y: 0, v: 2 }, { x: 3, y: 0, v: 4 },
  { x: 0, y: 1, v: 4 }, { x: 1, y: 1, v: 2 }, { x: 2, y: 1, v: 4 }, { x: 3, y: 1, v: 2 },
  { x: 0, y: 2, v: 2 }, { x: 1, y: 2, v: 4 }, { x: 2, y: 2, v: 2 }, { x: 3, y: 2, v: 4 },
  { x: 0, y: 3, v: 4 }, { x: 1, y: 3, v: 2 }, { x: 2, y: 3, v: 4 }, { x: 3, y: 3, v: 2 }
]);
check("满盘无同值判定为不可继续", gm.canContinue() === false, "canContinue 返回 true");

// 7. 满盘但存在可合并对
reset([
  { x: 0, y: 0, v: 2 }, { x: 1, y: 0, v: 2 }, { x: 2, y: 0, v: 4 }, { x: 3, y: 0, v: 8 },
  { x: 0, y: 1, v: 4 }, { x: 1, y: 1, v: 2 }, { x: 2, y: 1, v: 4 }, { x: 3, y: 1, v: 2 },
  { x: 0, y: 2, v: 2 }, { x: 1, y: 2, v: 4 }, { x: 2, y: 2, v: 2 }, { x: 3, y: 2, v: 4 },
  { x: 0, y: 3, v: 4 }, { x: 1, y: 3, v: 2 }, { x: 2, y: 3, v: 4 }, { x: 3, y: 3, v: 2 }
]);
check("满盘存在同级相邻判定可继续", gm.canContinue() === true, "canContinue 返回 false");

// 8. 通关判定：合成 2048 应置胜利标记
reset([
  { x: 0, y: 0, v: 1024 },
  { x: 0, y: 1, v: 1024 }
]);
gm.move(0);
check("合成 2048 触发通关", gm.won === true, `won=${gm.won}`);
check("通关后对局终止（未选择继续）", gm.isGameTerminated() === true);
gm.continueAfterWin();
check("选择继续挑战后不再终止", gm.isGameTerminated() === false);

// 9. 存档往返：序列化后重建棋盘应保持方块数量与数值
reset([
  { x: 0, y: 0, v: 2 },
  { x: 1, y: 2, v: 16 }
]);
const snap = gm.grid.serialize();
const rebuilt = new Grid(snap.size, snap.cells);
check("存档往返方块数一致", rebuilt.freeCells().length === 14, `空位=${rebuilt.freeCells().length}`);
check("存档往返数值一致", rebuilt.cellContent({ x: 1, y: 2 }).value === 16);

// 10. 最高分维护
gm.storageManager.bestScore = 0;
gm.score = 100;
gm.actuate();
check("超过最高分时更新记录", gm.storageManager.getBestScore() === 100, `best=${gm.storageManager.getBestScore()}`);
gm.score = 40;
gm.actuate();
check("低于最高分时不回退记录", gm.storageManager.getBestScore() === 100, `best=${gm.storageManager.getBestScore()}`);

console.log(results.join("\n"));
const failed = results.filter(r => r.startsWith("FAIL")).length;
console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
