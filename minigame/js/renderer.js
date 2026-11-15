/**
 * Canvas 渲染器：替代原 H5 的 HTMLActuator。
 * 负责绘制背景、顶部分数、棋盘、水果贴图与分级渐变底色、结束遮罩，
 * 并在 rAF 帧循环里补回滑动 / 弹出 / 合并回弹 / 加分飘字动画。
 */

// 等级 -> 水果贴图 + 分级渐变底色（rgba 分量, 与 H5 版 main.css 保持一致）
var FRUIT_MAP = {
  2:    { img: '02-blueberry.png',            g: ['238,231,221,.55', '228,220,208,.35'] },
  4:    { img: '04-grape.png',               g: ['199,229,164,.55', '163,209,128,.35'] },
  8:    { img: '08-orange.png',              g: ['140,200,105,.60', '102,176,80,.40'] },
  16:   { img: '16-peach.png',               g: ['170,210,238,.60', '124,182,224,.40'] },
  32:   { img: '32-pineapple.png',           g: ['90,150,235,.62', '48,115,205,.42'] },
  64:   { img: '64-coconut.png',             g: ['168,152,216,.58', '138,116,196,.38'] },
  128:  { img: '128-melon.png',               g: ['149,117,205,.62', '110,82,170,.42'] },
  256:  { img: '256-kiwi-gold.png',           g: ['239,124,92,.62',  '214,78,66,.42'] },
  512:  { img: '512-strawberry.png',         g: ['229,92,92,.62',  '198,58,58,.42'] },
  1024: { img: '1024-dragonfruit.png',        g: ['196,96,140,.62', '158,66,116,.42'] },
  2048: { img: '2048-golden-watermelon.png',  g: ['214,64,64,.66',  '170,36,36,.46'] }
};

function createCanvas() {
  if (Platform.hasTT) return tt.createCanvas();
  var c = document.createElement('canvas');
  document.body.appendChild(c);
  return c;
}

function createImage() {
  if (Platform.hasTT) return tt.createImage();
  return new Image();
}

