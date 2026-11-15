/**
 * 水果方块：棋盘上的最小可操作单元。
 * 只承载状态 —— 等级分值、所在列行坐标、动画插值所需的上一帧坐标，
 * 以及本次是否由两个方块合并而成（合并来源用于渲染层的强调动画）。
 */
class Tile {
  constructor(cell, value) {
    this.x = cell.x;
    this.y = cell.y;
    this.value = (typeof value === "number" && value > 0) ? value : 2;
    this.previousPosition = null;
    this.mergedFrom = null;
  }

  /** 移动前记录一次坐标快照，渲染层据此做位移插值 */
  savePosition() {
    this.previousPosition = { x: this.x, y: this.y };
    return this;
  }

  /** 就地改写坐标，保持对象引用不变，避免渲染层持有的引用失效 */
  updatePosition(cell) {
    this.x = cell.x;
    this.y = cell.y;
    return this;
  }

  /** 标记本方块由指定的两颗合成而来 */
  markMergedFrom(first, second) {
    this.mergedFrom = [first, second];
    return this;
  }

  /** 导出为可持久化的纯数据，不含方法引用 */
  serialize() {
    return {
      position: { x: this.x, y: this.y },
      value: this.value
    };
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.Tile = Tile;
}
