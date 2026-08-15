/* ============================================================================
 * 屏码传 · 传输协议（纯逻辑，无 DOM 依赖）
 * ----------------------------------------------------------------------------
 * 帧结构：屏幕一帧 = 一排彩色边框（帧标识色）+ 3×2 的二维码阵列。
 * 每个二维码负载一个「数据包」：
 *   [0]    magic 0x53
 *   [1]    协议版本 0x02
 *   [2]    flags（bit0=元数据包）
 *   [3]    cell：该包当前显示所在码位（0-5），发送端逐帧按槽位改写；
 *          接收端用它建立「码位 ↔ 屏幕位置」对应关系，抗透视/偏移
 *   [4-7]  包序号 uint32 BE（0=元数据包；>=1 为数据包）
 *   [8-11] 总数据包数 uint32 BE
 *   [12-13] 负载长度 uint16 BE
 *   [14-17] 负载 CRC32 uint32 BE
 *   [18+]  负载：元数据包=JSON(UTF-8)；数据包=定长分块（末块以 size 截断）
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MAGIC = 0x53;
  var PROTO = 2;
  var HEADER_LEN = 18;

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
  /* cell：该包当前显示所在码位（0-5），发送端渲染前按槽位改写 byte[3] */
  function encodePacket(index, total, payload, isMeta, cell) {
    var out = new Uint8Array(HEADER_LEN + payload.length);
    out[0] = MAGIC; out[1] = PROTO; out[2] = isMeta ? 1 : 0;
    out[3] = cell || 0;
    writeU32(out, 4, index); writeU32(out, 8, total);
    writeU16(out, 12, payload.length);
    writeU32(out, 14, crc32(payload));
    out.set(payload, HEADER_LEN);
    return out;
  }

  function decodePacket(bytes) {
    if (!bytes || bytes.length < HEADER_LEN) return null;
    if (bytes[0] !== MAGIC || bytes[1] !== PROTO) return null;
    var len = readU16(bytes, 12);
    if (HEADER_LEN + len > bytes.length) return null;
    /* jsQR 的 binaryData 可能是 Array 或 TypedArray，统一为 Uint8Array */
    var payload = new Uint8Array(bytes.slice(HEADER_LEN, HEADER_LEN + len));
    if (crc32(payload) !== readU32(bytes, 14)) return null;
    return {
      isMeta: !!(bytes[2] & 1),
      cell: bytes[3] & 255,
      index: readU32(bytes, 4),
      total: readU32(bytes, 8),
      payload: payload
    };
  }

  /* ---------- 分包 / 组包 ----------
   * 数据包与元数据包都补齐为 chunkSize 负载（元数据以 \0 结尾）：
   * 同屏所有二维码同一版本、同一绘制尺寸，接收端几何推导精确。 */
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
    var metaPadded = new Uint8Array(chunkSize);
    metaPadded.set(metaBytes);
    /* \0 结尾标记（JSON 字符串不会含裸 \0），接收端截取到首个 \0 */
    var packets = [encodePacket(0, n, metaPadded, true, 0)];
    for (var i = 0; i < n; i++) {
      var start = i * chunkSize;
      var end = Math.min(start + chunkSize, fileBytes.length);
      var chunk = fileBytes.slice(start, end);
      var padded = new Uint8Array(chunkSize);
      padded.set(chunk);
      packets.push(encodePacket(i + 1, n, padded, false, 0));
    }
    return { packets: packets, meta: meta };
  }

  /* 解析元数据负载（截取到首个 \0） */
  function parseMetaPayload(payload) {
    var end = payload.length;
    for (var i = 0; i < payload.length; i++) {
      if (payload[i] === 0) { end = i; break; }
    }
    return JSON.parse(new TextDecoder().decode(payload.subarray(0, end)));
  }

  /* 发送端布局参数：由屏幕尺寸 + 目标模块像素 + 版本上限计算
   * 整数模块像素 px（模块均匀、jsQR 解码稳定）+ 版本 + 绘制尺寸 + 分包大小。
   * px 目标值（标准 4 / 高速 3）会随屏幕过小而自动下调。 */
  function computeLayoutParams(W, H, maxVersion, targetPx) {
    var m = Math.max(18, Math.round(Math.min(W, H) * 0.02));
    var whiteW = W - 2 * m, whiteH = H - 2 * m;
    var px = targetPx || 4, ver = 0;
    for (px = (targetPx || 4); px >= 2; px--) {
      var maxTotal = Math.floor(Math.min(whiteW / ((GRID_COLS + (GRID_COLS - 1) * GAP_RATIO) * px),
        whiteH / ((GRID_ROWS + (GRID_ROWS - 1) * GAP_RATIO) * px)));
      ver = Math.floor((maxTotal - 25) / 4);
      if (ver >= 1) break;
    }
    ver = Math.max(1, Math.min(ver, maxVersion));
    var total = ver * 4 + 17 + 8;
    px = Math.max(2, Math.floor(Math.min(whiteW / ((GRID_COLS + (GRID_COLS - 1) * GAP_RATIO) * total),
      whiteH / ((GRID_ROWS + (GRID_ROWS - 1) * GAP_RATIO) * total))));
    var qrDrawn = px * total;
    var chunkSize = Math.max(64, CAPACITY_L[ver] - HEADER_LEN - 4);
    return { px: px, version: ver, total: total, qrDrawn: qrDrawn, chunkSize: chunkSize };
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
   * 布局：彩色边框(m) → 白色区域 → 3×2 二维码阵列。
   * qrDrawn 为各码实际绘制边长（= 整数模块像素 × 总模块数，保证模块均匀、
   * jsQR 解码稳定）；间距 gap = 12% × qrDrawn（jsQR 多码补丁后在
   * 0.10~0.12 间距下种子搜索仍 6/6，更小间距显著提升单帧容量）。
   * 所有包（含元数据）补齐为相同负载 → 全屏同一版本 → 尺寸统一可推导。 */
  var GRID_COLS = 3, GRID_ROWS = 2;
  var GAP_RATIO = 0.12;

  function gridLayout(W, H, qrDrawn) {
    var m = Math.max(18, Math.round(Math.min(W, H) * 0.02));
    var gap = Math.max(8, Math.round(qrDrawn * GAP_RATIO));
    var gridW = GRID_COLS * qrDrawn + (GRID_COLS - 1) * gap;
    var gridH = GRID_ROWS * qrDrawn + (GRID_ROWS - 1) * gap;
    var ox = Math.round((W - 2 * m - gridW) / 2);
    var oy = Math.round((H - 2 * m - gridH) / 2);
    var pitch = qrDrawn + gap;
    var cells = [];
    for (var r = 0; r < GRID_ROWS; r++) {
      for (var c = 0; c < GRID_COLS; c++) {
        cells.push({
          x: m + ox + c * pitch + qrDrawn / 2,
          y: m + oy + r * pitch + qrDrawn / 2
        });
      }
    }
    return { m: m, qrDrawn: qrDrawn, gap: gap, pitch: pitch, ox: ox, oy: oy, cells: cells };
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

  /* 码位 → 网格坐标（单位=格距） */
  function cellModel(cell) {
    return { u: cell % GRID_COLS, v: Math.floor(cell / GRID_COLS) };
  }

  /* 求解 3×3 线性方程组（Cramer 法则） */
  function solve3(m, b) {
    var det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (Math.abs(det) < 1e-9) return null;
    function detCol(j) {
      var mm = [m[0].slice(), m[1].slice(), m[2].slice()];
      mm[0][j] = b[0]; mm[1][j] = b[1]; mm[2][j] = b[2];
      return mm[0][0] * (mm[1][1] * mm[2][2] - mm[1][2] * mm[2][1]) -
        mm[0][1] * (mm[1][0] * mm[2][2] - mm[1][2] * mm[2][0]) +
        mm[0][2] * (mm[1][0] * mm[2][1] - mm[1][1] * mm[2][0]);
    }
    return [detCol(0) / det, detCol(1) / det, detCol(2) / det];
  }

  /* 仿射拟合：由「码位 ↔ 相机中心」对应关系拟合 cell 坐标 → 相机像素的变换。
   * 最少 3 个非共线对应点；返回 null 表示退化（改用均匀网格）。 */
  function fitAffine(correspondences) {
    var n = correspondences.length;
    if (n < 3) return null;
    var su = 0, sv = 0, suu = 0, svv = 0, suv = 0;
    var sx = 0, sux = 0, svx = 0, sy = 0, suy = 0, svy = 0;
    for (var i = 0; i < n; i++) {
      var m = cellModel(correspondences[i].cell);
      var u = m.u, v = m.v;
      var x = correspondences[i].x, y = correspondences[i].y;
      su += u; sv += v; suu += u * u; svv += v * v; suv += u * v;
      sx += x; sux += u * x; svx += v * x;
      sy += y; suy += u * y; svy += v * y;
    }
    var M = [[suu, suv, su], [suv, svv, sv], [su, sv, n]];
    var px = solve3(M, [sux, svx, sx]);
    var py = solve3(M, [suy, svy, sy]);
    if (!px || !py) return null;
    var a = px[0], b = px[1], c = px[2];
    var d = py[0], e = py[1], f = py[2];
    return {
      apply: function (cell) {
        var m2 = cellModel(cell);
        return { x: a * m2.u + b * m2.v + c, y: d * m2.u + e * m2.v + f };
      },
      /* 单位格距在相机像素中的尺度（用于裁剪尺寸） */
      scale: (Math.sqrt(a * a + d * d) + Math.sqrt(b * b + e * e)) / 2
    };
  }

  var api = {
    MAGIC: MAGIC, PROTO: PROTO, HEADER_LEN: HEADER_LEN, CAPACITY_L: CAPACITY_L,
    crc32: crc32, encodePacket: encodePacket, decodePacket: decodePacket,
    packetize: packetize, assemble: assemble, parseMetaPayload: parseMetaPayload,
    fmtBytes: fmtBytes, fmtTime: fmtTime, esc: esc,
    GRID_COLS: GRID_COLS, GRID_ROWS: GRID_ROWS, GAP_RATIO: GAP_RATIO,
    gridLayout: gridLayout, deriveGrid: deriveGrid, candidateOffsets: candidateOffsets,
    cellModel: cellModel, fitAffine: fitAffine, computeLayoutParams: computeLayoutParams
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.QRProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
