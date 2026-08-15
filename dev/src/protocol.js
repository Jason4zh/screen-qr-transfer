/* ============================================================================
 * 屏码传 · 传输协议（纯逻辑，无 DOM 依赖）
 * ----------------------------------------------------------------------------
 * 帧结构：屏幕一帧 = 一排彩色边框（帧标识色）+ 2x2 / 3x2 的二维码阵列。
 * 每个二维码负载一个「数据包」：
 *   [0]    magic 0x53
 *   [1]    协议版本 0x01
 *   [2]    flags（bit0=元数据包）
 *   [3-6]  包序号 uint32 BE（0=元数据包；>=1 为数据包）
 *   [7-10] 总数据包数 uint32 BE
 *   [11-12] 负载长度 uint16 BE
 *   [13-16] 负载 CRC32 uint32 BE
 *   [17+]  负载：元数据包=JSON(UTF-8)；数据包=定长分块（末块以 size 截断）
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MAGIC = 0x53;
  var PROTO = 1;
  var HEADER_LEN = 17;

  /* L 纠错级别下各版本 Byte 模式容量（索引=版本号），与 qrcode-generator 实测一致 */
  var CAPACITY_L = [0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425,
    458, 520, 586, 644, 718, 792, 858, 929, 1003, 1091, 1171, 1273, 1367, 1465,
    1528, 1628, 1732, 1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953];

  /* ---------- CRC32 ---------- */
  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------- 字节序 ---------- */
  function readU16(buf, o) { return ((buf[o] << 8) | buf[o + 1]) >>> 0; }
  function writeU16(buf, o, v) { buf[o] = (v >>> 8) & 255; buf[o + 1] = v & 255; }
  function readU32(buf, o) {
    return ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
  }
  function writeU32(buf, o, v) {
    buf[o] = v >>> 24; buf[o + 1] = (v >>> 16) & 255; buf[o + 2] = (v >>> 8) & 255; buf[o + 3] = v & 255;
  }

  /* ---------- 包编解码 ---------- */
  function encodePacket(index, total, payload, isMeta) {
    var out = new Uint8Array(HEADER_LEN + payload.length);
    out[0] = MAGIC; out[1] = PROTO; out[2] = isMeta ? 1 : 0;
    writeU32(out, 3, index); writeU32(out, 7, total);
    writeU16(out, 11, payload.length);
    writeU32(out, 13, crc32(payload));
    out.set(payload, HEADER_LEN);
    return out;
  }

  function decodePacket(bytes) {
    if (!bytes || bytes.length < HEADER_LEN) return null;
    if (bytes[0] !== MAGIC || bytes[1] !== PROTO) return null;
    var len = readU16(bytes, 11);
    if (HEADER_LEN + len > bytes.length) return null;
    /* jsQR 的 binaryData 可能是 Array 或 TypedArray，统一为 Uint8Array */
    var payload = new Uint8Array(bytes.slice(HEADER_LEN, HEADER_LEN + len));
    if (crc32(payload) !== readU32(bytes, 13)) return null;
    return { isMeta: !!(bytes[2] & 1), index: readU32(bytes, 3), total: readU32(bytes, 7), payload: payload };
  }

  /* ---------- 分包 / 组包 ---------- */
  function packetize(fileBytes, name, chunkSize) {
    var n = fileBytes.length ? Math.ceil(fileBytes.length / chunkSize) : 0;
    var meta = {
      v: 1,
      name: String(name),
      size: fileBytes.length,
      chunks: n,
      chunkSize: chunkSize,
      crc32: crc32(fileBytes)
    };
    var metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    var packets = [encodePacket(0, n, metaBytes, true)];
    for (var i = 0; i < n; i++) {
      var start = i * chunkSize;
      var end = Math.min(start + chunkSize, fileBytes.length);
      var chunk = fileBytes.slice(start, end);
      var padded = new Uint8Array(chunkSize); /* 定长补齐 → 同屏二维码版本一致 */
      padded.set(chunk);
      packets.push(encodePacket(i + 1, n, padded, false));
    }
    return { packets: packets, meta: meta };
  }

  function assemble(meta, chunks) {
    if (!meta || !chunks) return null;
    var buf = new Uint8Array(meta.size);
    for (var i = 0; i < meta.chunks; i++) {
      var c = chunks[i];
      if (!c) return null;
      var start = i * meta.chunkSize;
      var real = Math.min(meta.chunkSize, meta.size - start);
      buf.set(c.subarray(0, real), start);
    }
    return buf;
  }

  /* ---------- 通用工具 ---------- */
  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
  }
  function fmtTime(sec) {
    sec = Math.round(sec);
    if (sec < 60) return sec + ' 秒';
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + ' 分 ' + s + ' 秒';
    return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 屏幕网格几何（发送端与接收端共用同一套公式） ----------
   * 布局：彩色边框(m) → 白色区域 → 3×2 二维码阵列（qrSize + gap 均匀网格）。
   * gap 比例为 0.2 是关键：保证 jsQR 在整帧搜索时能找到单个种子码。 */
  var GRID_COLS = 3, GRID_ROWS = 2;
  var GAP_RATIO = 0.2;

  function gridLayout(W, H) {
    var m = Math.max(18, Math.round(Math.min(W, H) * 0.02));
    var whiteW = W - 2 * m, whiteH = H - 2 * m;
    var qrSize = Math.floor(Math.min(whiteW / 3.4, whiteH / 2.4));
    var gap = Math.max(8, Math.round(qrSize * GAP_RATIO));
    for (var i = 0; i < 4; i++) {
      qrSize = Math.floor(Math.min((whiteW - 2 * gap) / 3, (whiteH - gap) / 2));
      gap = Math.max(8, Math.round(qrSize * GAP_RATIO));
    }
    var gridW = 3 * qrSize + 2 * gap, gridH = 2 * qrSize + gap;
    var ox = Math.round((whiteW - gridW) / 2), oy = Math.round((whiteH - gridH) / 2);
    var pitch = qrSize + gap;
    var cells = [];
    for (var r = 0; r < GRID_ROWS; r++) {
      for (var c = 0; c < GRID_COLS; c++) {
        cells.push({
          x: m + ox + c * pitch + qrSize / 2,
          y: m + oy + r * pitch + qrSize / 2
        });
      }
    }
    return { m: m, qrSize: qrSize, gap: gap, pitch: pitch, ox: ox, oy: oy, cells: cells };
  }

  /* 接收端：由 jsQR 找到的种子码推导网格几何 */
  function deriveGrid(seedQr) {
    var loc = seedQr.location;
    var pts = [loc.topLeftCorner, loc.topRightCorner, loc.bottomLeftCorner, loc.bottomRightCorner];
    var x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (var i = 0; i < pts.length; i++) {
      x0 = Math.min(x0, pts[i].x); y0 = Math.min(y0, pts[i].y);
      x1 = Math.max(x1, pts[i].x); y1 = Math.max(y1, pts[i].y);
    }
    var centerX = (x0 + x1) / 2, centerY = (y0 + y1) / 2;
    var mods = seedQr.version * 4 + 17;
    var locW = Math.max(x1 - x0, y1 - y0);
    var px = locW / mods;
    var qrSize = locW + 8 * px;          /* 含两侧各 4 模块静区 */
    var gap = Math.max(8, Math.round(qrSize * GAP_RATIO));
    return { centerX: centerX, centerY: centerY, qrSize: qrSize, gap: gap, pitch: qrSize + gap };
  }

  /* 候选偏移：以种子为中心覆盖 3×2 网格全部可能位置 */
  function candidateOffsets() {
    var out = [];
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -2; dx <= 2; dx++) out.push([dx, dy]);
    }
    return out;
  }

  var api = {
    MAGIC: MAGIC, PROTO: PROTO, HEADER_LEN: HEADER_LEN, CAPACITY_L: CAPACITY_L,
    crc32: crc32, encodePacket: encodePacket, decodePacket: decodePacket,
    packetize: packetize, assemble: assemble,
    fmtBytes: fmtBytes, fmtTime: fmtTime, esc: esc,
    GRID_COLS: GRID_COLS, GRID_ROWS: GRID_ROWS, GAP_RATIO: GAP_RATIO,
    gridLayout: gridLayout, deriveGrid: deriveGrid, candidateOffsets: candidateOffsets
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.QRProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
