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

  /* 依据当前屏幕像素尺寸计算布局参数（整数模块像素、版本、绘制尺寸、分包大小） */
  function computeChunkSize(W, H) {
    var P = QRProtocol.computeLayoutParams(W, H, cfg.maxVersion);
    cfg.cols = QRProtocol.GRID_COLS;
    cfg.rows = QRProtocol.GRID_ROWS;
    cfg.version = P.version;
    cfg.px = P.px;
    cfg.total = P.total;
    cfg.qrDrawn = P.qrDrawn;
    return P.chunkSize;
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

  /* 每帧槽位 0 固定为元数据包（可靠性优先：接收端只要锁住 0 号码位
   * 就能立即拿到文件信息并显示进度）；
   * 数据队列耗尽即重建（小文件也会循环重发全部数据包）；
   * 小文件（数据包不足 6 个）时剩余槽位用元数据填充：所有码位都有内容 */
  function nextFramePacketIndexes() {
    var n = cfg.cols * cfg.rows;
    var out = new Array(n).fill(null);
    if (meta && n > 0) out[0] = 0;
    for (var i = 0; i < n; i++) {
      if (out[i] !== null) continue;
      if (!meta || meta.chunks === 0) continue;
      if (order.length === 0 || pos >= meta.chunks) buildOrder();   /* 队列为空或耗尽：重建（重新洗牌）继续重发 */
      if (pos < meta.chunks) { out[i] = order[pos++]; }
      else { out[i] = 0; }                    /* 兜底：剩余槽位填元数据 */
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
    var L = QRProtocol.gridLayout(W, H, cfg.qrDrawn);
    var qrDrawn = cfg.qrDrawn, m = L.m;
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
        var x = Math.round(cell.x - qrDrawn / 2), y = Math.round(cell.y - qrDrawn / 2);
        if (p == null) { continue; }
        /* 克隆并改写 cell 字节（byte[3]=槽位），供接收端建立码位↔位置对应；
         * 元数据包可能同时出现在多个槽位，必须克隆避免互相覆盖 */
        var q = new Uint8Array(p);
        q[3] = r * cfg.cols + c;
        var qr = makeQrMatrix(q);
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
        /* qrDrawn = 整数模块像素 × total → 缩放为精确整数倍，模块均匀锐利 */
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, x, y, qrDrawn, qrDrawn);
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
    el.innerHTML = '已播 <b>' + shownFrames + '</b> 帧 · ' + fps.toFixed(1) + ' FPS · 第 ' + pass + ' 轮 · 单帧约 ' + perFrame +
      '<br><span class="dim">单向传输：手机端接收完成后，请点「⏹ 停止」</span>';
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
    computeChunkSize(canvas.width, canvas.height);   /* 对齐测试使用与真实传输相同的布局 */
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
