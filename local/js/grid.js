/**
 * 棋盘网格：横向 4 列、纵向 4 行的二维容器。
 * 负责格子寻址、占位判定、空位采样与整盘存档还原。
 * 约定 cells 的第一维为列（x），第二维为行（y）。
 */
class Grid {
  constructor(size, snapshot) {
    this.size = size;
    this.cells = snapshot ? Grid.restore(snapshot) : Grid.create(size);
  }

  /** 生成一张全空的棋盘 */
  static create(size) {
    const board = [];
    for (let col = 0; col < size; col++) {
      const column = [];
      for (let row = 0; row < size; row++) {
        column.push(null);
      }
      board.push(column);
    }
    return board;
  }

  /** 按存档中的格子数组还原棋盘，逐格重建方块实例 */
  static restore(snapshot) {
    const board = [];
    for (let col = 0; col < snapshot.length; col++) {
      const column = [];
      const savedColumn = snapshot[col] || [];
      for (let row = 0; row < savedColumn.length; row++) {
        const entry = savedColumn[row];
        column.push(entry ? new Tile(entry.position, entry.value) : null);
      }
      board.push(column);
    }
    return board;
  }

  /** 遍历全部格子，访问函数签名为 (x, y, tile) */
  eachCell(visitor) {
    for (let col = 0; col < this.size; col++) {
      for (let row = 0; row < this.size; row++) {
        visitor(col, row, this.cells[col][row]);
      }
    }
  }

  /** 坐标是否落在棋盘范围内 */
  withinBounds(cell) {
    return cell.x >= 0 && cell.x < this.size &&
           cell.y >= 0 && cell.y < this.size;
  }

  /** 读取格子内容，越界或空位统一返回 null */
  cellContent(cell) {
    if (!this.withinBounds(cell)) return null;
    return this.cells[cell.x][cell.y];
  }

  /** 格子是否已被方块占据 */
  cellOccupied(cell) {
    return this.cellContent(cell) !== null;
  }

  /** 格子是否空缺 */
  cellAvailable(cell) {
    return !this.cellOccupied(cell);
  }

  /** 收集当前所有空位的坐标 */
  freeCells() {
    const blanks = [];
    this.eachCell((x, y, tile) => {
      if (tile === null) blanks.push({ x: x, y: y });
    });
    return blanks;
  }

  /** 棋盘上是否还存在空位 */
  cellsAvailable() {
    return this.freeCells().length > 0;
  }

  /** 随机取一个空位，棋盘已满时返回 null */
  randomFreeCell() {
    const blanks = this.freeCells();
    if (blanks.length === 0) return null;
    const pick = Math.floor(Math.random() * blanks.length);
    return blanks[pick];
  }

  /** 把方块放入其坐标对应的格子 */
  insertTile(tile) {
    this.cells[tile.x][tile.y] = tile;
    return this;
  }

  /** 把方块从所在格子清空 */
  removeTile(tile) {
    this.cells[tile.x][tile.y] = null;
    return this;
  }

  /** 导出整盘状态为可持久化的纯数据 */
  serialize() {
    const snapshot = [];
    for (let col = 0; col < this.size; col++) {
      const column = [];
      for (let row = 0; row < this.size; row++) {
        const tile = this.cells[col][row];
        column.push(tile ? tile.serialize() : null);
      }
      snapshot.push(column);
    }
    return { size: this.size, cells: snapshot };
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.Grid = Grid;
}