function raf(cb) {
  if (typeof requestAnimationFrame !== 'undefined') return requestAnimationFrame(cb);
  return setTimeout(cb, 16);
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function easeOutBack(t) {
  var c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
// 合并回弹：先冲到略大再回落，Q 弹手感
function popScale(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (t < 0.55) return 0.15 + (1.18 - 0.15) * (t / 0.55);
  return 1.18 - 0.18 * ((t - 0.55) / 0.45);
}

function Renderer(inputManager) {
  this.inputManager = inputManager;
  this.sys = Platform.getSystemInfo();
  this.W = this.sys.windowWidth;
  this.H = this.sys.windowHeight;
  this.dpr = this.sys.pixelRatio || 1;
  this.s = Math.min(this.W / 375, this.H / 667, 1.2); // 缩放封顶，避免宽屏把棋盘/字号拉爆

  this.canvas = createCanvas();
  this.ctx = this.canvas.getContext('2d');
  this.canvas.width = this.W * this.dpr;
  this.canvas.height = this.H * this.dpr;
  // CSS 显示尺寸与逻辑像素对齐，保证点击坐标命中区域一致
  if (typeof this.canvas.style !== 'undefined') {
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
  }
  this.ctx.scale(this.dpr, this.dpr);

  this.meta = null;
  this.buttons = [];
  this.images = {};
  this.layout = {};
  this.currentGrid = null;
  this.currentMeta = null;

  // 动画状态
  this.animations = [];   // { tile, type, fx, fy, tx, ty, start, delay, dur }
  this.floaters = [];      // { text, x, y, start, dur }
  this.lastScore = null;
  this.rafId = null;

  this.loadImages();
  this.bindTap();
}

Renderer.prototype.loadImages = function () {
  var self = this;
  Object.keys(FRUIT_MAP).forEach(function (key) {
    var im = createImage();
    im.onload = function () {
      // 图片异步到位后静态重绘一次，不重播滑动/弹动动画
      if (self.currentGrid) self.renderFrame();
    };
    im.src = 'images/fruits/' + FRUIT_MAP[key].img;
    self.images[key] = im;
  });
};

Renderer.prototype.continueGame = function () {
  this.meta = null;
  this.buttons = [];
};

// ---------- 布局 ----------
Renderer.prototype.computeLayout = function () {
  var s = this.s;
  var gap = 12 * s;
  var boardSize = Math.min(this.W - 32 * s, 420); // 宽屏固定限宽，棋盘保持手机比例
  var margin = (this.W - boardSize) / 2;
  var cell = (boardSize - gap * 5) / 4; // 四周各留 gap，4 格 + 3 间距 = 底板内宽
  var boardTop = 116 * s;
  this.layout = { margin: margin, boardSize: boardSize, gap: gap, cell: cell, boardTop: boardTop };
};

Renderer.prototype.pxOf = function (gx) {
  var L = this.layout;
  return L.margin + L.gap + gx * (L.cell + L.gap);
};
Renderer.prototype.pyOf = function (gy) {
  var L = this.layout;
  return L.boardTop + L.gap + gy * (L.cell + L.gap);
};

// ---------- 入口 ----------
Renderer.prototype.draw = function (grid, meta) {
  this.meta = meta;
  this.currentGrid = grid;
  this.currentMeta = meta;
  this.computeLayout();

  this.captureAnimations(grid);
  this.captureScoreFloater(meta);
  this.startLoop();
};

// 根据 tile 自带的 previousPosition / mergedFrom 生成本次动画项
Renderer.prototype.captureAnimations = function (grid) {
  var self = this;
  this.animations = [];
  var now = Date.now();

  grid.eachCell(function (x, y, tile) {
    if (!tile) return;
    if (tile.mergedFrom) {
      // 合并出新块：Q 弹回弹
      self.animations.push({
        tile: tile, type: 'pop',
        fx: x, fy: y, tx: x, ty: y,
        start: now, delay: 100, dur: 200
      });
    } else if (tile.previousPosition &&
      (tile.previousPosition.x !== x || tile.previousPosition.y !== y)) {
      // 普通滑动：旧格 -> 新格
      self.animations.push({
        tile: tile, type: 'slide',
        fx: tile.previousPosition.x, fy: tile.previousPosition.y,
        tx: x, ty: y,
        start: now, delay: 0, dur: 100
      });
    } else if (!tile.previousPosition) {
      // 新增块：弹出
      self.animations.push({
        tile: tile, type: 'appear',
        fx: x, fy: y, tx: x, ty: y,
        start: now, delay: 100, dur: 200
      });
    }
  });
};

Renderer.prototype.captureScoreFloater = function (meta) {
  if (this.lastScore === null) { this.lastScore = meta.score; return; }
  var diff = meta.score - this.lastScore;
  this.lastScore = meta.score;
  if (diff > 0) {
    var s = this.s;
    var boxW = 64 * s, boxH = 44 * s;
    var bx = this.W - 16 * s - boxW;
    this.floaters.push({ text: '+' + diff, x: bx + boxW / 2, y: 22 * s, start: Date.now(), dur: 600 });
  }
};

Renderer.prototype.startLoop = function () {
  if (this.rafId === null) this.rafId = raf(function () { this.tick(); }.bind(this));
};

Renderer.prototype.tick = function () {
  this.renderFrame();
  var now = Date.now();
  var alive = this.animations.some(function (a) { return now - a.start < a.delay + a.dur; });
  var aliveF = this.floaters.some(function (f) { return now - f.start < f.dur; });
  if (alive || aliveF) {
    this.rafId = raf(function () { this.tick(); }.bind(this));
  } else {
    this.rafId = null;
  }
};

// ---------- 实际绘制 ----------
Renderer.prototype.renderFrame = function () {
  var grid = this.currentGrid, meta = this.currentMeta;
  if (!grid) return;
  this.computeLayout();
  var ctx = this.ctx;

  ctx.clearRect(0, 0, this.W, this.H);
  this.drawBackground();
  this.drawHeader(meta);
  this.drawBoard(grid);
  this.drawFloaters();
  if (meta && meta.terminated) this.drawOverlay(meta);
};

Renderer.prototype.drawBackground = function () {
  var ctx = this.ctx;
  var g = ctx.createLinearGradient(0, 0, 0, this.H);
  g.addColorStop(0, '#fdeee3');
  g.addColorStop(0.45, '#f6e9dc');
  g.addColorStop(1, '#eef1e6');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, this.W, this.H);
};

Renderer.prototype.drawHeader = function (meta) {
  var ctx = this.ctx, s = this.s;
  ctx.fillStyle = '#776e65';
  ctx.textBaseline = 'middle';

  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('2048', 16 * s, 44 * s);

  var boxW = 64 * s, boxH = 44 * s, gap = 8 * s;
  var bx = this.W - 16 * s - boxW;
  var by = 22 * s;
  this.drawScoreBox(bx, by, boxW, boxH, 'SCORE', meta.score);
  this.drawScoreBox(bx - boxW - gap, by, boxW, boxH, 'BEST', meta.bestScore);
};

Renderer.prototype.drawScoreBox = function (x, y, w, h, label, value) {
  var ctx = this.ctx, s = this.s;
  ctx.fillStyle = '#bbada0';
  roundRect(ctx, x, y, w, h, 6 * s);
  ctx.fill();

  ctx.fillStyle = '#eee4da';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x + w / 2, y + 12 * s);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText(String(value), x + w / 2, y + h - 14 * s);
};

