function InputManager() {
  this.events = {};
  this.listen();
}

InputManager.prototype.on = function (event, callback) {
  if (!this.events[event]) this.events[event] = [];
  this.events[event].push(callback);
};

InputManager.prototype.emit = function (event, data) {
  var callbacks = this.events[event];
  if (callbacks) callbacks.forEach(function (cb) { cb(data); });
};

InputManager.prototype.listen = function () {
  var self = this;
  var touchStartX = 0, touchStartY = 0;

  function onStart(x, y) { touchStartX = x; touchStartY = y; }

  function onEnd(x, y) {
    var dx = x - touchStartX;
    var dy = y - touchStartY;
    var absDx = Math.abs(dx);
    var absDy = Math.abs(dy);
    if (Math.max(absDx, absDy) > 10) {
      self.emit('move', absDx > absDy ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
    }
  }

  if (Platform.hasTT) {
    tt.onTouchStart(function (e) {
      var t = (e.touches && e.touches[0]) || e;
      onStart(t.clientX, t.clientY);
    });
    tt.onTouchEnd(function (e) {
      var t = (e.changedTouches && e.changedTouches[0]) || e;
      onEnd(t.clientX, t.clientY);
    });
  } else {
    // 浏览器调试降级：触摸 + 方向键
    document.addEventListener('touchstart', function (e) {
      var t = e.touches[0];
      onStart(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
      var t = e.changedTouches[0];
      onEnd(t.clientX, t.clientY);
    });

    var map = { 38: 0, 39: 1, 40: 2, 37: 3 };
    document.addEventListener('keydown', function (event) {
      var mapped = map[event.which];
      if (mapped !== undefined) {
        event.preventDefault();
        self.emit('move', mapped);
      }
      if (event.which === 82) self.emit('restart'); // R 重开
    });

    // 桌面浏览器：鼠标按住拖拽同样可以滑动
    var dragging = false;
    document.addEventListener('mousedown', function (e) {
      dragging = true;
      onStart(e.clientX, e.clientY);
    });
    document.addEventListener('mouseup', function (e) {
      if (!dragging) return;
      dragging = false;
      onEnd(e.clientX, e.clientY);
    });
    // 拖出窗口后松开也要收尾，避免下一次点击被误判为拖拽
    document.addEventListener('mouseleave', function () { dragging = false; });
  }
};

globalThis.InputManager = InputManager;
