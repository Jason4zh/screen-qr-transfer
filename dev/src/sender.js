/* ============================================================================
 * 屏码传 · 发送端：文件分包 → 多二维码阵列流式渲染
 * 空间维度：2x2 / 3x2 码阵并行（单帧承载量 = 单码 × 码数）
 * 时间维度：流式换帧，每包独立 CRC，乱序洗牌重发（丢帧/漏码不丢数据）
 * 颜色维度：边框颜色逐帧变化（帧标识色），便于肉眼与接收端感知帧切换；
 *           颜色不承载数据，规避手机摄像头白平衡导致的彩色误判
 * ==========================================================================*/
(function (global) {
  'use strict';

  var Sender = {};

  var PALETTE = ['#E53935', '#43A047', '#1E88E5', '#FDD835'];
  var PRESETS = {
    stable:   { maxVersion: 13, holdMs: 450 },
    balanced: { maxVersion: 17, holdMs: 250 },
    fast:     { maxVersion: 20, holdMs: 150 }
  };

  var fileBytes = null, fileName = '';
  var packets = [], meta = null, chunkSize = 0;
  var running = false, alignMode = false, timer = null;
  var frameNo = 0, order = [], pos = 0, shownFrames = 0, startTs = 0, slotsSent = 0;
  var alignCache = null;
  var cfg = { cols: 3, rows: 2, maxVersion: 17, holdMs: 250, version: 17, colorSync: true, fullscreen: true };
  var canvas = null, ctx = null, off = null, offctx = null;

  function $(id) { return document.getElementById(id); }

  Sender.setFile = function (name, bytes) { fileName = name; fileBytes = bytes; };

  Sender.setConfig = function (presetName, colorSync, fullscreen) {
    var p = PRESETS[presetName] || PRESETS.balanced;
    cfg = {
      cols: QRProtocol.GRID_COLS, rows: QRProtocol.GRID_ROWS,
      maxVersion: p.maxVersion, holdMs: p.holdMs,
      colorSync: !!colorSync, fullscreen: !!fullscreen, version: p.maxVersion
    };
  };

  /* 依据当前屏幕像素尺寸计算实际码阵与分包大小（含降级：屏幕太小自动缩阵） */
  function computeChunkSize(W, H) {
    var L = QRProtocol.gridLayout(W, H);
    var cols = QRProtocol.GRID_COLS, rows = QRProtocol.GRID_ROWS;
    cfg.cols = cols; cfg.rows = rows;
    var maxMods = Math.floor(L.qrSize / 3.5) - 8;       /* 每模块 ≥3.5 屏幕像素，另留静区 */
    var verByPx = Math.max(1, Math.min(40, Math.floor((maxMods - 17) / 4)));
    var ver = Math.max(1, Math.min(cfg.maxVersion, verByPx));
    cfg.version = ver;
    var cap = QRProtocol.CAPACITY_L[ver];
    return Math.max(64, cap - QRProtocol.HEADER_LEN - 4);
  }

  /* 供 UI 预估用 */
  Sender.estimate = function () {
    if (!fileBytes) return null;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(window.innerWidth * dpr);
    var h = Math.round(window.innerHeight * dpr);
    var cs = computeChunkSize(w, h);
    var frameBytes = cs * cfg.cols * cfg.rows;
    var fps = 1000 / cfg.holdMs;
    var eff = 0.55; /* 典型解码有效率 */
    var bps = frameBytes * fps * eff;
    return { chunkSize: cs, cols: cfg.cols, rows: cfg.rows, version: cfg.version, fps: fps, bps: bps, seconds: fileBytes.length / Math.max(1, bps) };
  };

  Sender.isRunning = function () { return running; };

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0;
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function buildOrder() {
    var arr = new Array(meta.chunks);
    for (var i = 0; i < meta.chunks; i++) arr[i] = i + 1;
    order = shuffle(arr); pos = 0;
  }

  /* 每帧挑选一窗口的包；每 24 帧把 0 号（元数据）插到槽位 0，保证接收端尽早拿到文件信息 */
  function nextFramePacketIndexes() {
    var n = cfg.cols * cfg.rows;
    var out = new Array(n).fill(null);
    if (meta && n > 0 && frameNo % 24 === 0) out[0] = 0;
    for (var i = 0; i < n; i++) {
      if (out[i] !== null) continue;
      if (!meta || meta.chunks === 0) continue;
      if (order.length === 0 || pos >= order.length) buildOrder();
      out[i] = order[pos++];
    }
    slotsSent += n;
    return out;
  }

  function toBinaryString(bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return s;
  }
  function makeQrMatrix(bytes) {
    var qr = qrcode(0, 'L');
    qr.addData(toBinaryString(bytes), 'Byte');
    qr.make();
    return qr;
  }

  function render(payloads, fn) {
    var W = canvas.width, H = canvas.height;
    var L = QRProtocol.gridLayout(W, H);
    var qrSize = L.qrSize, m = L.m;
    /* 彩色边框（帧同步标识色） */
    ctx.fillStyle = cfg.colorSync ? PALETTE[fn % PALETTE.length] : '#20243a';
    ctx.fillRect(0, 0, W, H);
    /* 白色区域 */
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(m, m, W - 2 * m, H - 2 * m);

    var quiet = 4;
    for (var r = 0; r < cfg.rows; r++) {
      for (var c = 0; c < cfg.cols; c++) {
        var p = payloads[r * cfg.cols + c];
        var cell = L.cells[r * cfg.cols + c];
        var x = Math.round(cell.x - qrSize / 2), y = Math.round(cell.y - qrSize / 2);
        if (p == null) { continue; }
        var qr = makeQrMatrix(p);
        var mods = qr.getModuleCount();
        var total = mods + quiet * 2;
        if (!off || off.width !== total) {
          off = document.createElement('canvas');
          off.width = total; off.height = total;
          offctx = off.getContext('2d');
        }
        offctx.fillStyle = '#ffffff'; offctx.fillRect(0, 0, total, total);
        offctx.fillStyle = '#000000';
        for (var mm = 0; mm < mods; mm++) {
          for (var nn = 0; nn < mods; nn++) {
            if (qr.isDark(mm, nn)) offctx.fillRect(nn + quiet, mm + quiet, 1, 1);
          }
        }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(off, x, y, qrSize, qrSize);
      }
    }

    /* 顶部状态文字（置于边距区，不影响扫码） */
    if (meta && fileBytes) {
      var label = fileName.length > 26 ? fileName.slice(0, 26) + '…' : fileName;
      ctx.font = Math.max(12, Math.round(H * 0.016)) + 'px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      var tx = m + 6, ty = m + 4;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(tx - 4, ty - 2, ctx.measureText(label).width + 140, 22);
      ctx.fillStyle = '#ffffff';
      ctx.fillText('📄 ' + label + ' · ' + QRProtocol.fmtBytes(fileBytes.length) + ' · 帧' + fn, tx, ty);
    }
  }

  function alignPayloads() {
    if (!alignCache) {
      alignCache = [];
      var n = cfg.cols * cfg.rows;
      for (var i = 0; i < n; i++) {
        var b = new Uint8Array(180);
        for (var j = 0; j < b.length; j++) b[j] = (i * 31 + j * 7) & 255;
        alignCache.push(b);
      }
    }
    return alignCache;
  }

  function tick() {
    if (!running && !alignMode) return;
    var idxs = alignMode ? null : nextFramePacketIndexes();
    var payloads;
    if (alignMode) payloads = alignPayloads();
    else payloads = idxs.map(function (ix) { return ix == null ? null : packets[ix]; });
    render(payloads, frameNo);
    frameNo++; shownFrames++;
    if (running) updateStats();
    var delay = alignMode ? 300 : cfg.holdMs;
    timer = setTimeout(tick, delay);
  }

  function updateStats() {
    var el = $('sendStats'); if (!el) return;
    var sec = (performance.now() - startTs) / 1000;
    var fps = sec > 0 ? shownFrames / sec : 0;
    var pass = 1;
    if (meta && meta.chunks > 0) pass = Math.floor(slotsSent / meta.chunks) + 1;
    var perFrame = QRProtocol.fmtBytes(chunkSize * cfg.cols * cfg.rows);
    el.innerHTML = '已播 <b>' + shownFrames + '</b> 帧 · ' + fps.toFixed(1) + ' FPS · 第 ' + pass + ' 轮 · 单帧约 ' + perFrame;
    var lbl = $('txLabel'); if (lbl) lbl.textContent = '📤 ' + (fileName.length > 20 ? fileName.slice(0, 20) + '…' : fileName) + ' · ' + QRProtocol.fmtBytes(fileBytes.length);
  }

  function ensureCanvas() {
    if (!canvas) {
      canvas = $('txCanvas');
      ctx = canvas.getContext('2d');
    }
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  }

  function showOverlay(on) {
    var ov = $('txOverlay');
    ov.style.display = on ? 'flex' : 'none';
    document.body.style.overflow = on ? 'hidden' : '';
  }

  Sender.start = function () {
    if (!fileBytes) { global.UI && UI.toast('请先选择文件'); return; }
    ensureCanvas();
    chunkSize = computeChunkSize(canvas.width, canvas.height);
    var res = QRProtocol.packetize(fileBytes, fileName, chunkSize);
    packets = res.packets; meta = res.meta;
    frameNo = 0; order = []; pos = 0; slotsSent = 0; shownFrames = 0;
    startTs = performance.now();
    alignMode = false; running = true; alignCache = null;
    if (timer) { clearTimeout(timer); timer = null; }   /* 防止对齐测试的旧定时器造成双速渲染 */
    showOverlay(true);
    updateStats();
    tick();
    if (cfg.fullscreen && document.documentElement.requestFullscreen) {
      var p = document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(function () {});
    }
  };

  Sender.stop = function () {
    running = false; alignMode = false;
    if (timer) { clearTimeout(timer); timer = null; }
    showOverlay(false);
    if (document.fullscreenElement && document.exitFullscreen) {
      var p = document.exitFullscreen();
      if (p && p.catch) p.catch(function () {});
    }
  };

  Sender.align = function () {
    ensureCanvas();
    if (running) return;
    alignMode = true; running = false;
    frameNo = 0; alignCache = null; shownFrames = 0;
    showOverlay(true);
    tick();
  };

  Sender.onResize = function () {
    if (canvas && (running || alignMode)) ensureCanvas();
  };

  Sender.resetFile = function () { fileBytes = null; fileName = ''; meta = null; packets = []; };

  global.Sender = Sender;
})(typeof globalThis !== 'undefined' ? globalThis : this);
