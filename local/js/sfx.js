/* ============================================================
   sfx.js —— 程序化音效引擎（纯 WebAudio 合成，不依赖任何音频文件）
   所有声音由振荡器 + 棕噪声实时生成，没有素材版权问题。
   对外 API：window.Sfx
     Sfx.resume()              首次用户手势时解锁音频
     Sfx.setEnabled(bool)      音效总开关
     Sfx.setVolume(0..1)       音量
     Sfx.play(name, opt)       播放一个音效
     Sfx.state()               内部状态
     Sfx.level()               当前输出电平峰值（0~1）
   ============================================================ */
(function (global) {
  "use strict";

  var ctx = null;
  var master = null;
  var analyser = null;
  var meterBuf = null;
  var noiseBuf = null;

  var enabled = true;
  var volume = 0.7;

  /* ---------- 基础设施 ---------- */

  function makeNoise(c) {
    // 棕噪声：低频更沉，比白噪声更"软"，适合做滑动/落子的质地声
    var len = Math.floor(c.sampleRate * 1.2);
    var buf = c.createBuffer(1, len, c.sampleRate);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) {
      var w = Math.random() * 2 - 1;
      last = 0.86 * last + 0.14 * w;
      d[i] = last * 1.9;
    }
    return buf;
  }

  function ensure() {
    if (ctx) return ctx;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch (e) {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = enabled ? volume : 0;

    // 电平表挂在输出前，用来确认声音真的发出来了
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    meterBuf = new Uint8Array(analyser.fftSize);
    master.connect(analyser);
    analyser.connect(ctx.destination);

    noiseBuf = makeNoise(ctx);
    return ctx;
  }

  function resume() {
    var c = ensure();
    if (!c) return;
    if (c.state === "suspended") {
      try { c.resume(); } catch (e) {}
    }
  }

  function out(node) {
    if (!ctx) return;
    // 简易立体声定位，左右各偏一点点，避免所有音都糊在正中
    if (ctx.createStereoPanner) {
      var p = ctx.createStereoPanner();
      p.pan.value = node.pan || 0;
      node.gain.connect(p);
      p.connect(master);
      return;
    }
    node.gain.connect(master);
  }

  /* ---------- 发声单元 ---------- */

  // 单音：带 AD 包络，可选滑音
  function tone(o) {
    var c = ensure();
    if (!c || !enabled) return;
    var t0 = c.currentTime + (o.delay || 0);
    var dur = o.dur || 0.2;
    var peak = o.gain || 0.2;

    var osc = c.createOscillator();
    osc.type = o.type || "triangle";
    osc.frequency.setValueAtTime(o.f, t0);
    if (o.f2 && o.f2 !== o.f) {
      var target = Math.max(24, o.f2);
      if (o.glide === "lin") osc.frequency.linearRampToValueAtTime(target, t0 + dur);
      else osc.frequency.exponentialRampToValueAtTime(target, t0 + dur);
    }

    var g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g);
    out({ gain: g, pan: o.pan || 0 });
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  // 噪声击打：filter 扫频做"沙""嗒""噗"
  function noiseHit(o) {
    var c = ensure();
    if (!c || !enabled) return;
    var t0 = c.currentTime + (o.delay || 0);
    var dur = Math.min(0.9, o.dur || 0.12);

    var src = c.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;

    var flt = c.createBiquadFilter();
    flt.type = o.filter || "bandpass";
    flt.Q.value = o.q || 0.9;
    flt.frequency.setValueAtTime(o.freq || 1200, t0);
    if (o.freq2) {
      flt.frequency.exponentialRampToValueAtTime(Math.max(80, o.freq2), t0 + dur);
    }

    var g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain || 0.12, t0 + (o.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(flt);
    flt.connect(g);
    out({ gain: g, pan: o.pan || 0 });
    src.start(t0);
    src.stop(t0 + dur + 0.04);
  }

  /* ---------- 音高映射 ---------- */

  // 每级一个半音位置，等级越高音越亮，到顶收在 3 个八度内
  var MERGE_SEMI = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

  function mergeFreq(rank) {
    var i = Math.max(0, Math.min(MERGE_SEMI.length - 1, (rank || 1) - 1));
    return 246.94 * Math.pow(2, MERGE_SEMI[i] / 12); // 从 B3 起
  }

  /* ---------- 音效库 ---------- */

  var CUES = {
    /* 滑动：一声很短的布料摩擦，不能抢戏 */
    slide: function () {
      noiseHit({ filter: "bandpass", freq: 2400, freq2: 900, q: 0.7, dur: 0.11, gain: 0.075 });
      noiseHit({ filter: "highpass", freq: 320, dur: 0.06, gain: 0.03, delay: 0.005 });
    },

    /* 合成：主音 + 八度，等级越高越高越脆 */
    merge: function (opt) {
      var rank = (opt && opt.rank) || 1;
      var f = mergeFreq(rank);
      tone({ f: f, type: "triangle", dur: 0.22, gain: 0.16, attack: 0.004 });
      tone({ f: f * 2, type: "sine", dur: 0.16, gain: 0.075, attack: 0.003, delay: 0.012 });
      noiseHit({ filter: "bandpass", freq: f * 3.2, q: 1.4, dur: 0.06, gain: 0.05 });
    },

    /* 大合成（≥128）：加一层五度与更长尾巴，听得出"分量" */
    mergeBig: function (opt) {
      var rank = (opt && opt.rank) || 7;
      var f = mergeFreq(rank) * 0.5;
      tone({ f: f, type: "triangle", dur: 0.52, gain: 0.15, attack: 0.006 });
      tone({ f: f * 1.5, type: "sine", dur: 0.46, gain: 0.10, attack: 0.008, delay: 0.02 });
      tone({ f: f * 2, type: "sine", dur: 0.38, gain: 0.075, attack: 0.01, delay: 0.045 });
      noiseHit({ filter: "bandpass", freq: 1800, freq2: 5200, q: 1.1, dur: 0.26, gain: 0.055 });
    },

    /* 新水果落位：极轻的一声"啵" */
    spawn: function () {
      tone({ f: 520, f2: 880, type: "sine", dur: 0.09, gain: 0.07, attack: 0.004 });
    },

    /* 界面点击：干脆、短，不拖尾 */
    ui: function () {
      noiseHit({ filter: "lowpass", freq: 900, q: 1.2, dur: 0.035, gain: 0.09 });
      tone({ f: 660, f2: 520, type: "triangle", dur: 0.055, gain: 0.055, attack: 0.002 });
    },

    /* 回退：两段下行，表示"倒带" */
    undo: function () {
      tone({ f: 620, f2: 480, type: "triangle", dur: 0.12, gain: 0.10, attack: 0.004 });
      tone({ f: 480, f2: 720, type: "sine", dur: 0.15, gain: 0.08, attack: 0.004, delay: 0.10 });
    },

    /* 消除：一下"噗"接一个高点数 */
    erase: function () {
      noiseHit({ filter: "bandpass", freq: 900, freq2: 200, q: 0.6, dur: 0.16, gain: 0.10 });
      tone({ f: 1240, type: "sine", dur: 0.10, gain: 0.06, delay: 0.06 });
    },

    /* 胜利：C–E–G–C 琶音，收尾叠一个长和弦，把"赢了"的余韵撑住 */
    win: function () {
      var seq = [523.25, 659.26, 783.99, 1046.5];
      for (var i = 0; i < seq.length; i++) {
        tone({ f: seq[i], type: "triangle", dur: 0.42, gain: 0.14, attack: 0.006, delay: i * 0.10 });
        tone({ f: seq[i] * 2, type: "sine", dur: 0.26, gain: 0.055, attack: 0.006, delay: i * 0.10 });
      }
      tone({ f: 1046.5, type: "triangle", dur: 0.90, gain: 0.100, attack: 0.020, delay: 0.42 });
      tone({ f: 783.99, type: "sine", dur: 0.95, gain: 0.062, attack: 0.020, delay: 0.42 });
      tone({ f: 523.25, type: "sine", dur: 1.05, gain: 0.050, attack: 0.020, delay: 0.42 });
    },

    /* 失败：两轨下沉，末尾再垫一记低频，落下去有重量 */
    lose: function () {
      tone({ f: 392, f2: 196, type: "triangle", dur: 0.55, gain: 0.13, attack: 0.008, glide: "lin" });
      tone({ f: 311.13, f2: 155.56, type: "sine", dur: 0.62, gain: 0.09, attack: 0.010, glide: "lin", delay: 0.06 });
      tone({ f: 130.81, f2: 98, type: "sine", dur: 0.80, gain: 0.10, attack: 0.030, glide: "lin", delay: 0.22 });
    }
  };

  /* ---------- 背景音乐 ----------
     走 HTML5 Audio 独立通道：能和音效分别调音量，也不被音效的静音牵连。
     循环播放，data URL 内嵌，零外部文件依赖。 */

  var musicEnabled = true;
  var musicVolume = 0.35;
  var bgmAudio = null;

  function ensureMusic() {
    if (bgmAudio) return bgmAudio;
    if (!global.BGM_DATA || !global.BGM_DATA.music) return null;
    try {
      bgmAudio = new global.Audio(global.BGM_DATA.music);
      bgmAudio.loop = true;
      bgmAudio.preload = "auto";
      bgmAudio.volume = musicEnabled ? musicVolume : 0;
    } catch (e) {
      bgmAudio = null;
    }
    return bgmAudio;
  }

  function startMusic() {
    var a = ensureMusic();
    if (!a || !musicEnabled || musicVolume <= 0) return false;
    try {
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
      return true;
    } catch (e) {
      return false;
    }
  }

  function stopMusic() {
    if (!bgmAudio) return;
    try { bgmAudio.pause(); } catch (e) {}
  }

  /* ---------- 对外 ---------- */

  var API = {
    resume: resume,

    setEnabled: function (v) {
      enabled = !!v;
      if (master) master.gain.value = enabled ? volume : 0;
    },

    setVolume: function (v) {
      volume = Math.max(0, Math.min(1, typeof v === "number" ? v : 0.7));
      if (master && enabled) master.gain.value = volume;
    },

    setMusicEnabled: function (v) {
      musicEnabled = !!v;
      if (musicEnabled) {
        if (bgmAudio) bgmAudio.volume = musicVolume;
        startMusic();
      } else {
        stopMusic();
        if (bgmAudio) bgmAudio.volume = 0;
      }
    },

    setMusicVolume: function (v) {
      musicVolume = Math.max(0, Math.min(1, typeof v === "number" ? v : 0.35));
      if (!bgmAudio) return;
      bgmAudio.volume = musicEnabled ? musicVolume : 0;
      if (musicEnabled && musicVolume > 0) startMusic();
      else if (musicVolume <= 0) stopMusic();
    },

    playMusic: startMusic,
    stopMusic: stopMusic,
    hasMusic: function () { return !!(global.BGM_DATA && global.BGM_DATA.music); },

    play: function (name, opt) {
      var cue = CUES[name];
      if (!cue) return false;
      if (!enabled) return false;
      ensure();
      if (!ctx) return false;
      try {
        cue(opt || {});
        return true;
      } catch (e) {
        return false;
      }
    },

    /* 内部状态：AudioContext 是否已建、是否在运行、主音量当前值 */
    state: function () {
      return {
        state: ctx ? ctx.state : "none",
        enabled: enabled,
        volume: volume,
        cues: Object.keys(CUES).length,
        music: {
          hasData: API.hasMusic(),
          enabled: musicEnabled,
          volume: musicVolume,
          playing: !!(bgmAudio && !bgmAudio.paused && bgmAudio.currentTime > 0)
        }
      };
    },

    /* 当前输出电平峰值（0~1）。音效正在响时大于 0，用来确认真的出声了 */
    level: function () {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(meterBuf);
      var peak = 0;
      for (var i = 0; i < meterBuf.length; i++) {
        var v = Math.abs(meterBuf[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      return peak;
    }
  };

  // 首次交互自动解锁（浏览器自动播放策略要求）。音效与背景音乐一起放行。
  function unlockOnce() {
    resume();
    startMusic();
    global.removeEventListener("pointerdown", unlockOnce, true);
    global.removeEventListener("keydown", unlockOnce, true);
  }
  global.addEventListener("pointerdown", unlockOnce, true);
  global.addEventListener("keydown", unlockOnce, true);

  global.Sfx = API;
})(window);
