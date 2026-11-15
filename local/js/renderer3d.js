/**
 * Three.js 3D 渲染器（材质与光照版本）。
 *
 * 对外契约与 2D 版 Renderer 一致：构造接收 inputManager，暴露 draw / continueGame，
 * GameManager 可零改动换用。
 *
 * 质感来源：
 *   - 程序化木纹棋盘（Canvas 生成 map + bumpMap + roughness 变化）
 *   - 圆角倒角几何（Shape + ExtrudeGeometry），边缘有高光过渡
 *   - PMREM 环境光照（程序生成的等距柱状环境图），所有 PBR 材质都有环境反射
 *   - ACES 色调映射，避免高光死白
 *   - 方块顶面为穹顶曲面（细分平面按半径抬升），水果贴图有起伏而非贴纸
 *   - 每颗方块自带接触阴影贴片，补足平行光阴影之外的"落地感"
 */

(function () {
  "use strict";

  var TINTS = {
    2: 0xd9cdbb,
    4: 0xb7d98f,
    8: 0xd0a758,
    16: 0xe094a2,
    32: 0x5e9bd8,
    64: 0x8a72bd,
    128: 0x7350a8,
    256: 0xd06b50,
    512: 0xcc4f4f,
    1024: 0x9f5585,
    2048: 0xc13030
  };

  // 水果光晕：按品质取色，低等级淡、高等级亮，贴合各自本色
  var GLOW_TINTS = {
    2: 0x9fb4d6,
    4: 0xa6d472,
    8: 0xf19a42,
    16: 0xf6a8bd,
    32: 0xecc04a,
    64: 0xc1906a,
    128: 0xb0d880,
    256: 0xe0b03c,
    512: 0xe45c60,
    1024: 0xd8558f,
    2048: 0xffc63f
  };

  var CELL = 1.0;
  var BOARD_W = 4.5;
  var TILE_W = 0.80;
  var TILE_H = 0.30;
  var FRUIT_H = 0.86;      // 水果摆放高度上限，只用于把特效摆到果顶之上
  var BOARD_TOP = -0.03;   // 棋盘顶面高度
  var CELL_TOP = 0.012;    // 格底顶面高度

  /* ================= 程序化纹理 ================= */

  function newCanvas(w, h) {
    var cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    return cv;
  }

  function finishTexture(cv, srgb) {
    var tex = new THREE.CanvasTexture(cv);
    if (srgb) tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  }

  // 纵向木纹：弯曲线条 + 细颗粒噪声
  function makeWoodTexture() {
    var S = 512;
    var cv = newCanvas(S, S);
    var ctx = cv.getContext("2d");

    ctx.fillStyle = "#d3bb99";
    ctx.fillRect(0, 0, S, S);

    for (var i = 0; i < 90; i++) {
      var x = Math.random() * S;
      var w = 1.5 + Math.random() * 9;
      var dark = Math.random() > 0.42;
      var a = (dark ? 0.08 : 0.06) + Math.random() * 0.12;
      ctx.strokeStyle = dark
        ? "rgba(112,82,52," + a + ")"
        : "rgba(242,226,200," + a + ")";
      ctx.lineWidth = w;
      var phase = Math.random() * 6.28;
      var amp = 3 + Math.random() * 7;
      ctx.beginPath();
      for (var y = -8; y <= S + 8; y += 16) {
        var xx = x + Math.sin(y * 0.013 + phase) * amp;
        if (y === -8) ctx.moveTo(xx, y);
        else ctx.lineTo(xx, y);
      }
      ctx.stroke();
    }

    // 木节：三处年轮状同心椭圆
    for (var k = 0; k < 3; k++) {
      var cx = Math.random() * S;
      var cy = Math.random() * S;
      for (var r = 6; r < 46; r += 5) {
        ctx.strokeStyle = "rgba(105,76,48," + (0.05 + 0.02 * (r % 3)) + ")";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r * 0.7, r * 1.15, 0.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 颗粒噪声
    var img = ctx.getImageData(0, 0, S, S);
    var d = img.data;
    for (var p = 0; p < d.length; p += 4) {
      var n = (Math.random() - 0.5) * 16;
      d[p] += n;
      d[p + 1] += n;
      d[p + 2] += n;
    }
    ctx.putImageData(img, 0, 0);

    return finishTexture(cv, true);
  }

  // 磨砂面板的粗糙度贴图（噪点控制反光强弱）
  function makeRoughnessTexture() {
    var S = 256;
    var cv = newCanvas(S, S);
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "#9a9a9a";
    ctx.fillRect(0, 0, S, S);
    var img = ctx.getImageData(0, 0, S, S);
    var d = img.data;
    for (var p = 0; p < d.length; p += 4) {
      var v = 130 + (Math.random() - 0.5) * 60;
      d[p] = d[p + 1] = d[p + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return finishTexture(cv, false);
  }

  // 接触阴影：直接画成"黑色、中心浓边缘透明"的贴图，配合 transparent 使用
  function makeContactShadowTexture() {
    var S = 128;
    var cv = newCanvas(S, S);
    var ctx = cv.getContext("2d");
    var g = ctx.createRadialGradient(S / 2, S / 2, 3, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(24,14,4,0.62)");
    g.addColorStop(0.38, "rgba(24,14,4,0.46)");
    g.addColorStop(0.68, "rgba(24,14,4,0.2)");
    g.addColorStop(1, "rgba(24,14,4,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    var tex = finishTexture(cv, false);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  // 等距柱状环境图：暖光顶 + 冷灰底 + 一处窗光高亮
  function makeEnvTexture() {
    var W = 512;
    var H = 256;
    var cv = newCanvas(W, H);
    var ctx = cv.getContext("2d");

    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#fffaf0");
    g.addColorStop(0.34, "#f4ecdd");
    g.addColorStop(0.55, "#d8cbb6");
    g.addColorStop(0.8, "#8d8375");
    g.addColorStop(1, "#4a443c");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 窗光
    var wg = ctx.createRadialGradient(W * 0.28, H * 0.2, 8, W * 0.28, H * 0.2, 120);
    wg.addColorStop(0, "rgba(255,255,250,1)");
    wg.addColorStop(0.4, "rgba(255,250,235,0.5)");
    wg.addColorStop(1, "rgba(255,250,235,0)");
    ctx.fillStyle = wg;
    ctx.fillRect(0, 0, W, H);

    // 另一侧弱补光
    var wg2 = ctx.createRadialGradient(W * 0.78, H * 0.3, 6, W * 0.78, H * 0.3, 90);
    wg2.addColorStop(0, "rgba(255,244,224,0.55)");
    wg2.addColorStop(1, "rgba(255,244,224,0)");
    ctx.fillStyle = wg2;
    ctx.fillRect(0, 0, W, H);

    var tex = finishTexture(cv, true);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    return tex;
  }

  // 合成特效用的柔光球（Sprite）与粒子光点（Points）
  function makeGlowTexture() {
    var S = 256;
    var cv = newCanvas(S, S);
    var ctx = cv.getContext("2d");
    var g = ctx.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(255,247,225,1)");
    g.addColorStop(0.28, "rgba(255,232,190,0.72)");
    g.addColorStop(0.62, "rgba(255,215,150,0.26)");
    g.addColorStop(1, "rgba(255,210,140,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    var tex = finishTexture(cv, true);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  function makeSparkTexture() {
    var S = 64;
    var cv = newCanvas(S, S);
    var ctx = cv.getContext("2d");
    var g = ctx.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,244,220,0.82)");
    g.addColorStop(1, "rgba(255,236,200,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    var tex = finishTexture(cv, true);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  // 柔和光环：中心透明、中间一圈亮、外缘渐隐（比纯色圆环更"光"）
  function makeRingTexture() {
    var S = 256;
    var cv = newCanvas(S, S);
    var ctx = cv.getContext("2d");
    var g = ctx.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(255,248,232,0)");
    g.addColorStop(0.5, "rgba(255,242,214,0.06)");
    g.addColorStop(0.68, "rgba(255,238,205,0.75)");
    g.addColorStop(0.78, "rgba(255,226,180,0.42)");
    g.addColorStop(0.9, "rgba(255,214,160,0.1)");
    g.addColorStop(1, "rgba(255,210,150,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    var tex = finishTexture(cv, true);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  function makeBackgroundTexture() {
    var S = 512;
    var cv = newCanvas(S, S);
    var ctx = cv.getContext("2d");
    var g = ctx.createRadialGradient(S * 0.5, S * 0.38, 30, S * 0.5, S * 0.5, S * 0.78);
    g.addColorStop(0, "#fff8ea");
    g.addColorStop(0.5, "#f0e2c9");
    g.addColorStop(1, "#d6bd98");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    var tex = finishTexture(cv, true);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  /* ================= 几何工具 ================= */

  function roundedRectShape(w, h, r) {
    var s = new THREE.Shape();
    var x = -w / 2;
    var y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);
    s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }

  // 带倒角的圆角板，厚度沿 y 轴，居中于原点
  function roundedSlab(w, d, thickness, radius, bevel) {
    var shape = roundedRectShape(w, d, radius);
    var geo = new THREE.ExtrudeGeometry(shape, {
      depth: Math.max(0.001, thickness - bevel * 2),
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 2,
      curveSegments: 6
    });
    geo.center();
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  // 穹顶贴图面：细分平面，按离中心的距离抬升，形成轻微凸起
  function domePlane(size, segments, height) {
    var geo = new THREE.PlaneGeometry(size, size, segments, segments);
    var pos = geo.attributes.position;
    var half = size / 2;
    for (var i = 0; i < pos.count; i++) {
      var x = pos.getX(i);
      var y = pos.getY(i);
      var r = Math.sqrt(x * x + y * y) / half;
      var lift = height * Math.cos(Math.min(r, 1) * Math.PI / 2);
      pos.setZ(i, lift);
    }
    geo.computeVertexNormals();
    return geo;
  }

  function solidMaterial(opts) {
    var m = new THREE.MeshStandardMaterial(opts);
    m.color.convertSRGBToLinear();
    return m;
  }

  function physicalMaterial(opts) {
    var m = new THREE.MeshPhysicalMaterial(opts);
    m.color.convertSRGBToLinear();
    return m;
  }

  function easeOutBack(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    var c1 = 1.70158;
    var c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function popCurve(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    if (t < 0.55) return 0.15 + (1.18 - 0.15) * (t / 0.55);
    return 1.18 - 0.18 * ((t - 0.55) / 0.45);
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  // 榜单里只显示到日期，精确到时分秒没有意义
  function stampOf(at) {
    var d = at ? new Date(at) : null;
    if (!d || isNaN(d.getTime())) return "";
    return d.getFullYear() + "/" + pad2(d.getMonth() + 1) + "/" + pad2(d.getDate());
  }

  /* ================= 渲染器 ================= */

  function Renderer3D(inputManager) {
    this.inputManager = inputManager;
    this.meta = null;
    this.nodes = new Map();
    this.dying = [];
    this.fxList = [];
    this.looping = false;

    // 界面与设置状态（游戏逻辑给的 meta 会持续刷新）
    this.gridSize = 4;          // 当前棋盘边长，射线拾取要用
    this.fxScale = 1;           // 合成特效倍率：0 关 / 1 标准 / 1.35 强
    this.bgOpacity = 0.5;       // 背景板浓度
    this.settingsSig = "";      // 设置签名，值没变就不重复应用
    this.pickMode = false;      // 消除模式的选格状态
    this.modal = "";            // 当前打开的覆盖层 id，空串表示没有

    var sys = Platform.getSystemInfo();
    this.W = sys.windowWidth || window.innerWidth;
    this.H = sys.windowHeight || window.innerHeight;
    this.dpr = Math.min(sys.pixelRatio || window.devicePixelRatio || 1, 2);

    this.initRenderer();
    this.initScene();
    this.initBoard();
    this.loadTextures();
    this.cacheDom();
    this.bindDom();
  }

  Renderer3D.prototype.initRenderer = function () {
    var r = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    r.setPixelRatio(this.dpr);
    r.setSize(this.W, this.H);
    r.outputEncoding = THREE.sRGBEncoding;
    // 水果就是摄影贴图，再过一遍 ACES 会把颜色压灰、特效压平，这里直接按原色输出
    r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;

    r.domElement.style.display = "block";
    r.domElement.style.touchAction = "none";
    document.body.appendChild(r.domElement);

    this.renderer = r;
    this.canvas = r.domElement;

    this.initDomFx();
  };

  // 合成特效用的 DOM 图层：盖在画布上、不吃点击、不参与 3D 透明排序
  Renderer3D.prototype.initDomFx = function () {
    if (this.fxLayer) return;
    // 光晕和合成特效共用同一个叠加层：光晕元素先挂上去、特效后挂，
    // DOM 先后顺序保证特效永远压在最上面，也避免多层 fixed 叠加引起的合成问题
    var layer = document.createElement("div");
    layer.id = "fx-layer";
    layer.style.cssText =
      "position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:20;";
    document.body.appendChild(layer);
    this.fxLayer = layer;
    this.haloLayer = layer;
  };

  // 按品质上色：一颗水果背后一圈柔光，中心透明，只在外缘发光
  Renderer3D.prototype.paintHalo = function (el, value) {
    var color = GLOW_TINTS[value];
    if (typeof color !== "number") color = 0xffffff;
    var rgb = ((color >> 16) & 255) + "," + ((color >> 8) & 255) + "," + (color & 255);
    var rank = Math.round(Math.log2(Math.max(2, value)));
    var a1 = (0.24 + rank * 0.024).toFixed(3);       // 0.26 ~ 0.50，等级越高越亮
    var a2 = (0.11 + rank * 0.014).toFixed(3);       // 0.12 ~ 0.26
    el.style.background =
      "radial-gradient(circle," +
      "rgba(" + rgb + ",0) 0%," +
      "rgba(" + rgb + ",0) 36%," +
      "rgba(" + rgb + "," + a1 + ") 48%," +
      "rgba(" + rgb + "," + a2 + ") 62%," +
      "rgba(" + rgb + ",0) 78%)";
    el.style.filter = "blur(" + (2 + rank * 0.4).toFixed(1) + "px)";
  };

  Renderer3D.prototype.placeHalo = function (node, scale) {
    var halo = node.halo;
    if (!halo) return;
    var H = node.group.userData.H || 0.64;
    var Wf = node.group.userData.W || H;
    var pxPer = this.W / (this.vw || 4.6);           // 一个世界单位占多少屏幕像素
    var v = new THREE.Vector3(
      node.group.position.x,
      node.group.position.y + H * 0.5 * scale,
      node.group.position.z
    ).project(this.camera);
    var cx = (v.x * 0.5 + 0.5) * this.W;
    var cy = (-v.y * 0.5 + 0.5) * this.H;
    var d = Math.max(H, Wf) * 1.30 * scale * pxPer;
    if (d < 8) d = 8;
    halo.style.width = d.toFixed(1) + "px";
    halo.style.height = d.toFixed(1) + "px";
    halo.style.transform = "translate(" + (cx - d / 2).toFixed(1) + "px," + (cy - d / 2).toFixed(1) + "px)";
    halo.style.opacity = (Math.min(1, scale) * 0.95).toFixed(3);
  };

  Renderer3D.prototype.dropHalo = function (node) {
    if (node.halo && node.halo.parentNode) node.halo.parentNode.removeChild(node.halo);
    node.halo = null;
  };

  Renderer3D.prototype.initScene = function () {
    var scene = new THREE.Scene();
    scene.background = makeBackgroundTexture();
    this.scene = scene;

    var aspect = this.W / this.H;
    // 等距视角：四行四列在屏幕上等宽等高，没有近大远小，摆出来才是"棋盘阵"
    var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);
    camera.position.set(0, 9.3, 7.5);
    this.camera = camera;
    this.updateCamera();

    // 环境光照：让所有 PBR 材质都有反射内容
    var pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    var envRT = pmrem.fromEquirectangular(makeEnvTexture());
    scene.environment = envRT.texture;
    pmrem.dispose();

    // 主光：暖白，负责方向感与投影
    var dir = new THREE.DirectionalLight(0xfff2df, 0.75);
    dir.position.set(4.2, 9.5, 5.0);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    var sc = dir.shadow.camera;
    sc.left = -5;
    sc.right = 5;
    sc.top = 5;
    sc.bottom = -5;
    sc.near = 1;
    sc.far = 24;
    dir.shadow.bias = -0.0006;
    dir.shadow.normalBias = 0.02;
    dir.shadow.radius = 2;
    scene.add(dir);
    this.sun = dir;

    // 冷色轮廓光：从背面压一道边，增加体积感
    var rim = new THREE.DirectionalLight(0xdce7ff, 0.22);
    rim.position.set(-5.5, 4.0, -5.0);
    scene.add(rim);

    // 极低的环境补光，避免阴影死黑
    var hemi = new THREE.HemisphereLight(0xfff6e8, 0xbfae95, 0.12);
    scene.add(hemi);

    scene.fog = new THREE.Fog(0xf2e9d9, 14, 30);
    scene.background = new THREE.Color(0xf2e9d9);

    this.initBackdrop();
  };

  // 背景板：浅景深果摊照片，billboard 贴在远处，由雾自然淡化，不抢主体
  Renderer3D.prototype.initBackdrop = function () {
    if (typeof BG_TEXTURE === "undefined" || !BG_TEXTURE) return;

    var self = this;
    var tex = new THREE.TextureLoader().load(BG_TEXTURE, function () {
      self.fitBackdrop();
    });
    tex.encoding = THREE.sRGBEncoding;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;

    var mat = new THREE.MeshBasicMaterial({
      map: tex,
      color: 0xffffff,
      transparent: true,
      opacity: this.bgOpacity,
      fog: false,
      depthWrite: false
    });

    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.renderOrder = -1;
    this.backdrop = mesh;
    this.backdropTex = tex;
    this.scene.add(mesh);
    this.fitBackdrop();
  };

  // 按当前取景范围把背景板铺满，且保持图片比例不变形
  Renderer3D.prototype.fitBackdrop = function () {
    if (!this.backdrop || !this.camera) return;

    var cam = this.camera;
    var dist = 26;

    var viewH, viewW;
    if (cam.isOrthographicCamera) {
      viewH = cam.top - cam.bottom;
      viewW = cam.right - cam.left;
    } else {
      var fov = cam.fov * Math.PI / 180;
      viewH = 2 * dist * Math.tan(fov / 2);
      viewW = viewH * (this.W / this.H);
    }

    var img = this.backdropTex && this.backdropTex.image;
    var imgAspect = (img && img.width && img.height) ? (img.width / img.height) : (16 / 9);

    var h = Math.max(viewH, viewW / imgAspect) * 1.14;
    var w = h * imgAspect;

    this.backdrop.scale.set(w, h, 1);

    var dir = new THREE.Vector3(0, 0, 0);
    cam.getWorldDirection(dir);
    this.backdrop.position.copy(cam.position).add(dir.multiplyScalar(dist));
    this.backdrop.quaternion.copy(cam.quaternion);
  };

  Renderer3D.prototype.initBoard = function () {
    // 棋盘整块去掉：不再有木板和格底，水果直接悬在柔光背景里
    return;
  };

  Renderer3D.prototype.initBoardLegacy = function () {
    var self = this;
    var wood = makeWoodTexture();
    var rough = makeRoughnessTexture();
    wood.repeat.set(0.85, 0.85);
    rough.repeat.set(0.6, 0.6);

    // 桌面：圆角倒角木纹板
    var boardMat = solidMaterial({
      map: wood,
      bumpMap: wood,
      bumpScale: 0.02,
      roughnessMap: rough,
      roughness: 0.55,
      metalness: 0.02,
      envMapIntensity: 0.35
    });

    var board = new THREE.Mesh(roundedSlab(BOARD_W, BOARD_W, 0.24, 0.16, 0.05), boardMat);
    board.position.y = BOARD_TOP - 0.12;
    board.receiveShadow = true;
    board.castShadow = true;
    this.scene.add(board);

    // 内嵌格底：磨砂浅色，微凹
    var cellGeo = roundedSlab(0.86, 0.86, 0.05, 0.06, 0.01);
    var cellMat = solidMaterial({
      color: 0xd9c6a8,
      roughness: 0.88,
      metalness: 0.0,
      envMapIntensity: 0.18
    });
    var cellPos = solidMaterial({
      color: 0xc4ad8d,
      roughness: 0.9,
      metalness: 0.0,
      envMapIntensity: 0.14
    });

    for (var x = 0; x < 4; x++) {
      for (var y = 0; y < 4; y++) {
        var cell = new THREE.Mesh(cellGeo, cellMat);
        cell.position.set(self.wx(x), CELL_TOP - 0.026, self.wz(y));
        cell.receiveShadow = true;
        this.scene.add(cell);

        // 格底里的一圈细边，制造"凹槽"错觉
        var ring = new THREE.Mesh(roundedSlab(0.94, 0.94, 0.012, 0.07, 0.004), cellPos);
        ring.position.set(self.wx(x), CELL_TOP - 0.052, self.wz(y));
        ring.receiveShadow = true;
        this.scene.add(ring);
      }
    }
  };

  // 格心坐标：棋盘居中，边长可变（4/5/6），4×4 时 half=1.5 与原版完全一致
  Renderer3D.prototype.wx = function (gx) { return (gx - (this.gridSize - 1) / 2) * CELL; };
  Renderer3D.prototype.wz = function (gy) { return (gy - (this.gridSize - 1) / 2) * CELL; };

  // 切换棋盘尺寸：更新边长、重建取景范围，并清掉旧盘面节点
  Renderer3D.prototype.setGridSize = function (size) {
    var n = parseInt(size, 10);
    if (!(n >= 4 && n <= 6) || n === this.gridSize) return;
    var self = this;
    this.gridSize = n;
    if (this.nodes && typeof this.nodes.forEach === "function") {
      this.nodes.forEach(function (node) {
        try { self.dropHalo(node); } catch (e) {}
        if (node.group && node.group.parent) node.group.parent.remove(node.group);
      });
      this.nodes.clear();
    }
    this.updateCamera();
  };

  // 素材四周是透明留白。球面 UV 会取到这些留白，果子就被切出缺口。
  // 这里把透明区用最接近的果皮色外扩填满，让整张贴图都有颜色可采。
  function bakeBleedCanvas(img) {
    if (!img || !img.width || !img.height) return null;

    var w = img.width;
    var h = img.height;
    var cv = newCanvas(w, h);
    var ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);

    var pixels;
    try {
      pixels = ctx.getImageData(0, 0, w, h);
    } catch (e) {
      return null;
    }

    var d = pixels.data;
    var total = w * h;
    var dist = new Float32Array(total);
    var known = new Uint8Array(total);
    var i;

    for (i = 0; i < total; i++) {
      if (d[i * 4 + 3] > 84) {
        known[i] = 1;
        dist[i] = 0;
      } else {
        dist[i] = 1e6;
      }
    }

    // 两遍扫描做最近邻外扩：先左上到右下，再右下到左上
    var x, y, idx, nx, ny, nidx, cand, k;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        idx = y * w + x;
        if (known[idx]) continue;
        for (k = 0; k < 4; k++) {
          nx = x + (k === 0 ? -1 : k === 1 ? 0 : k === 2 ? -1 : 1);
          ny = y + (k === 0 ? 0 : k === 1 ? -1 : k === 2 ? -1 : -1);
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          nidx = ny * w + nx;
          if (dist[nidx] > 9e5) continue;
          cand = dist[nidx] + 1;
          if (cand < dist[idx]) {
            dist[idx] = cand;
            d[idx * 4] = d[nidx * 4];
            d[idx * 4 + 1] = d[nidx * 4 + 1];
            d[idx * 4 + 2] = d[nidx * 4 + 2];
          }
        }
      }
    }

    for (y = h - 1; y >= 0; y--) {
      for (x = w - 1; x >= 0; x--) {
        idx = y * w + x;
        if (known[idx]) continue;
        for (k = 0; k < 4; k++) {
          nx = x + (k === 0 ? 1 : k === 1 ? 0 : k === 2 ? 1 : -1);
          ny = y + (k === 0 ? 0 : k === 1 ? 1 : k === 2 ? 1 : 1);
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          nidx = ny * w + nx;
          if (dist[nidx] > 9e5) continue;
          cand = dist[nidx] + 1;
          if (cand < dist[idx]) {
            dist[idx] = cand;
            d[idx * 4] = d[nidx * 4];
            d[idx * 4 + 1] = d[nidx * 4 + 1];
            d[idx * 4 + 2] = d[nidx * 4 + 2];
          }
        }
      }
    }

    // 底面轮廓以外不要留下透明：整张图都填实
    for (i = 0; i < total; i++) {
      if (dist[i] <= 9e5) d[i * 4 + 3] = 255;
    }

    ctx.putImageData(pixels, 0, 0);
    return cv;
  }

  // 轮廓的径向半径表：每个方向上果实真正的边界有多远。
  // 球面按它收缩，整颗球就只采轮廓以内的果皮色，不会把外面的填充色糊成一圈。
  function contourRadiusLUT(info) {
    if (!info || !info.pts || !info.pts.length) return null;

    var N = 36;
    var lut = new Float32Array(N);
    var pts = info.pts;
    var i, dx, dy, rho, ang, bin;

    for (i = 0; i < pts.length; i++) {
      dx = pts[i][0] - 0.5;
      dy = pts[i][1] - 0.5;
      rho = Math.sqrt(dx * dx * 4 + dy * dy * 4);
      ang = Math.atan2(dy, dx);
      bin = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * N);
      if (bin < 0) bin = 0;
      if (bin >= N) bin = N - 1;
      if (rho > lut[bin]) lut[bin] = rho;
    }

    // 空出来的角度用左右邻居补，避免某些方向突然塌到 0
    for (i = 0; i < N; i++) {
      if (lut[i] > 0) continue;
      var lo = 1, hi = 1, j;
      for (j = 1; j < N; j++) {
        lo = (i - j + N) % N;
        hi = (i + j) % N;
        if (lut[lo] > 0 || lut[hi] > 0) {
          lut[i] = Math.max(lut[lo], lut[hi]);
          break;
        }
      }
    }

    return lut;
  }

  Renderer3D.prototype.loadTextures = function () {
    var self = this;
    this.textures = {};
    this.texReadyCount = 0;
    this.shadowTex = makeContactShadowTexture();
    this.glowTex = makeGlowTexture();
    this.sparkTex = makeSparkTexture();
    this.ringTex = makeRingTexture();

    // 果皮用的程序纹理（bump / 条纹 / 籽）
    this.berryBump = granularBump(128, 240, 1.6, 110, 180);
    this.citrusBump = granularBump(160, 380, 1.3, 96, 190);
    this.fuzzBump = granularBump(128, 500, 0.9, 104, 168);
    this.cocoBump = granularBump(128, 300, 2.2, 88, 176);
    this.melonNet = netBump(160, 9);
    this.pineBump = netBump(160, 7);
    this.seedTex = seedBump(160, 10, 12);
    this.wmStripe = stripeMap(256, "#dcb04a", "#a87a26", 9);

    if (typeof FRUIT_TEXTURES === "undefined") return;

    var keys = Object.keys(FRUIT_TEXTURES);
    var total = keys.length;

    // 手动解码成 Image，再合成"带品质光晕"的画布；纹理本身就是最终图，UV 无需二次更换
    keys.forEach(function (key) {
      var img = new Image();
      img.onload = function () {
        var cv = self.bakeFruitGlow(img, key);
        var tex = new THREE.CanvasTexture(cv);
        tex.encoding = THREE.sRGBEncoding;
        tex.anisotropy = Math.min(8, self.renderer.capabilities.getMaxAnisotropy());
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        self.textures[key] = tex;
        self.texReadyCount++;
        if (self.texReadyCount >= total) self.refreshIfFallback();
      };
      img.src = FRUIT_TEXTURES[key];
    });
  };

  // 贴图没好时水果会退化成数字方块，等全部就绪后按当前棋盘重建一次
  Renderer3D.prototype.refreshIfFallback = function () {
    if (!this.nodes || this.nodes.size === 0) return;
    var self = this;
    var need = false;
    this.nodes.forEach(function (node) {
      if (node.group.userData.fallback) need = true;
    });
    if (!need) return;
    this.nodes.forEach(function (node) {
      self.scene.remove(node.group);
      self.dropHalo(node);
    });
    this.nodes.clear();
    if (this.lastGrid) this.syncNodes(this.lastGrid);
  };

  /* ================= 方块 ================= */

  Renderer3D.prototype.makeNumberTexture = function (value) {
    var size = 256;
    var cv = newCanvas(size, size);
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "#3a2f28";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#fff6e6";
    ctx.font = "bold 84px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(value), size / 2, size / 2);
    var tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  };

  /* ================= 程序化水果：用几何搭出立体果形 ================= */

  function mergeOpts(base, extra) {
    var out = {};
    var k;
    for (k in base) out[k] = base[k];
    if (extra) for (k in extra) out[k] = extra[k];
    return out;
  }

  // 压一压饱和度、提一点明度：真水果不是塑料，饱和度一高就成玩具了
  function desaturate(hex, satK, lumK) {
    var c = new THREE.Color(hex);
    var hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    c.setHSL(hsl.h, Math.max(0, hsl.s * satK), Math.min(1, hsl.l * lumK));
    return c.getHex();
  }

  // 底部压暗当环境遮蔽：果体贴地那圈不该跟顶面一样亮
  function shadeBottom(geo, dark) {
    if (geo.userData.shaded) return geo;
    geo.computeBoundingBox();
    var minY = geo.boundingBox.min.y;
    var maxY = geo.boundingBox.max.y;
    var span = Math.max(0.001, maxY - minY);

    var pos = geo.attributes.position;
    var colors = new Float32Array(pos.count * 3);

    for (var i = 0; i < pos.count; i++) {
      var t = (pos.getY(i) - minY) / span;
      t = Math.max(0, Math.min(1, t));
      var k = dark + (1 - dark) * Math.pow(t, 0.55);
      colors[i * 3] = k;
      colors[i * 3 + 1] = k;
      colors[i * 3 + 2] = k;
    }

    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.userData.shaded = true;
    return geo;
  }

  // 统一表皮材质：半哑光 + 一层清漆高光，接近真果皮的反光
  function fruitSkin(color, extra) {
    return physicalMaterial(mergeOpts({
      color: desaturate(color, 0.82, 0.96),
      roughness: 0.74,
      metalness: 0.0,
      clearcoat: 0.18,
      clearcoatRoughness: 0.5,
      envMapIntensity: 0.34,
      vertexColors: true
    }, extra));
  }

  // 球体：可带顶点变形，底部统一落到 y = 0，方便贴着格面摆
  function groundSphere(r, wSeg, hSeg, deform) {
    var geo = new THREE.SphereGeometry(r, wSeg || 24, hSeg || 16);
    if (deform) deform(geo);
    geo.computeBoundingBox();
    geo.translate(0, -geo.boundingBox.min.y, 0);
    geo.computeVertexNormals();
    return geo;
  }

  // 灰阶噪点贴图：当 bumpMap 用，果皮就有细微起伏
  function granularBump(size, count, radius, from, to) {
    var cv = newCanvas(size, size);
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, size, size);

    for (var i = 0; i < count; i++) {
      var g = Math.round(from + Math.random() * (to - from));
      ctx.fillStyle = "rgb(" + g + "," + g + "," + g + ")";
      ctx.beginPath();
      ctx.arc(Math.random() * size, Math.random() * size, radius * (0.6 + Math.random() * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }

    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  // 瓜类网纹 / 菠萝鳞片：交叉细线
  function netBump(size, cells) {
    var cv = newCanvas(size, size);
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, size, size);

    var step = size / cells;
    ctx.strokeStyle = "#cfcfcf";
    ctx.lineWidth = 3;

    for (var i = -cells; i <= cells * 2; i++) {
      ctx.beginPath();
      ctx.moveTo(i * step, 0);
      ctx.lineTo(i * step + size, size);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(i * step, size);
      ctx.lineTo(i * step + size, 0);
      ctx.stroke();
    }

    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  // 草莓籽：错行排布的凹坑
  function seedBump(size, rows, cols) {
    var cv = newCanvas(size, size);
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "#909090";
    ctx.fillRect(0, 0, size, size);

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var x = (c + 0.5 + (r % 2) * 0.5) * (size / cols);
        var y = (r + 0.5) * (size / rows);
        ctx.fillStyle = "#3a3a3a";
        ctx.beginPath();
        ctx.ellipse(x, y, 3.2, 4.8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  // 西瓜条纹：竖向的深色带
  function stripeMap(size, baseColor, stripeColor, count) {
    var cv = newCanvas(size, size);
    var ctx = cv.getContext("2d");
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = stripeColor;
    var w = size / count;
    for (var i = 0; i < count; i++) {
      var x = i * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.quadraticCurveTo(x + w * 0.9, size / 2, x, size);
      ctx.lineTo(x + w * 0.42, size);
      ctx.quadraticCurveTo(x + w * 0.55, size / 2, x + w * 0.42, 0);
      ctx.closePath();
      ctx.fill();
    }

    var tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  // 叶片：两条贝塞尔围出的叶形，挤出一点厚度
  function makeLeaf(w, h, color, tilt, sway) {
    var shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.bezierCurveTo(w * 0.62, h * 0.3, w * 0.5, h * 0.86, 0, h);
    shape.bezierCurveTo(-w * 0.5, h * 0.86, -w * 0.62, h * 0.3, 0, 0);

    var geo = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false, curveSegments: 10 });
    var mat = solidMaterial({
      color: color,
      roughness: 0.66,
      metalness: 0.0,
      envMapIntensity: 0.3,
      side: THREE.DoubleSide
    });

    var mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = tilt || 0;
    mesh.rotation.y = sway || 0;
    mesh.castShadow = true;
    return mesh;
  }

  // 逐级构造立体水果；返回值仍是一个 Group，上层动画与拾取逻辑不用改
  Renderer3D.prototype.makeFruitGroup = function (value) {
    var group = new THREE.Group();
    var shell = null;

    function add(mesh) {
      shadeBottom(mesh.geometry, 0.55);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      if (!shell) shell = mesh;
      return mesh;
    }

    if (value === 2) {
      // 蓝莓：三颗并排小球，哑光带果霜
      var berryGeo = groundSphere(0.155, 20, 14);
      var berrySkin = fruitSkin(0x35407a, {
        roughness: 0.84,
        clearcoat: 0.12,
        bumpMap: this.berryBump,
        bumpScale: 0.02
      });
      var berrySpots = [[-0.15, 0, 0.06], [0.16, 0.02, 0.1], [0.0, 0, -0.16]];
      for (var b = 0; b < berrySpots.length; b++) {
        var berry = new THREE.Mesh(berryGeo, berrySkin);
        berry.position.set(berrySpots[b][0], berrySpots[b][1], berrySpots[b][2]);
        berry.rotation.y = b * 1.1;
        add(berry);
      }
      var calyxMat = solidMaterial({ color: 0x2b3358, roughness: 0.88 });
      for (var c = 0; c < 3; c++) {
        var calyx = new THREE.Mesh(new THREE.ConeGeometry(0.062, 0.05, 5), calyxMat);
        calyx.position.set(berrySpots[c][0], berrySpots[c][1] + 0.325, berrySpots[c][2]);
        group.add(calyx);
      }
    } else if (value === 4) {
      // 青提：八颗小球堆成倒锥，高光更亮
      var grapeGeo = groundSphere(0.118, 18, 12);
      var grapeSkin = fruitSkin(0xa9cf62, {
        roughness: 0.52,
        clearcoat: 0.32,
        clearcoatRoughness: 0.34,
        envMapIntensity: 0.45
      });
      var grapeLayout = [
        [-0.2, 0.0, 0.03], [0.02, -0.01, 0.0], [0.21, 0.02, 0.04],
        [-0.12, 0.14, 0.16], [0.13, 0.15, 0.15],
        [-0.1, 0.15, -0.14], [0.11, 0.17, -0.13],
        [-0.02, 0.29, 0.03],
        [0.0, 0.41, 0.0]
      ];
      for (var g = 0; g < grapeLayout.length; g++) {
        var gMesh = new THREE.Mesh(grapeGeo, grapeSkin);
        gMesh.position.set(grapeLayout[g][0], grapeLayout[g][1], grapeLayout[g][2]);
        add(gMesh);
      }
      var grapeStem = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.024, 0.1, 8),
        solidMaterial({ color: 0x6f7a3a, roughness: 0.85 }));
      grapeStem.position.set(0, 0.53, 0.02);
      group.add(grapeStem);
    } else if (value === 8) {
      // 橙子：一颗球，橙皮凹凸 + 果柄两片叶
      var orangeGeo = groundSphere(0.31, 30, 22);
      var orangeSkin = fruitSkin(0xe8822a, {
        roughness: 0.82,
        clearcoat: 0.2,
        clearcoatRoughness: 0.42,
        bumpMap: this.citrusBump,
        bumpScale: 0.03
      });
      add(new THREE.Mesh(orangeGeo, orangeSkin));

      var orangeStemMat = solidMaterial({ color: 0x7c8c4a, roughness: 0.82 });
      var orangeStem = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.09, 8), orangeStemMat);
      orangeStem.position.set(0, 0.6, 0);
      group.add(orangeStem);

      var leafA = makeLeaf(0.16, 0.24, 0x6e9a3e, -0.35, 0.5);
      leafA.position.set(0.03, 0.61, 0.02);
      group.add(leafA);

      var leafB = makeLeaf(0.13, 0.2, 0x76a344, -0.42, -1.1);
      leafB.position.set(-0.03, 0.6, -0.02);
      group.add(leafB);
    } else if (value === 16) {
      // 桃子：球顶压出一道凹，粉皮带绒毛
      var peachGeo = groundSphere(0.3, 30, 22, function (geo) {
        var pos = geo.attributes.position;
        for (var i = 0; i < pos.count; i++) {
          var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          if (y <= 0.02) continue;
          var d2 = x * x + z * z;
          pos.setY(i, y - 0.085 * Math.exp(-d2 / 0.02));
        }
      });
      peachGeo.scale(1.06, 0.98, 1.02);

      var peachSkin = fruitSkin(0xef9aa6, {
        roughness: 0.78,
        clearcoat: 0.16,
        clearcoatRoughness: 0.5,
        bumpMap: this.fuzzBump,
        bumpScale: 0.02
      });
      add(new THREE.Mesh(peachGeo, peachSkin));

      var peachLeaf = makeLeaf(0.15, 0.22, 0x6f9c44, -0.5, 0.2);
      peachLeaf.position.set(0.02, 0.5, 0.05);
      group.add(peachLeaf);
    } else if (value === 32) {
      // 菠萝：旋转体纺锤身 + 顶部五片尖叶
      var pinePts = [new THREE.Vector2(0, 0)];
      var pineSteps = 14;
      for (var s = 1; s <= pineSteps; s++) {
        var t = s / pineSteps;
        var rr = 0.245 * Math.sin(Math.PI * (0.06 + t * 0.86));
        pinePts.push(new THREE.Vector2(Math.max(0.004, rr), t * 0.52));
      }
      var pineGeo = new THREE.LatheGeometry(pinePts, 26);
      pineGeo.computeVertexNormals();

      var pineSkin = fruitSkin(0xd9a13a, {
        roughness: 0.82,
        clearcoat: 0.12,
        bumpMap: this.pineBump,
        bumpScale: 0.05
      });
      add(new THREE.Mesh(pineGeo, pineSkin));

      var crownMat = solidMaterial({ color: 0x5f8f3c, roughness: 0.72, side: THREE.DoubleSide });
      for (var k = 0; k < 5; k++) {
        var ang = (Math.PI * 2 * k) / 5;
        var crown = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.3, 6), crownMat);
        crown.position.set(Math.cos(ang) * 0.07, 0.61, Math.sin(ang) * 0.07);
        crown.rotation.z = -Math.cos(ang) * 0.35;
        crown.rotation.x = Math.sin(ang) * 0.35;
        crown.castShadow = true;
        group.add(crown);
      }
    } else if (value === 64) {
      // 椰子：表面噪扰出毛糙，顶上三个孔
      var cocoGeo = groundSphere(0.28, 26, 18, function (geo) {
        var pos = geo.attributes.position;
        for (var i = 0; i < pos.count; i++) {
          var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          var wob = Math.sin(x * 24) * Math.cos(z * 21) + Math.sin(y * 19) * 0.7;
          var k2 = 1 + wob * 0.028;
          pos.setXYZ(i, x * k2, y * k2, z * k2);
        }
      });

      var cocoSkin = fruitSkin(0x6f4a32, {
        roughness: 0.95,
        clearcoat: 0.05,
        clearcoatRoughness: 0.9,
        bumpMap: this.cocoBump,
        bumpScale: 0.06
      });
      add(new THREE.Mesh(cocoGeo, cocoSkin));

      var holeMat = solidMaterial({ color: 0x1a0f08, roughness: 0.95 });
      var holeGeo = new THREE.SphereGeometry(0.046, 12, 10);
      for (var h2 = 0; h2 < 3; h2++) {
        var hAng = (Math.PI * 2 * h2) / 3;
        var hole = new THREE.Mesh(holeGeo, holeMat);
        // 贴着球面摆：球心 y=0.28、半径 0.28，抬到 y=0.475 时水平半径约 0.19
        hole.position.set(Math.cos(hAng) * 0.185, 0.475, Math.sin(hAng) * 0.185);
        group.add(hole);
      }
    } else if (value === 128) {
      // 哈密瓜：横放的椭圆，表面网纹
      var melonGeo = groundSphere(0.29, 28, 20);
      melonGeo.scale(1.12, 0.92, 1.12);

      var melonSkin = fruitSkin(0xcad98f, {
        roughness: 0.88,
        clearcoat: 0.1,
        bumpMap: this.melonNet,
        bumpScale: 0.022
      });
      add(new THREE.Mesh(melonGeo, melonSkin));
    } else if (value === 256) {
      // 金果：小而扁，绒毛质感最强
      var goldGeo = groundSphere(0.27, 26, 18);
      goldGeo.scale(1.06, 0.9, 1.0);

      var goldSkin = fruitSkin(0xa8803f, {
        roughness: 0.96,
        clearcoat: 0.04,
        bumpMap: this.fuzzBump,
        bumpScale: 0.05
      });
      add(new THREE.Mesh(goldGeo, goldSkin));
    } else if (value === 512) {
      // 草莓：底尖、中下部最饱满、到顶收成小肩的果形
      var strawProfile = [0.002, 0.08, 0.15, 0.21, 0.25, 0.272, 0.275, 0.255, 0.215, 0.145, 0.05];
      var strawPts = [];
      for (var q = 0; q < strawProfile.length; q++) {
        var tq = q / (strawProfile.length - 1);
        strawPts.push(new THREE.Vector2(strawProfile[q], tq * 0.52));
      }

      var strawGeo = new THREE.LatheGeometry(strawPts, 28);
      strawGeo.computeVertexNormals();

      var strawSkin = fruitSkin(0xcf2c3a, {
        roughness: 0.6,
        clearcoat: 0.26,
        clearcoatRoughness: 0.38,
        bumpMap: this.seedTex,
        bumpScale: 0.06
      });
      add(new THREE.Mesh(strawGeo, strawSkin));

      // 顶部一圈叶，把果顶的小口遮住
      for (var s5 = 0; s5 < 7; s5++) {
        var sAng = (Math.PI * 2 * s5) / 7;
        var sLeaf = makeLeaf(0.13, 0.17, 0x5f9a38, -1.15, sAng);
        sLeaf.position.set(Math.cos(sAng) * 0.05, 0.48, Math.sin(sAng) * 0.05);
        group.add(sLeaf);
      }
    } else if (value === 1024) {
      // 火龙果：玫红椭圆 + 贴身的几片小鳞
      var dragonGeo = groundSphere(0.3, 26, 20);
      dragonGeo.scale(1.0, 1.04, 1.0);

      var dragonSkin = fruitSkin(0xd23a86, {
        roughness: 0.68,
        clearcoat: 0.24,
        clearcoatRoughness: 0.4,
        bumpMap: this.pineBump,
        bumpScale: 0.014
      });
      add(new THREE.Mesh(dragonGeo, dragonSkin));

      // 鳞片：交错两圈，贴着果身往外翘
      for (var d5 = 0; d5 < 10; d5++) {
        var dAng = (Math.PI * 2 * d5) / 10 + 0.35;
        var dY = (d5 % 2 === 0) ? 0.18 : 0.33;
        var dLeaf = makeLeaf(0.15, 0.19, 0x9dc962, -1.3, dAng);
        dLeaf.position.set(Math.cos(dAng) * 0.25, dY, Math.sin(dAng) * 0.25);
        group.add(dLeaf);
      }
    } else if (value === 2048) {
      // 金西瓜：大概最圆的球，金条纹 + 顶部卷须
      var wmGeo = groundSphere(0.32, 32, 24);
      wmGeo.scale(1.0, 0.96, 0.98);

      var wmMat = physicalMaterial({
        map: this.wmStripe,
        roughness: 0.62,
        metalness: 0.0,
        clearcoat: 0.3,
        clearcoatRoughness: 0.36,
        envMapIntensity: 0.45,
        vertexColors: true
      });
      add(new THREE.Mesh(wmGeo, wmMat));

      var curl = new THREE.Mesh(
        new THREE.TorusGeometry(0.055, 0.014, 8, 18, Math.PI * 1.35),
        solidMaterial({ color: 0x7a5a2e, roughness: 0.82 })
      );
      curl.position.set(0.02, 0.6, 0.02);
      curl.rotation.x = Math.PI / 2;
      group.add(curl);
    } else {
      // 兜底：不认识的等级也给一颗球，别空着
      add(new THREE.Mesh(groundSphere(0.28, 20, 16), fruitSkin(TINTS[value] || 0x8a7f70)));
    }

    // 接触阴影：贴在格面上，随水果一起缩放
    var shMat = new THREE.MeshBasicMaterial({
      map: this.shadowTex,
      transparent: true,
      opacity: 0.82,
      depthWrite: false
    });
    var shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.92), shMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.003;
    group.add(shadow);

    group.userData.base = shell;

    // 越高级的果子越大一点，盘面才有层次，不至于 11 个一样大
    var rank = Math.round(Math.log2(Math.max(2, value)));
    var baseScale = 0.78 + ((rank - 1) / 10) * 0.42;
    group.scale.setScalar(baseScale);
    group.userData.baseScale = baseScale;

    return group;
  };

  /* ================= 果体版：真实轮廓挤出 + 鼓面果皮 =================
     上面那套纯几何作为备用，同名的这个定义生效。
     果体轮廓和正面贴图来自同一张素材，所以剪影是吻合的。 */

  Renderer3D.prototype.makeFruitShape = function (value) {
    if (!this.shapeCache) this.shapeCache = {};

    var key = String(value);
    if (this.shapeCache[key]) return this.shapeCache[key];

    var info = (typeof FRUIT_SHAPES !== "undefined") ? FRUIT_SHAPES[key] : null;
    var shape = new THREE.Shape();
    var pts = (info && info.pts) ? info.pts : null;

    if (pts && pts.length > 6) {
      for (var i = 0; i < pts.length; i++) {
        // 这里只做 0..1 -> ±0.5 的单位化，真实宽高由 bodyGeo.scale(W, H) 统一乘
        var px = pts[i][0] - 0.5;
        var py = pts[i][1] - 0.5;
        if (i === 0) shape.moveTo(px, py);
        else shape.lineTo(px, py);
      }
    } else {
      for (var a = 0; a < 32; a++) {
        var ang = (a / 32) * Math.PI * 2;
        var cx = Math.cos(ang) * 0.5;
        var cy = Math.sin(ang) * 0.5;
        if (a === 0) shape.moveTo(cx, cy);
        else shape.lineTo(cx, cy);
      }
    }

    var out = {
      shape: shape,
      h: info ? info.h / info.w : 1.0,
      info: info
    };
    this.shapeCache[key] = out;
    return out;
  };

  // 高度场 base64 -> 0..1 浮点数组，同步解码，不依赖图片加载
  function decodeHeight(info) {
    if (!info || !info.hmap || typeof atob !== "function") return null;
    try {
      var raw = atob(info.hmap);
      var size = info.hsize || 32;
      var arr = new Float32Array(raw.length);
      for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i) / 255.0;
      return arr.length >= size * size ? { data: arr, size: size } : null;
    } catch (e) {
      return null;
    }
  }

  // 平面贴图水果：不再做几何建模，素材本身的光影就够用了。
  // 摆法回到二维：正对相机，只跟着格位移动，保留出生缩放和合并弹起。
  Renderer3D.prototype.makeFruitGroup = function (value) {
    var group = new THREE.Group();
    var data = this.makeFruitShape(value);

    var rank = Math.round(Math.log2(Math.max(2, value)));
    var H = 0.60 + ((rank - 1) / 10) * 0.08;       // 高度 0.60 ~ 0.68，上下留出透气的空隙
    var ratio = data.h || 1;                       // 素材的高/宽
    var W = H / ratio;

    // 逐个级别的观感微调：素材的 bbox 宽高比差别很大，等比放会造成
    // 宽素材（蓝莓、金果）显得过大、窄素材（菠萝）显得过小
    var SIZE_TWEAK = { 2: 0.78, 32: 1.12 };        // 整体缩放
    var WIDE_TWEAK = { 32: 1.42 };                 // 额外横向拉伸，让细长的菠萝敦实些
    var st = SIZE_TWEAK[value] || 1;
    var wt = WIDE_TWEAK[value] || 1;
    H *= st;
    W *= st * wt;
    if (W > 0.96) {
      W = 0.96;
      H = W * ratio / wt;
    }
    if (window.__DIAG) window.__DIAG(value, H, W, ratio, st, wt);

    var tex = this.textures[value];
    var fallback = false;
    if (!tex) {
      tex = this.makeNumberTexture(value);
      fallback = true;
    }

    // 贴图外面留了一圈透明边用来放光晕，平面要等比放大，UV 只取本体区域
    var K = this.fruitTexScale || 1;
    var geo = new THREE.PlaneGeometry(W * K, H * K);
    var uv = geo.attributes.uv;
    var i0 = (data.info && typeof data.info.u0 === "number") ? data.info.u0 : 0;
    var i1 = (data.info && typeof data.info.u1 === "number") ? data.info.u1 : 1;
    var j0 = (data.info && typeof data.info.v0 === "number") ? data.info.v0 : 0;
    var j1 = (data.info && typeof data.info.v1 === "number") ? data.info.v1 : 1;

    var PAD = this.fruitTexPad || 0;
    var NS = this.fruitTexSize || 256;
    var SZ = 256;

    for (var ui = 0; ui < uv.count; ui++) {
      var uu = i0 + uv.getX(ui) * (i1 - i0);
      var vv = j0 + uv.getY(ui) * (j1 - j0);
      uv.setXY(ui, (PAD + uu * SZ) / NS, (PAD + vv * SZ) / NS);
    }
    uv.needsUpdate = true;

    var mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.12,
      side: THREE.DoubleSide
    });

    var body = new THREE.Mesh(geo, mat);
    body.position.y = H / 2;                       // 底边压在同一高度，排面才齐
    group.add(body);

    group.userData.base = body;
    group.userData.baseScale = 1;
    group.userData.billboard = body;
    group.userData.fallback = fallback;
    group.userData.H = H;
    group.userData.W = W;
    group.userData.value = value;
    return group;
  };

  // 贴图只放清晰水果本体（外圈留白给平面放大用），品质光晕交给上面的 DOM 光晕层
  Renderer3D.prototype.bakeFruitGlow = function (img, value) {
    var S = 256;
    var PAD = 44;
    var NS = S + PAD * 2;

    var src = document.createElement("canvas");
    src.width = S;
    src.height = S;
    src.getContext("2d").drawImage(img, 0, 0, S, S);

    var cv = document.createElement("canvas");
    cv.width = NS;
    cv.height = NS;
    cv.getContext("2d").drawImage(src, PAD, PAD, S, S);

    this.fruitTexPad = PAD;
    this.fruitTexSize = NS;
    this.fruitTexScale = NS / S;
    return cv;
  };

  /* ================= 同步与动画 ================= */

  Renderer3D.prototype.draw = function (grid, meta) {
    this.meta = meta;
    this.lastGrid = grid;
    this.gridSize = grid.size;
    this.moveCount = 0;      // 本次有多少颗换了位置（决定要不要播滑动声）
    this.spawnCount = 0;     // 本次新生成了几颗（落子声）
    this.syncNodes(grid);
    this.updateHud(meta);

    if (!this.looping) {
      this.looping = true;
      this.tick();
    }

    // 声音：滑动 / 落子 / 胜利 / 结束
    if (typeof Sfx !== "undefined" && Sfx) {
      if (this.moveCount > 0) Sfx.play("slide");
      if (this.spawnCount > 0) Sfx.play("spawn");

      if (meta && meta.won) {
        if (!this._wonCue) {
          this._wonCue = true;
          Sfx.play("win");
        }
      } else {
        this._wonCue = false;
      }

      if (meta && meta.over) {
        if (!this._overCue) {
          this._overCue = true;
          Sfx.play("lose");
        }
      } else {
        this._overCue = false;
      }
    }
  };

  Renderer3D.prototype.continueGame = function () {
    this.hideOverlay();
  };

  Renderer3D.prototype.syncNodes = function (grid) {
    var self = this;
    var now = performance.now();
    var live = new Set();

    grid.eachCell(function (gx, gy, tile) {
      if (!tile) return;
      live.add(tile);

      var node = self.nodes.get(tile);
      if (!node) {
        var group = self.makeFruitGroup(tile.value);
        group.position.set(self.wx(gx), CELL_TOP, self.wz(gy));
        group.scale.setScalar(group.userData.baseScale * 0.01);
        self.scene.add(group);

        node = {
          group: group,
          baseScale: group.userData.baseScale || 1,
          targetX: self.wx(gx),
          targetZ: self.wz(gy),
          born: now,
          popAt: tile.mergedFrom ? now + 90 : 0,
          halo: null
        };
        self.nodes.set(tile, node);

        // 品质光晕：一颗水果一个柔光圈
        if (self.haloLayer) {
          var halo = document.createElement("div");
          halo.style.cssText =
            "position:absolute;left:0;top:0;border-radius:50%;pointer-events:none;opacity:0;";
          self.paintHalo(halo, tile.value);
          self.haloLayer.appendChild(halo);
          node.halo = halo;
        }

        // 合成出 8 级及以上时，放合成特效
        if (tile.mergedFrom && tile.value >= 8) {
          self.spawnMergeFx(gx, gy, tile.value);
        }

        // 声音：新落子 / 合成
        if (typeof Sfx !== "undefined" && Sfx) {
          if (tile.mergedFrom) {
            var rankM = Math.round(Math.log(Math.max(2, tile.value)) / Math.log(2));
            if (tile.value >= 128) Sfx.play("mergeBig", { rank: rankM });
            else Sfx.play("merge", { rank: rankM });
          } else {
            self.spawnCount++;
          }
        }
      } else {
        var nx = self.wx(gx);
        var nz = self.wz(gy);
        if (Math.abs(node.targetX - nx) > 0.001 || Math.abs(node.targetZ - nz) > 0.001) {
          self.moveCount++;
        }
        node.targetX = nx;
        node.targetZ = nz;
      }
    });

    this.nodes.forEach(function (node, tile) {
      if (!live.has(tile)) {
        node.dieAt = now;
        self.dropHalo(node);
        self.dying.push(node);
        self.nodes.delete(tile);
      }
    });
  };

  /* ================= 合成特效 ================= */

  // 等级 -> 特效强度：8 级 0.5 起步，2048 级 1.4
  Renderer3D.prototype.fxStrength = function (value) {
    var lv = Math.log2(value);
    var t = Math.max(0, Math.min(1, (lv - 3) / 8));
    return 0.5 + t * 0.9;
  };

  // 合成特效：在画布上方的 DOM 层播放，浅色背景下也一定看得见，也更好控制质感
  Renderer3D.prototype.spawnMergeFx = function (gx, gy, value) {
    if (this.fxScale <= 0) return;
    if (!this.fxLayer) return;

    var strength = this.fxStrength(value) * this.fxScale;
    if (strength > 1.45) strength = 1.45;

    var v = new THREE.Vector3(this.wx(gx), 0.55, this.wz(gy)).project(this.camera);
    var cx = (v.x * 0.5 + 0.5) * this.W;
    var cy = (-v.y * 0.5 + 0.5) * this.H;

    var unit = this.W / 4.6;                       // 一格的屏幕尺寸
    var color = value >= 1024 ? "168,88,12" : (value >= 128 ? "158,100,20" : "176,118,38");
    var dur = 840 + strength * 300;

    var items = [];

    // 全部元素统一 left:0 top:0 + transform 定位（和品质光晕同一套写法，这个环境的合成层只认 transform）

    // 两到三圈扩散光环
    var rings = strength > 1.2 ? 3 : 2;
    var ringW = Math.max(8, unit * 0.045);
    for (var r = 0; r < rings; r++) {
      var ringSize = unit * (0.62 + r * 0.20) * (0.94 + strength * 0.16);
      var ring = document.createElement("div");
      ring.style.cssText = "position:absolute;left:0;top:0;" +
        "width:" + ringSize + "px;height:" + ringSize + "px;border-radius:50%;box-sizing:border-box;" +
        "border:" + (ringW - r * 1.1) + "px solid rgba(" + color + ",0.96);" +
        "box-shadow:0 0 0 2px rgba(255,252,240,0.70)," +
        "0 0 " + Math.round(unit * 0.16) + "px rgba(" + color + ",0.72)," +
        "0 0 " + Math.round(unit * 0.34) + "px rgba(" + color + ",0.38)," +
        "inset 0 0 " + Math.round(unit * 0.14) + "px rgba(255,248,230,0.80);";
      this.fxLayer.appendChild(ring);
      items.push({
        el: ring, delay: r * 120, dur: dur, s0: 0.30, s1: 1.02, o0: 0.95, o1: 0,
        ox: cx - ringSize / 2, oy: cy - ringSize / 2, size: ringSize
      });
    }

    // 中心柔光
    var glowSize = unit * (0.78 + strength * 0.30);
    var glow = document.createElement("div");
    glow.style.cssText = "position:absolute;left:0;top:0;" +
      "width:" + glowSize + "px;height:" + glowSize + "px;border-radius:50%;" +
      "background:radial-gradient(circle,rgba(255,252,242,0.99) 0%,rgba(255,241,208,0.9) 14%,rgba(" + color + ",0.78) 30%,rgba(" + color + ",0.34) 52%,rgba(" + color + ",0) 76%);";
    this.fxLayer.appendChild(glow);
    items.push({
      el: glow, delay: 0, dur: dur * 0.9, s0: 0.42, s1: 1.5, o0: 0.96, o1: 0,
      ox: cx - glowSize / 2, oy: cy - glowSize / 2, size: glowSize
    });

    // 中心实心光团
    var coreSize = unit * 0.46 * (0.85 + strength * 0.3);
    var core = document.createElement("div");
    core.style.cssText = "position:absolute;left:0;top:0;" +
      "width:" + coreSize + "px;height:" + coreSize + "px;border-radius:50%;" +
      "background:radial-gradient(circle,rgba(255,255,250,0.98) 0%,rgba(255,244,214,0.9) 18%,rgba(" + color + ",0.62) 46%,rgba(" + color + ",0) 76%);";
    this.fxLayer.appendChild(core);
    items.push({
      el: core, delay: 0, dur: dur * 0.62, s0: 0.16, s1: 1.22, o0: 0.95, o1: 0,
      ox: cx - coreSize / 2, oy: cy - coreSize / 2, size: coreSize
    });

    // 竖直光带：高等级才给
    if (strength >= 0.9) {
      var beamH = unit * (1.0 + strength * 0.32);
      var beam = document.createElement("div");
      beam.style.cssText = "position:absolute;left:0;top:0;" +
        "width:16px;height:" + beamH + "px;border-radius:8px;transform-origin:50% 100%;" +
        "background:linear-gradient(to top,rgba(255,250,236,0.96),rgba(" + color + ",0.62) 45%,rgba(" + color + ",0) 100%);" +
        "box-shadow:0 0 " + Math.round(unit * 0.09) + "px rgba(" + color + ",0.34);";
      this.fxLayer.appendChild(beam);
      items.push({
        el: beam, delay: 0, dur: dur * 0.9, mode: "beamY", s0: 0.25, s1: 1.15, o0: 0.75, o1: 0.75,
        ox: cx - 8, oy: cy, size: beamH
      });
    }

    // 星屑：向四周抛洒
    var sparks = Math.round(7 + strength * 9);
    for (var s = 0; s < sparks; s++) {
      var ang = (s / sparks) * Math.PI * 2 + Math.random() * 0.4;
      var dist = unit * (0.5 + Math.random() * 0.75) * (0.85 + strength * 0.25);
      var dsize = 7 + Math.random() * 7;
      var dot = document.createElement("div");
      dot.style.cssText = "position:absolute;left:0;top:0;" +
        "width:" + dsize + "px;height:" + dsize + "px;border-radius:50%;" +
        "background:radial-gradient(circle,rgba(255,252,240,1) 0%,rgba(" + color + ",0.9) 45%,rgba(" + color + ",0) 100%);";
      this.fxLayer.appendChild(dot);
      items.push({
        el: dot, delay: 0, dur: dur * (0.75 + Math.random() * 0.45), mode: "fly",
        ang: ang, dist: dist, rise: unit * 0.10, s0: 1, s1: 0.35, o0: 1, o1: 0,
        ox: cx - dsize / 2, oy: cy - dsize / 2, size: dsize
      });
    }

    if (!this.fxItems) this.fxItems = [];
    this.fxItems.push({
      items: items,
      startAt: performance.now(),
      until: performance.now() + dur * 1.9 + 320
    });
  };

  // 合成特效逐帧推进：直接改 style，不用 Web Animations，
  // 保证每个中间帧都是真实绘制出来的像素
  Renderer3D.prototype.fxStep = function (now) {
    if (!this.fxItems || !this.fxItems.length) return;
    for (var i = this.fxItems.length - 1; i >= 0; i--) {
      var g = this.fxItems[i];
      if (now > g.until) {
        for (var d = 0; d < g.items.length; d++) {
          var dead = g.items[d].el;
          if (dead.parentNode) dead.parentNode.removeChild(dead);
        }
        this.fxItems.splice(i, 1);
        continue;
      }
      for (var j = 0; j < g.items.length; j++) {
        var it = g.items[j];
        var p = (now - g.startAt - it.delay) / it.dur;
        if (p < 0) p = 0;
        if (p > 1) p = 1;
        var e = 1 - Math.pow(1 - p, 2.4);            // 先快后慢的扩散
        var s = it.s0 + (it.s1 - it.s0) * e;
        var o = it.o0 + (it.o1 - it.o0) * Math.pow(p, 1.30);

        // 用宽高变化代替 scale()：scale 会把元素推入 GPU 合成层，
        // 这一层的像素在截图里拿不到；宽高是布局级绘制，稳定可见
        if (it.mode === "fly") {
          var w = it.size * s, h = it.size * s;
          var rad = it.dist * e;
          var dx = Math.cos(it.ang) * rad;
          var dy = Math.sin(it.ang) * rad * 0.62 - it.rise * (1 - e);
          it.el.style.width = w.toFixed(1) + "px";
          it.el.style.height = h.toFixed(1) + "px";
          it.el.style.transform = "translate(" + (it.ox - (w - it.size) / 2 + dx).toFixed(1) + "px," +
            (it.oy - (h - it.size) / 2 + dy).toFixed(1) + "px)";
          it.el.style.opacity = (it.o0 * (1 - p)).toFixed(3);
        } else if (it.mode === "beamY") {
          var bh = it.size * s;
          it.el.style.height = bh.toFixed(1) + "px";
          it.el.style.transform = "translate(" + it.ox.toFixed(1) + "px," + (it.oy - bh).toFixed(1) + "px)";
          it.el.style.opacity = (Math.sin(p * Math.PI) * 0.86).toFixed(3);
        } else {
          var w2 = it.size * s, h2 = it.size * s;
          it.el.style.width = w2.toFixed(1) + "px";
          it.el.style.height = h2.toFixed(1) + "px";
          it.el.style.transform = "translate(" + (it.ox - (w2 - it.size) / 2).toFixed(1) + "px," +
            (it.oy - (h2 - it.size) / 2).toFixed(1) + "px)";
          it.el.style.opacity = Math.max(0, o).toFixed(3);
        }
      }
    }
  };

  Renderer3D.prototype.updateFx = function (now, dt) {
    for (var i = this.fxList.length - 1; i >= 0; i--) {
      var fx = this.fxList[i];
      var age = now - fx.start;

      for (var j = 0; j < fx.items.length; j++) {
        var it = fx.items[j];
        var mesh = it.mesh;
        var pt = (age - it.delay) / it.dur;

        if (pt < 0 || pt >= 1) {
          mesh.visible = false;
          continue;
        }
        mesh.visible = true;

        if (it.kind === "ring") {
          var s = 1.35 + pt * 2.2;
          mesh.scale.set(s, s, 1);
          mesh.material.opacity = Math.pow(1 - pt, 1.5) * 0.62;
        } else if (it.kind === "flash") {
          var fs = 0.2 + pt * 1.25;
          mesh.scale.set(fs, fs, 1);
          mesh.material.opacity = Math.pow(1 - pt, 1.6) * 0.72;
        } else if (it.kind === "beam") {
          mesh.material.opacity = Math.pow(1 - pt, 2) * 0.34;
          mesh.scale.y = 0.6 + pt * 1.6;
        }
      }

      if (fx.particles) {
        var p = fx.particles;
        var arr = p.positions;
        for (var k = 0; k < p.count; k++) {
          var vi = k * 3;
          p.vel[vi + 1] -= 1.8 * dt;
          arr[vi] += p.vel[vi] * dt;
          arr[vi + 1] += p.vel[vi + 1] * dt;
          arr[vi + 2] += p.vel[vi + 2] * dt;
          if (arr[vi + 1] < CELL_TOP + 0.01) arr[vi + 1] = CELL_TOP + 0.01;
        }
        p.points.geometry.attributes.position.needsUpdate = true;
        p.points.material.opacity = Math.max(0, 1 - age / fx.life) * 0.9;
      }

      if (age >= fx.life) {
        this.disposeFx(fx);
        this.fxList.splice(i, 1);
      }
    }
  };

  Renderer3D.prototype.disposeFx = function (fx) {
    for (var j = 0; j < fx.items.length; j++) {
      var mesh = fx.items[j].mesh;
      this.scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    }
    if (fx.particles) {
      this.scene.remove(fx.particles.points);
      fx.particles.points.geometry.dispose();
      fx.particles.points.material.dispose();
    }
  };

  Renderer3D.prototype.tick = function () {
    var self = this;
    var now = performance.now();
    var dt = this.lastTick ? Math.min(0.05, (now - this.lastTick) / 1000) : 0.016;
    this.lastTick = now;

    this.nodes.forEach(function (node) {
      node.group.position.x += (node.targetX - node.group.position.x) * 0.24;
      node.group.position.z += (node.targetZ - node.group.position.z) * 0.24;

      var bornT = (now - node.born) / 220;
      var scale = bornT >= 1 ? 1 : Math.max(0.01, easeOutBack(bornT));

      var lift = 0;
      if (node.popAt) {
        var p = (now - node.popAt) / 280;
        if (p >= 1) {
          node.popAt = 0;
        } else if (p > 0) {
          scale *= popCurve(p);
          lift = Math.sin(p * Math.PI) * 0.055;   // 合并时轻轻弹起
        }
      }

      node.group.position.y = CELL_TOP + lift;
      node.group.scale.setScalar(scale * (node.baseScale || 1));

      // 平面贴图永远正对相机，所以不会被俯角压扁，也不会出现"卡片被砍一截"
      var bill = node.group.userData.billboard;
      if (bill) bill.quaternion.copy(self.camera.quaternion);

      // 光晕跟着水果走
      self.placeHalo(node, scale);
    });

    for (var i = this.dying.length - 1; i >= 0; i--) {
      var d = this.dying[i];
      var k = (now - d.dieAt) / 180;
      if (k >= 1) {
        this.scene.remove(d.group);
        this.dying.splice(i, 1);
      } else {
        d.group.scale.setScalar(Math.max(0.01, 1 - k) * (d.baseScale || 1));
        d.group.position.y = 0.12 * k;
      }
    }

    // 合并后的余辉交给 DOM 特效层，这里不再补 3D 脉冲
    this.fxStep(now);

    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(function () { self.tick(); });
  };

  /* ================= HUD 与结算层 ================= */

  Renderer3D.prototype.cacheDom = function () {
    this.elScore = document.getElementById("hud-score");
    this.elBest = document.getElementById("hud-best");
    this.overlay = document.getElementById("overlay");
    this.ovTitle = document.getElementById("ov-title");
    this.ovScore = document.getElementById("ov-score");
    this.btnContinue = document.getElementById("btn-continue");

    this.btnUndo = document.getElementById("btn-undo");
    this.btnErase = document.getElementById("btn-erase");
    this.elPickHint = document.getElementById("pickhint");
    this.elBoardList = document.getElementById("board-list");
    this.elToast = document.getElementById("toast");
    this.elColGrid = document.getElementById("col-grid");
    this.elColCount = document.getElementById("col-count");

    this.overlayMode = "";
  };

  Renderer3D.prototype.bindDom = function () {
    var self = this;

    var bind = function (id, event) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("click", function (e) {
        e.preventDefault();
        self.inputManager.emit(event);
      });
    };

    // 对局动作
    bind("btn-new", "restart");
    bind("btn-restart", "restart");
    bind("btn-continue", "continueAfterWin");
    bind("btn-undo", "undo");

    // 覆盖层导航
    if (self.byId("btn-menu")) self.byId("btn-menu").addEventListener("click", function () { self.openMenu(); });
    if (self.byId("m-start")) self.byId("m-start").addEventListener("click", function () { self.inputManager.emit("startGame"); });
    if (self.byId("m-board")) self.byId("m-board").addEventListener("click", function () { self.inputManager.emit("requestLeaderboard"); });
    if (self.byId("m-collection")) self.byId("m-collection").addEventListener("click", function () { self.inputManager.emit("requestCollection"); });
    if (self.byId("m-settings")) self.byId("m-settings").addEventListener("click", function () { self.openSettings(); });
    if (self.byId("m-quit")) self.byId("m-quit").addEventListener("click", function () { self.openSheet("quit"); });
    if (self.byId("board-back")) self.byId("board-back").addEventListener("click", function () { self.openMenu(); });
    if (self.byId("collection-back")) self.byId("collection-back").addEventListener("click", function () { self.openMenu(); });
    if (self.byId("settings-back")) self.byId("settings-back").addEventListener("click", function () { self.openMenu(); });
    if (self.byId("quit-back")) self.byId("quit-back").addEventListener("click", function () { self.closeSheets(); });

    // 设置项：点了就立刻生效，下次渲染会回写选中态
    var SEG_MAP = {
      "seg-fx": "fx",
      "seg-bg": "bg",
      "seg-erase": "erase",
      "seg-sfx": "sfx",
      "seg-music": "music",
      "seg-mode": "size"
    };
    Object.keys(SEG_MAP).forEach(function (id) {
      var box = self.byId(id);
      if (!box) return;
      box.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest("button") : null;
        if (!btn || !box.contains(btn)) return;
        var value = btn.getAttribute("data-value");
        if (!value) return;

        var patch = {};
        if (id === "seg-erase") {
          patch.erase = parseInt(value, 10);
          if (isNaN(patch.erase)) return;
        } else if (id === "seg-mode") {
          patch.size = parseInt(value, 10);
          if (isNaN(patch.size)) return;
        } else if (id === "seg-sfx" || id === "seg-music") {
          patch[SEG_MAP[id]] = (value === "on");
        } else {
          patch[SEG_MAP[id]] = value;
        }
        self.inputManager.emit("settingsChanged", patch);
      });
    });

    // 音量滑杆：拖动实时生效，数值同步显示
    var VOL_MAP = [["vol-sfx", "sfxVol", "vol-sfx-val"], ["vol-music", "musicVol", "vol-music-val"]];
    VOL_MAP.forEach(function (item) {
      var slider = self.byId(item[0]);
      var label = self.byId(item[2]);
      if (!slider) return;
      slider.addEventListener("input", function () {
        var pct = parseInt(slider.value, 10);
        if (isNaN(pct)) pct = 0;
        if (label) label.textContent = String(pct);
        var patch = {};
        patch[item[1]] = pct / 100;
        self.inputManager.emit("settingsChanged", patch);
      });
    });

    // 存档导出：把全部本地数据落成一个 json 文件
    var btnExport = self.byId("save-export");
    if (btnExport) {
      btnExport.addEventListener("click", function () {
        var game = window.__game;
        if (!game || !game.storageManager) return;
        try {
          var data = game.storageManager.exportData();
          var text = JSON.stringify(data, null, 2);
          var blob = new Blob([text], { type: "application/json" });
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          var stamp = new Date();
          var pad = function (n) { return n < 10 ? "0" + n : String(n); };
          a.download = "2048-save-" + stamp.getFullYear() + pad(stamp.getMonth() + 1) +
            pad(stamp.getDate()) + "-" + pad(stamp.getHours()) + pad(stamp.getMinutes()) + ".json";
          a.href = url;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
          self.showToast("存档已导出");
          Sfx.play("ui");
        } catch (e) {
          self.showToast("导出失败：" + (e && e.message ? e.message : "未知错误"));
        }
      });
    }

    // 存档导入：读 json，合并恢复，随后重载让所有视图从存储重建
    var btnImport = self.byId("save-import");
    var fileInput = self.byId("save-file");
    if (btnImport && fileInput) {
      btnImport.addEventListener("click", function () {
        fileInput.value = "";
        fileInput.click();
      });
      fileInput.addEventListener("change", function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        var game = window.__game;
        if (!game || !game.storageManager) return;
        var reader = new FileReader();
        reader.onload = function () {
          var result;
          try {
            result = JSON.parse(String(reader.result));
          } catch (e) {
            self.showToast("这不是有效的 JSON 存档");
            return;
          }
          var res = game.storageManager.importData(result);
          if (!res.ok) {
            self.showToast("导入失败：" + res.reason);
            return;
          }
          self.showToast("存档已恢复" + (res.added > 0 ? "，新增收藏 " + res.added + " 项" : ""));
          Sfx.play("ui");
          setTimeout(function () { location.reload(); }, 1200);
        };
        reader.onerror = function () { self.showToast("读取文件失败"); };
        reader.readAsText(file, "utf-8");
      });
    }

    // 界面点击声：所有按钮统一给一记轻响，回退/消除用各自的音色
    document.addEventListener("click", function (e) {
      if (typeof Sfx === "undefined" || !Sfx) return;
      var btn = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!btn || btn.disabled) return;
      var id = btn.id || "";
      if (id === "btn-undo") Sfx.play("undo");
      else if (id === "btn-erase") Sfx.play("erase");
      else if (id === "seg-reset") Sfx.play("ui");
      else Sfx.play("ui");
    }, true);

    var resetBtn = document.querySelector("#seg-reset button");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () { self.inputManager.emit("resetData"); });
    }

    // 消除：按钮切换选格模式，点棋盘上任意方块完成消除
    if (this.btnErase) {
      this.btnErase.addEventListener("click", function () {
        if (self.pickMode) self.exitPick();
        else self.enterPick();
      });
    }

    this.canvas.addEventListener("click", function (e) { self.onCanvasClick(e); });

    window.addEventListener("resize", function () { self.resize(); });
  };

  Renderer3D.prototype.byId = function (id) {
    return document.getElementById(id);
  };

  Renderer3D.prototype.updateHud = function (meta) {
    if (this.elScore) this.elScore.textContent = String(meta.score);
    if (this.elBest) this.elBest.textContent = String(meta.bestScore);

    this.applySettings(meta.settings);
    this.refreshTools(meta);

    var mode = "";
    if (meta.over) mode = "over";
    else if (meta.won && meta.terminated) mode = "won";

    if (mode) this.showOverlay(mode, meta);
    else this.hideOverlay();
  };

  // 工具栏：回退有没有历史可退、消除还剩几次，直接反映在按钮上
  // 注意消除按钮在选格时仍要可点，玩家靠它取消这次选择
  Renderer3D.prototype.refreshTools = function (meta) {
    var modalOpen = this.modal !== "";

    if (this.btnUndo) {
      this.btnUndo.disabled = !Boolean(meta.canUndo) || modalOpen || this.pickMode;
    }

    if (this.btnErase) {
      var left = typeof meta.eraseLeft === "number" ? meta.eraseLeft : 0;
      var unlimited = left < 0 || meta.eraseLimit === 0;
      this.btnErase.disabled = (!unlimited && left <= 0) || modalOpen;
      this.btnErase.textContent = unlimited ? "消除一格" : "消除 · " + left;
    }
  };

  Renderer3D.prototype.showOverlay = function (mode, meta) {
    if (!this.overlay) return;

    if (this.overlayMode === mode) {
      if (this.ovScore) this.ovScore.textContent = "本局得分 " + meta.score;
      return;
    }

    this.overlayMode = mode;
    if (this.ovTitle) {
      this.ovTitle.textContent = mode === "won" ? "合成金色大西瓜！" : "本局结束";
    }
    if (this.ovScore) this.ovScore.textContent = "本局得分 " + meta.score;
    if (this.btnContinue) this.btnContinue.style.display = mode === "won" ? "" : "none";
    this.overlay.classList.add("show");
  };

  Renderer3D.prototype.hideOverlay = function () {
    this.overlayMode = "";
    if (this.overlay) this.overlay.classList.remove("show");
  };

  /* ================= 覆盖层：菜单 / 榜单 / 设置 / 退出 ================= */

  // 有覆盖层开着、或正在选格消除时，滑动输入应当被忽略
  Renderer3D.prototype.isBlocking = function () {
    return this.modal !== "" || this.pickMode;
  };

  // 只判断覆盖层：消除动作本身要在选格状态里触发，不能被选格状态拦掉
  Renderer3D.prototype.isModalOpen = function () {
    return this.modal !== "";
  };

  Renderer3D.prototype.closeSheets = function () {
    ["menu", "board", "collection", "settings", "quit"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove("show");
    });
    this.modal = "";
    this.exitPick();
    if (this.meta) this.refreshTools(this.meta);
  };

  Renderer3D.prototype.openSheet = function (id) {
    ["menu", "board", "collection", "settings", "quit"].forEach(function (sid) {
      var el = document.getElementById(sid);
      if (el) el.classList.remove("show");
    });

    var el = document.getElementById(id);
    if (!el) return;

    el.classList.add("show");
    this.modal = id;
    this.exitPick();
    if (this.meta) this.refreshTools(this.meta);
  };

  Renderer3D.prototype.openMenu = function () {
    this.openSheet("menu");
    // 菜单里要显示当前模式与音量，直接从对局设置同步一次
    var game = window.__game;
    if (game && game.settings) this.applySettings(game.settings, true);
  };

  Renderer3D.prototype.openSettings = function () {
    if (this.meta) this.applySettings(this.meta.settings, true);
    this.openSheet("settings");
  };

  // 设置应用：特效倍率与背景浓度是真实生效的参数，值没变就不重复写
  Renderer3D.prototype.applySettings = function (settings, force) {
    if (!settings) return;

    var sig = [
      settings.fx, settings.bg, settings.erase, settings.sfx,
      settings.music, settings.sfxVol, settings.musicVol, settings.size
    ].join("|");
    if (!force && this.settingsSig === sig) return;
    this.settingsSig = sig;

    var fxMap = { off: 0, normal: 1, strong: 1.35 };
    this.fxScale = fxMap[settings.fx] !== undefined ? fxMap[settings.fx] : 1;

    var bgMap = { light: 0.32, normal: 0.62, deep: 0.95 };
    this.bgOpacity = bgMap[settings.bg] !== undefined ? bgMap[settings.bg] : 0.5;
    if (this.backdrop && this.backdrop.material) {
      this.backdrop.material.opacity = this.bgOpacity;
    }

    this.markSeg("seg-fx", settings.fx);
    this.markSeg("seg-bg", settings.bg);
    this.markSeg("seg-erase", settings.erase);
    this.markSeg("seg-sfx", settings.sfx === false ? "off" : "on");
    this.markSeg("seg-music", settings.music === false ? "off" : "on");
    this.markSeg("seg-mode", settings.size || 4);

    this.setSlider("vol-sfx", "vol-sfx-val", settings.sfxVol);
    this.setSlider("vol-music", "vol-music-val", settings.musicVol);
  };

  // 把 0~1 的音量值写回滑杆与旁边的数字
  Renderer3D.prototype.setSlider = function (sliderId, labelId, value) {
    var slider = document.getElementById(sliderId);
    if (!slider) return;
    var pct = Math.round((typeof value === "number" ? value : 0) * 100);
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    // 拖动过程中不要抢焦点、不要打断手感
    if (document.activeElement !== slider) slider.value = String(pct);
    var label = document.getElementById(labelId);
    if (label) label.textContent = String(pct);
  };

  Renderer3D.prototype.markSeg = function (id, value) {
    var box = document.getElementById(id);
    if (!box) return;
    var want = String(value);
    Array.prototype.forEach.call(box.querySelectorAll("button"), function (btn) {
      var on = btn.getAttribute("data-value") === want;
      if (on) btn.classList.add("on");
      else btn.classList.remove("on");
    });
  };

  Renderer3D.prototype.showLeaderboard = function (list) {
    var box = this.elBoardList;
    if (box) {
      var rows = Array.isArray(list) ? list : [];
      if (rows.length === 0) {
        box.innerHTML = '<div class="board-empty">还没有成绩，打完一局（走不动了）就会记一条。</div>';
      } else {
        var html = "";
        for (var i = 0; i < rows.length; i++) {
          var run = rows[i] || {};
          html += '<div class="board-row">'
            + '<span class="board-rank">' + (i + 1) + '</span>'
            + '<span class="board-score">' + (Number(run.score) || 0) + '</span>'
            + '<span class="board-tile">最高 ' + (Number(run.maxTile) || 0) + '</span>'
            + '<span class="board-tile">' + stampOf(run.at) + '</span>'
            + '</div>';
        }
        box.innerHTML = html;
      }
    }
    this.openSheet("board");
  };

  // 收藏家图鉴：11 级水果按顺序铺开，没点亮的是灰的
  Renderer3D.prototype.showCollection = function (entries) {
    var grid = this.elColGrid;
    var list = Array.isArray(entries) ? entries : [];
    var got = 0;

    if (grid) {
      var html = "";
      for (var i = 0; i < list.length; i++) {
        var item = list[i] || {};
        if (item.unlocked) got++;

        var src = "";
        if (typeof FRUIT_TEXTURES !== "undefined" && FRUIT_TEXTURES[item.value]) {
          src = FRUIT_TEXTURES[item.value];
        }
        if (!src) src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

        html += '<div class="col-item' + (item.unlocked ? "" : " locked") + '">'
          + '<img alt="" src="' + src + '">'
          + '<span class="col-name">' + (item.unlocked ? (item.name || "") : "？") + '</span>'
          + '<span class="col-lv">' + (Number(item.value) || 0) + '</span>'
          + '</div>';
      }
      grid.innerHTML = html;
    }

    if (this.elColCount) this.elColCount.textContent = String(got);

    this.openSheet("collection");
  };

  // 通用短提示：屏幕上方弹一条，自动消失
  Renderer3D.prototype.showToast = function (text) {
    if (!this.elToast) return;
    this.elToast.textContent = text;
    this.elToast.classList.add("show");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(function () {
      this.elToast.classList.remove("show");
    }.bind(this), 2400);
  };

  // 第一次收进图鉴时，屏幕上方弹一条短提示
  Renderer3D.prototype.onCollect = function (value, name) {
    if (!this.elToast) return;
    if (this.modal !== "") return;    // 覆盖层开着就不弹，免得被挡住

    this.showToast("新收藏 · " + name);
  };

  /* ================= 消除的选格交互 ================= */

  Renderer3D.prototype.enterPick = function () {
    if (this.modal !== "") return;
    if (this.btnErase && this.btnErase.disabled) return;

    this.pickMode = true;
    if (this.canvas) this.canvas.style.cursor = "crosshair";
    if (this.elPickHint) this.elPickHint.classList.add("show");
    if (this.meta) this.refreshTools(this.meta);
  };

  Renderer3D.prototype.exitPick = function () {
    this.pickMode = false;
    if (this.canvas) this.canvas.style.cursor = "";
    if (this.elPickHint) this.elPickHint.classList.remove("show");
  };

  // 点击棋盘：射一条线出去，命中方块后把落点反推成格子坐标
  Renderer3D.prototype.onCanvasClick = function (e) {
    if (!this.pickMode) return;

    var rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    var nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    var ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    var ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);

    var groups = [];
    this.nodes.forEach(function (node) { groups.push(node.group); });
    if (groups.length === 0) return;

    var hits = ray.intersectObjects(groups, true);
    if (hits.length === 0) return;

    var p = hits[0].point;
    var half = (this.gridSize - 1) / 2;
    var gx = Math.round(p.x / CELL + half);
    var gy = Math.round(p.z / CELL + half);

    if (gx < 0 || gy < 0 || gx >= this.gridSize || gy >= this.gridSize) return;

    this.exitPick();
    this.inputManager.emit("pickTile", { x: gx, y: gy });
  };

  // 按窗口比例摆相机：等距投影下只管取景范围，保证整盘完整落在画面里。
  // unit = 边长 × 1.15，4×4 时正好 4.6，与原版取景一致。
  Renderer3D.prototype.updateCamera = function () {
    if (!this.W || !this.H || !this.camera) return;
    var aspect = this.W / this.H;
    var unit = (this.gridSize || 4) * 1.15;

    var vh = unit;                        // 纵向留足整盘 + 边距
    var vw = vh * aspect;
    if (vw < unit) {
      vw = unit;                          // 窄屏优先保横向
      vh = vw / aspect;
    }

    var cam = this.camera;
    this.vw = vw;
    this.vh = vh;
    cam.left = -vw / 2;
    cam.right = vw / 2;
    cam.top = vh / 2;
    cam.bottom = -vh / 2;
    cam.near = 0.1;
    cam.far = 60;
    cam.updateProjectionMatrix();

    // 视线中心抬到果阵中腰，水果才落在画面正中
    cam.lookAt(0, 0.4, 0.02);
  };

  Renderer3D.prototype.resize = function () {
    var w = window.innerWidth;
    var h = window.innerHeight;
    this.W = w;
    this.H = h;

    this.renderer.setSize(w, h);
    this.updateCamera();
    this.fitBackdrop();
  };

  globalThis.Renderer3D = Renderer3D;
})();