Renderer.prototype.drawBoard = function (grid) {
  var ctx = this.ctx, L = this.layout, self = this;
  var now = Date.now();

  ctx.fillStyle = '#bbada0';
  roundRect(ctx, L.margin, L.boardTop, L.boardSize, L.boardSize, 8 * this.s);
  ctx.fill();

  grid.eachCell(function (gx, gy, tile) {
    var px = self.pxOf(gx), py = self.pyOf(gy);

    if (!tile) {
      ctx.fillStyle = 'rgba(255,255,255,.18)';
      roundRect(ctx, px, py, L.cell, L.cell, 6 * self.s);
      ctx.fill();
      return;
    }

    var anim = self.animations.filter(function (a) { return a.tile === tile; })[0];
    var drawPx = px, drawPy = py, scale = 1;

    if (anim) {
      var t = clamp01((now - anim.start - anim.delay) / anim.dur);
      if (anim.type === 'slide') {
        var e = easeInOut(t);
        drawPx = self.pxOf(Math.round(anim.fx + (anim.tx - anim.fx) * e));
        drawPy = self.pyOf(Math.round(anim.fy + (anim.ty - anim.fy) * e));
      } else if (anim.type === 'pop') {
        scale = popScale(t);
      } else if (anim.type === 'appear') {
        scale = easeOutBack(t);
      }
    }

    self.drawTile(drawPx, drawPy, L.cell, tile, scale);
  });
};

Renderer.prototype.drawTile = function (px, py, size, tile, scale) {
  var ctx = this.ctx;
  scale = scale == null ? 1 : scale;
  var conf = FRUIT_MAP[tile.value];

  var cx = px + size / 2, cy = py + size / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);

  // 分级渐变底色
  if (conf) {
    var g = ctx.createLinearGradient(px, py, px + size, py + size);
    g.addColorStop(0, 'rgba(' + conf.g[0] + ')');
    g.addColorStop(1, 'rgba(' + conf.g[1] + ')');
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = '#3c3a32'; // 4096+ 兜底深色
  }
  roundRect(ctx, px, py, size, size, 6 * this.s);
  ctx.fill();

  // 水果贴图（88% 居中）
  var im = conf ? this.images[tile.value] : null;
  if (im && im.width) {
    var pad = size * 0.06;
    var iw = size - pad * 2;
    ctx.drawImage(im, px + pad, py + pad, iw, iw);
  } else if (!conf) {
    ctx.fillStyle = '#f9f6f2';
    ctx.font = 'bold ' + Math.round(size * 0.32) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(tile.value), px + size / 2, py + size / 2);
  }

  ctx.restore();
};

Renderer.prototype.drawFloaters = function () {
  var ctx = this.ctx, s = this.s, now = Date.now();
  this.floaters = this.floaters.filter(function (f) { return now - f.start < f.dur; });
  this.floaters.forEach(function (f) {
    var t = clamp01((now - f.start) / f.dur);
    var alpha = 1 - t;
    var y = f.y - 30 * s * t;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#e0453a';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(f.text, f.x, y);
    ctx.restore();
  });
};

Renderer.prototype.drawOverlay = function (meta) {
  var ctx = this.ctx, L = this.layout, s = this.s;
  this.buttons = [];

  ctx.fillStyle = 'rgba(238,228,218,.72)';
  ctx.fillRect(L.margin, L.boardTop, L.boardSize, L.boardSize);

  var title = meta.over ? '游戏结束' : '你赢了！';
  ctx.fillStyle = '#776e65';
  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, this.W / 2, L.boardTop + L.boardSize / 2 - 30 * s);

  var bw = 120 * s, bh = 40 * s, bx = this.W / 2 - bw / 2;
  var by = L.boardTop + L.boardSize / 2 + 10 * s;

  this.drawButton(bx, by, bw, bh, '再来一局', '#8f7a66', 'restart');

  if (!meta.over) {
    this.drawButton(bx, by + bh + 12 * s, bw, bh, '继续挑战', '#edc22e', 'continueAfterWin');
  }
};

Renderer.prototype.drawButton = function (x, y, w, h, label, color, action) {
  var ctx = this.ctx, s = this.s;
  ctx.fillStyle = color;
  roundRect(ctx, x, y, w, h, 6 * s);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, y + h / 2);

  this.buttons.push({ x: x, y: y, w: w, h: h, action: action });
};

// ---------- 点击 ----------
Renderer.prototype.bindTap = function () {
  var self = this;

  function hit(x, y) {
    var fired = false;
    self.buttons.forEach(function (b) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        self.inputManager.emit(b.action);
        fired = true;
      }
    });
    return fired;
  }

  if (Platform.hasTT) {
    tt.onTouchEnd(function (e) {
      var t = (e.changedTouches && e.changedTouches[0]) || e;
      hit(t.clientX, t.clientY);
    });
  } else {
    this.canvas.addEventListener('touchend', function (e) {
      var t = e.changedTouches[0];
      if (hit(t.clientX, t.clientY)) e.preventDefault(); // 阻止合成 click 重复触发
    });
    this.canvas.addEventListener('click', function (e) {
      hit(e.offsetX, e.offsetY);
    });
  }
};

globalThis.Renderer = Renderer;
globalThis.FRUIT_MAP = FRUIT_MAP;
