/* ============================================================================
 * 屏码传 · 接收端：摄像头实时扫描 → 定位码阵 → 区域解码 → 校验重组 → 下载
 * 定位：整帧 jsQR 找种子码（多码补丁）→ 由码版本/位置推导 3×2 网格 →
 *       候选紧裁剪解码锁定各码位 → 逐区域独立解码（缺失/损坏不影响其他）→
 *       失败连击或周期到时自动重新定位
 * ==========================================================================*/
(function (global) {
  'use strict';

  var Receiver = {};
  var PROC_MAX_W = 1280;              /* 处理画布最大宽度（性能上限） */

  var video = null, proc = null, pctx = null, overlay = null, octx = null;
  var crop = null, cctx = null, sCanvas = null, sctx = null;
  var stream = null, running = false, timer = null;
  var regions = [];                   /* {x,y,w,h,fails,ok} */
  var needRelocate = true, lastRelocate = 0, failStreak = 0;
  var meta = null, chunks = null, received = null, gotCount = 0;
  var lastTotal = 0;               /* 未收到元数据时，用包头 total 显示进度 */
  var speedWindow = [];
  var stats = { fps: 0, ticks: 0, last: 0 };
  var resultBytes = null, resultName = '';

  function $(id) { return document.getElementById(id); }

  Receiver.isRunning = function () { return running; };

  Receiver.start = async function () {
    if (running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('此浏览器不支持摄像头调用');
      return;
    }
    if (!window.isSecureContext) {
      setStatus('⚠ 摄像头需要安全上下文：请用 HTTPS / 127.0.0.1 访问，或在 Android Chrome/Edge 中直接以 file:// 打开本文件');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
    } catch (e) {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
      catch (e2) { setStatus('无法打开摄像头：' + (e2 && e2.name ? e2.name : String(e2))); return; }
    }
    video = $('video');
    video.srcObject = stream;
    try { await video.play(); } catch (e) {}
    running = true;
    needRelocate = true; lastRelocate = 0; regions = []; failStreak = 0;
    resetReceive();
    setStatus('正在寻找二维码… 请将手机对准电脑屏幕（距离 30~60cm）');
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        var wl = navigator.wakeLock.request('screen');
        if (wl && wl.catch) wl.catch(function () {});
      }
    } catch (e) {}
    timer = setTimeout(loop, 30);
  };

  Receiver.stop = function () {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (video) video.srcObject = null;
    var ov = $('overlay'); if (ov && octx) octx.clearRect(0, 0, ov.width, ov.height);
  };

  function resetReceive() {
    meta = null; chunks = null; received = null; gotCount = 0;
    speedWindow = []; resultBytes = null; resultName = '';
    $('progressWrap').style.display = 'none';
    $('btnDownload').style.display = 'none';
    $('progressFill').style.width = '0%';
    $('progressText').textContent = '';
  }

  function loop() {
    if (!running) return;
    var t0 = performance.now();
    try { step(); } catch (e) { console.error(e); }
    var cost = performance.now() - t0;
    timer = setTimeout(loop, Math.max(20, 40 - cost));  /* 目标 ~25Hz，自适应开销 */
  }

  function step() {
    stats.ticks++;
    var now = performance.now();
    if (now - stats.last >= 1000) { stats.fps = stats.ticks; stats.ticks = 0; stats.last = now; }
    if (!video || !video.videoWidth) return;
    ensureProc();
    pctx.drawImage(video, 0, 0, proc.width, proc.height);
    if (needRelocate && now - lastRelocate > 400) doRelocate();
    else if (regions.length) decodeRegions();
    /* 重定位节奏：码位过少 / 有码位持续失败 / 尚未收到元数据 → 每 3 秒；
     * 一切正常 → 每 30 秒防漂移（避免频繁全帧扫描阻塞解码） */
    var expected = 6;
    if (meta) expected = Math.min(6, meta.chunks + 1);
    var anyBad = false;
    for (var bi = 0; bi < regions.length; bi++) {
      if (regions[bi].fails > 5) { anyBad = true; break; }
    }
    var needFast = regions.length < 3 || anyBad || !meta;
    if (now - lastRelocate > (needFast ? 3000 : 30000)) needRelocate = true;
    drawOverlay();
    updateUI();
  }

  function ensureProc() {
    var w = Math.min(video.videoWidth || 1280, PROC_MAX_W);
    var h = Math.max(2, Math.round(w * (video.videoHeight || 720) / Math.max(1, video.videoWidth || 1280)));
    if (!proc || proc.width !== w || proc.height !== h) {
      proc = document.createElement('canvas');
      proc.width = w; proc.height = h;
      pctx = proc.getContext('2d', { willReadFrequently: true });
    }
  }

  /* 降采样种子搜索：整帧缩到 ~640 宽再 jsQR（补丁后各尺度均可靠），
   * 比全分辨率快约 4 倍；把 location 映射回全分辨率坐标 */
  function seedSearch() {
    var dw = Math.min(640, proc.width);
    var dh = Math.max(2, Math.round(dw * proc.height / proc.width));
    if (!sCanvas) { sCanvas = document.createElement('canvas'); sctx = sCanvas.getContext('2d', { willReadFrequently: true }); }
    sCanvas.width = dw; sCanvas.height = dh;
    sctx.drawImage(proc, 0, 0, dw, dh);
    var img = sctx.getImageData(0, 0, dw, dh);
    var seed = jsQR(img.data, dw, dh);
    if (!seed) return null;
    var s = proc.width / dw;
    var loc = seed.location;
    function scalePt(p) { return { x: p.x * s, y: p.y * s }; }
    return {
      version: seed.version,
      binaryData: seed.binaryData,
      location: {
        topLeftCorner: scalePt(loc.topLeftCorner),
        topRightCorner: scalePt(loc.topRightCorner),
        bottomLeftCorner: scalePt(loc.bottomLeftCorner),
        bottomRightCorner: scalePt(loc.bottomRightCorner),
        topLeftFinderPattern: scalePt(loc.topLeftFinderPattern),
        topRightFinderPattern: scalePt(loc.topRightFinderPattern),
        bottomLeftFinderPattern: scalePt(loc.bottomLeftFinderPattern),
        bottomRightAlignmentPattern: loc.bottomRightAlignmentPattern ? scalePt(loc.bottomRightAlignmentPattern) : null
      }
    };
  }

  function doRelocate() {
    lastRelocate = performance.now();
    var corr = [];
    var sizes = [];
    function addCorr(qr, ox, oy) {
      var pkt = QRProtocol.decodePacket(qr.binaryData);
      if (!pkt) return;
      var dg = QRProtocol.deriveGrid(qr);
      /* jsQR 的 location 是相对于输入图像的：裁剪图需加回裁剪原点偏移 */
      corr.push({ cell: pkt.cell, x: dg.centerX + ox, y: dg.centerY + oy, size: dg.qrSize });
      sizes.push(dg.qrSize);
      handlePacket(pkt);
    }
    /* 阶段 A：降采样整帧搜索种子码（补丁后可在密集码阵中找到至少一个） */
    var seed = seedSearch();
    if (seed) {
      addCorr(seed, 0, 0);
      /* 均匀网格候选扫描（宽容裁剪，容纳透视/尺寸推导误差） */
      var g = QRProtocol.deriveGrid(seed);
      var offsets = QRProtocol.candidateOffsets();
      var side = Math.round(g.qrSize * 1.3);
      var half = side / 2;
      for (var i = 0; i < offsets.length; i++) {
        var cx = g.centerX + offsets[i][0] * g.pitch;
        var cy = g.centerY + offsets[i][1] * g.pitch;
        if (cx - half < 0 || cy - half < 0 || cx + half > proc.width || cy + half > proc.height) continue;
        var rx = Math.round(cx - half), ry = Math.round(cy - half);
        var qr = cropAndDecode(proc, rx, ry, side, side);
        if (qr && qr.binaryData) addCorr(qr, rx, ry);
      }
    }
    /* 阶段 B（兜底）：种子失败或对应点不足时，用粗瓦片扫描收集对应点
     * （单码裁剪比整帧密集搜索更抗透视/模糊，避免“卡住”扫不到） */
    if (corr.length < 3) {
      var tcorr = tileScan();
      for (var ti = 0; ti < tcorr.length; ti++) {
        corr.push(tcorr[ti]);
        sizes.push(tcorr[ti].size);
      }
    }
    if (!corr.length) {
      if (!regions.length) setStatus('未检测到二维码：请对准屏幕并保持稳定（距离 30~60cm，避免反光）');
      return;
    }
    /* 阶段 C：仿射拟合修正透视/偏移 → 计算全部 6 个码位 → 逐格验证锁定 */
    var medSize = median(sizes) || (g ? g.qrSize : 320);
    var T = corr.length >= 3 ? QRProtocol.fitAffine(corr) : null;
    var found = [];
    if (T) {
      /* 验证裁剪：比码略大（容纳透视残差）但小于码距（避免含入邻码）；
       * 越界检查放宽（边缘码位由 cropAndDecode 钳制处理） */
      var cside = Math.round(medSize * 1.06);
      for (var cellId = 0; cellId < 6; cellId++) {
        var pos = T.apply(cellId);
        var chalf = cside / 2;
        if (pos.x + cside < 0 || pos.y + cside < 0 || pos.x - cside > proc.width || pos.y - cside > proc.height) continue;
        var rx = Math.round(pos.x - chalf), ry = Math.round(pos.y - chalf);
        var qr2 = cropAndDecode(proc, rx, ry, cside, cside);
        if (qr2 && qr2.binaryData) {
          var pkt2 = QRProtocol.decodePacket(qr2.binaryData);
          if (pkt2 && pkt2.cell === cellId) {   /* 码位号校验几何正确性 */
            var dg2 = QRProtocol.deriveGrid(qr2);
            /* 区域以解码出的二维码实际位置与尺寸为准（紧贴，透视下更稳） */
            var rs = Math.round(dg2.qrSize + 8);
            found.push({ cell: cellId, x: Math.round(dg2.centerX + rx - rs / 2), y: Math.round(dg2.centerY + ry - rs / 2), w: rs, h: rs, fails: 0, ok: 1 });
            handlePacket(pkt2);
          }
        }
      }
    } else {
      /* 对应点不足/退化：直接使用已解码到的码位作为区域（部分锁定也能传输） */
      var seen = {};
      for (var ci = 0; ci < corr.length; ci++) {
        var c = corr[ci];
        if (seen[c.cell]) continue;
        seen[c.cell] = true;
        var h2 = c.size / 2 + 4;
        found.push({ cell: c.cell, x: Math.round(c.x - h2), y: Math.round(c.y - h2), w: Math.round(c.size + 8), h: Math.round(c.size + 8), fails: 0, ok: 1 });
      }
    }
    if (found.length) {
      regions = found;
      needRelocate = false; failStreak = 0;
      setStatus('已锁定 ' + regions.length + ' 个码位，接收中…');
    } else if (!regions.length) {
      setStatus('检测到二维码画面但解码失败：请稍调距离/角度/亮度');
    }
  }

  /* 粗瓦片扫描：半帧大小的瓦片（≥ 单码尺寸，保证整码落入瓦片内）按半幅步进
   * 覆盖全帧，收集「码位↔位置」对应。单码裁剪比整帧搜索更抗透视与模糊，
   * 是种子/候选扫描失败时的主要兜底。 */
  function tileScan() {
    var out = [];
    var tw = Math.floor(proc.width / 2), th = Math.floor(proc.height / 2);
    var xstep = Math.floor(tw / 2), ystep = Math.floor(th / 2);
    var nx = Math.ceil((proc.width - tw) / xstep) + 1;
    var ny = Math.ceil((proc.height - th) / ystep) + 1;
    for (var r = 0; r < ny; r++) {
      for (var c = 0; c < nx; c++) {
        var x = Math.min(proc.width - tw, Math.round(c * xstep));
        var y = Math.min(proc.height - th, Math.round(r * ystep));
        var qr = cropAndDecode(proc, x, y, tw, th);
        if (qr && qr.binaryData) {
          var pkt = QRProtocol.decodePacket(qr.binaryData);
          if (pkt) {
            var dg = QRProtocol.deriveGrid(qr);
            out.push({ cell: pkt.cell, x: dg.centerX + x, y: dg.centerY + y, size: dg.qrSize });
          }
        }
      }
    }
    return out;
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.floor(a.length / 2)];
  }

  function cropAndDecode(src, x, y, w, h) {
    /* 裁剪范围钳制到画布内（靠边码位只损失少量静区，仍可解码） */
    var cx = Math.max(0, Math.round(x));
    var cy = Math.max(0, Math.round(y));
    var cw = Math.min(w, src.width - cx);
    var ch = Math.min(h, src.height - cy);
    if (cw < 40 || ch < 40) return null;
    if (!crop || crop.width < cw || crop.height < ch) {
      crop = document.createElement('canvas');
      crop.width = cw; crop.height = ch;
      cctx = crop.getContext('2d', { willReadFrequently: true });
    }
    cctx.drawImage(src, cx, cy, cw, ch, 0, 0, cw, ch);
    var img = cctx.getImageData(0, 0, cw, ch);
    return jsQR(img.data, cw, ch);
  }

  function decodeRegions() {
    var anyOk = false;
    for (var i = 0; i < regions.length; i++) {
      var r = regions[i];
      var qr = decodeRegion(r);
      if (qr && qr.binaryData) {
        var pkt = QRProtocol.decodePacket(qr.binaryData);
        if (pkt) { r.fails = 0; r.ok++; anyOk = true; handlePacket(pkt); }
        else r.fails++;
      } else r.fails++;
    }
    if (!anyOk) {
      if (++failStreak > 10) { needRelocate = true; failStreak = 0; }
    } else failStreak = 0;
  }

  function decodeRegion(r) {
    return cropAndDecode(proc, r.x, r.y, r.w, r.h);
  }

  function handlePacket(pkt) {
    if (pkt.isMeta) {
      try {
        var m = QRProtocol.parseMetaPayload(pkt.payload);
        if (m && m.v === 1 && typeof m.size === 'number' && m.chunks >= 0 && m.chunkSize > 0) {
          if (!meta || m.size !== meta.size || m.chunks !== meta.chunks) {
            /* 保留元数据到达前已收到的数据包（按索引回填） */
            var oldChunks = chunks, oldGot = gotCount;
            meta = m;
            chunks = new Array(m.chunks);
            received = new Uint8Array(m.chunks + 1);
            gotCount = 0;
            if (oldChunks && oldChunks.length === m.chunks) {
              for (var i = 0; i < oldChunks.length; i++) {
                if (oldChunks[i]) { chunks[i] = oldChunks[i]; received[i + 1] = 1; gotCount++; }
              }
            }
            speedWindow = [];
            if (gotCount === meta.chunks) finish();
          }
          if (m.chunks === 0) finish();
        }
      } catch (e) { console.error(e); }
      return;
    }
    lastTotal = pkt.total;   /* 元数据到达前即可估算总包数 */
    if (meta) {
      if (pkt.index < 1 || pkt.index > meta.chunks) return;
      if (received[pkt.index]) return;
      received[pkt.index] = 1; gotCount++;
      chunks[pkt.index - 1] = pkt.payload;
    } else {
      /* 元数据未到：先记账，等元数据到达后统一回填 */
      if (!received) { received = new Uint8Array(pkt.total + 1); chunks = new Array(pkt.total); }
      if (pkt.index >= 1 && pkt.index <= pkt.total && !received[pkt.index]) {
        received[pkt.index] = 1; gotCount++;
        chunks[pkt.index - 1] = pkt.payload;
      }
    }
    var now = performance.now();
    speedWindow.push({ t: now, b: pkt.payload.length });
    while (speedWindow.length && now - speedWindow[0].t > 5000) speedWindow.shift();
    if (meta && gotCount === meta.chunks) finish();
  }

  function finish() {
    var buf = QRProtocol.assemble(meta, chunks);
    if (!buf) { setStatus('组装失败，继续接收…'); return; }
    if (QRProtocol.crc32(buf) !== meta.crc32) { setStatus('校验失败，继续接收…'); return; }
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    resultBytes = buf; resultName = meta.name || 'received.bin';
    setStatus('✅ 接收完成：' + resultName + '（' + QRProtocol.fmtBytes(buf.length) + '），点下方按钮保存');
    $('btnDownload').style.display = 'inline-block';
    $('progressFill').style.width = '100%';
    $('progressText').textContent = QRProtocol.fmtBytes(buf.length) + ' / ' + QRProtocol.fmtBytes(meta.size) + ' · 100%';
    var bc = $('btnCam'); if (bc) bc.textContent = '📷 开启摄像头';
  }

  Receiver.download = function () {
    if (!resultBytes) return;
    var blob = new Blob([resultBytes], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = resultName || 'received.bin';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  };

  Receiver.relocate = function () { if (running) { needRelocate = true; lastRelocate = 0; } };

  function drawOverlay() {
    var wrap = $('previewWrap');
    if (!wrap || !video || !video.videoWidth || !proc) return;
    var bw = wrap.clientWidth, bh = wrap.clientHeight;
    if (!overlay) overlay = $('overlay');
    if (overlay.width !== bw || overlay.height !== bh) {
      overlay.width = bw; overlay.height = bh;
      octx = overlay.getContext('2d');
    }
    octx.clearRect(0, 0, bw, bh);
    var sx = bw / proc.width, sy = bh / proc.height;
    for (var i = 0; i < regions.length; i++) {
      var r = regions[i];
      octx.strokeStyle = r.fails > 3 ? '#ff5566' : (r.fails > 0 ? '#ffb020' : '#35c46a');
      octx.lineWidth = 2;
      octx.strokeRect(r.x * sx, r.y * sy, r.w * sx, r.h * sy);
      if (typeof r.cell === 'number') {
        octx.fillStyle = 'rgba(0,0,0,0.55)';
        octx.fillRect(r.x * sx, r.y * sy, 16, 14);
        octx.fillStyle = '#ffffff';
        octx.font = '10px sans-serif';
        octx.fillText(String(r.cell), r.x * sx + 3, r.y * sy + 11);
      }
    }
  }

  function updateUI() {
    if (meta && gotCount < meta.chunks) {
      var pct = meta.chunks ? gotCount / meta.chunks : 0;
      $('progressWrap').style.display = 'block';
      $('progressFill').style.width = (pct * 100).toFixed(1) + '%';
      var gotB = gotCount * meta.chunkSize;
      var eta = '';
      if (speedWindow.length >= 2) {
        var span = speedWindow[speedWindow.length - 1].t - speedWindow[0].t;
        var bytes = 0;
        for (var i = 0; i < speedWindow.length; i++) bytes += speedWindow[i].b;
        var rate = span > 0 ? bytes / (span / 1000) : 0;
        if (rate > 0) eta = ' · 剩余约 ' + QRProtocol.fmtTime(Math.max(0, meta.size - gotB) / rate);
      }
      $('progressText').textContent = QRProtocol.fmtBytes(gotB) + ' / ' + QRProtocol.fmtBytes(meta.size) +
        ' · ' + (pct * 100).toFixed(1) + '% · 解码 ' + stats.fps + ' FPS' + eta;
      setStatus('接收中：' + (meta.name || '') + '（' + QRProtocol.fmtBytes(meta.size) + '）');
    } else if (!meta && gotCount > 0 && lastTotal > 0) {
      /* 元数据未到：用包头 total 估算进度 */
      var p2 = Math.min(100, gotCount / lastTotal * 100);
      $('progressWrap').style.display = 'block';
      $('progressFill').style.width = p2.toFixed(1) + '%';
      $('progressText').textContent = '已接收 ' + gotCount + ' / ' + lastTotal + ' 包 · ' +
        p2.toFixed(1) + '% · 解码 ' + stats.fps + ' FPS（等待文件信息…）';
      setStatus('接收中：已锁定 ' + regions.length + ' 个码位（' + gotCount + '/' + lastTotal + ' 包）');
    } else if (!meta) {
      $('progressWrap').style.display = 'none';
    }
  }

  function setStatus(s) { var el = $('recvStatus'); if (el) el.textContent = s; }

  global.Receiver = Receiver;
})(typeof globalThis !== 'undefined' ? globalThis : this);
