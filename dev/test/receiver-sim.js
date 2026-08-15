/* 接收端全链路仿真（协议 v2）：
 * - 发送端行为：cell 字节按槽位改写、洗牌、元数据填充空槽位/每 12 帧插槽 0
 * - 接收端行为：整帧种子 → 候选扫描收集「码位↔位置」对应 → 仿射拟合 →
 *               逐格验证锁定 → 区域跟踪解码 → 包收集 → 重组校验
 * - 场景：正对屏幕、3% 透视畸变、小文件（空槽位由元数据填充）
 */
'use strict';
const qrcode = require('../lib/qrcode.js');
const jsQR = require('../lib/jsqr.js');
const Proto = require('../src/protocol.js');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

const PALETTE = [[229, 57, 53], [67, 160, 71], [30, 136, 229], [253, 216, 53]];

function toBinaryString(bytes) {
  let s = '', CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return s;
}
function makeQr(bytes) {
  const qr = qrcode(0, 'L');
  qr.addData(toBinaryString(bytes), 'Byte');
  qr.make();
  return qr;
}
/* 发送端：克隆包并改写 cell 字节（byte[3]=槽位） */
function patchCell(pkt, slot) {
  const q = new Uint8Array(pkt);
  q[3] = slot;
  return q;
}

/* 发送端渲染：整数模块像素（px）+ 统一绘制尺寸（所有包同版本） */
function renderFrame(payloads, W, H, frameNo, L, px) {
  const data = new Uint8ClampedArray(W * H * 4);
  const bg = PALETTE[frameNo % 4];
  for (let i = 0; i < data.length; i += 4) { data[i] = bg[0]; data[i + 1] = bg[1]; data[i + 2] = bg[2]; data[i + 3] = 255; }
  const m = L.m;
  for (let y = m; y < m + H - 2 * m; y++) for (let x = m; x < m + W - 2 * m; x++) {
    const o = (y * W + x) * 4; data[o] = data[o + 1] = data[o + 2] = 255;
  }
  const quiet = 4;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
    const p = payloads[r * 3 + c];
    if (p == null) continue;
    const cell = L.cells[r * 3 + c];
    const qr = makeQr(p), mods = qr.getModuleCount();
    const qrDrawn = px * (mods + 8);       /* 整数模块像素 → 模块均匀 */
    const x0 = Math.round(cell.x - qrDrawn / 2), y0 = Math.round(cell.y - qrDrawn / 2);
    for (let mm = 0; mm < mods; mm++) for (let nn = 0; nn < mods; nn++) {
      if (qr.isDark(mm, nn)) {
        const X0 = x0 + (nn + quiet) * px, Y0 = y0 + (mm + quiet) * px;
        for (let dy = 0; dy < px; dy++) for (let dx = 0; dx < px; dx++) {
          const X = X0 + dx, Y = Y0 + dy;
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const o = (Y * W + X) * 4; data[o] = data[o + 1] = data[o + 2] = 0;
        }
      }
    }
  }
  return { data, width: W, height: H };
}

/* 透视变形：四边形映射（模拟手机斜对屏幕），白底 */
function warp(src, sw, sh, dstW, dstH, corners) {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = 255; out[i + 1] = 255; out[i + 2] = 255; out[i + 3] = 255; }
  const [tl, tr, br, bl] = corners;
  for (let y = 0; y < dstH; y++) for (let x = 0; x < dstW; x++) {
    const ux = x / dstW, uy = y / dstH;
    const topX = tl[0] + (tr[0] - tl[0]) * ux, topY = tl[1] + (tr[1] - tl[1]) * ux;
    const botX = bl[0] + (br[0] - bl[0]) * ux, botY = bl[1] + (br[1] - bl[1]) * ux;
    const px = topX + (botX - topX) * uy, py = topY + (botY - topY) * uy;
    const sx = Math.min(sw - 1, Math.max(0, Math.round(px))), sy = Math.min(sh - 1, Math.max(0, Math.round(py)));
    const so = (sy * sw + sx) * 4, do_ = (y * dstW + x) * 4;
    out[do_] = src[so]; out[do_ + 1] = src[so + 1]; out[do_ + 2] = src[so + 2]; out[do_ + 3] = 255;
  }
  return { data: out, width: dstW, height: dstH };
}

function crop(img, x, y, w, h) {
  const cx = Math.max(0, Math.round(x)), cy = Math.max(0, Math.round(y));
  const cw = Math.min(w, img.width - cx), ch = Math.min(h, img.height - cy);
  if (cw < 40 || ch < 40) return null;
  const d = new Uint8ClampedArray(cw * ch * 4);
  for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < cw; xx++) {
    const so = ((cy + yy) * img.width + (cx + xx)) * 4, do_ = (yy * cw + xx) * 4;
    d[do_] = img.data[so]; d[do_ + 1] = img.data[so + 1]; d[do_ + 2] = img.data[so + 2]; d[do_ + 3] = 255;
  }
  return { data: d, width: cw, height: ch };
}

function addNoise(img, pct) {
  const n = img.data.length / 4;
  for (let i = 0; i < n * pct; i++) {
    const o = ((Math.random() * n) | 0) * 4;
    const v = Math.random() < 0.5 ? 0 : 255;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
  }
}

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

/* 接收端定位（与 receiver.js 同算法）：返回区域列表 */
function locate(img, handlePkt) {
  const W = img.width, H = img.height;
  const corr = [], sizes = [];
  function addCorr(qr, ox, oy) {
    const pkt = Proto.decodePacket(qr.binaryData);
    if (!pkt) return;
    const dg = Proto.deriveGrid(qr);
    corr.push({ cell: pkt.cell, x: dg.centerX + ox, y: dg.centerY + oy, size: dg.qrSize });
    sizes.push(dg.qrSize);
    if (handlePkt) handlePkt(pkt);
  }
  let g = null;
  /* 阶段 A：整帧种子 + 均匀网格候选扫描（宽容裁剪） */
  const seed = jsQR(img.data, W, H);
  if (seed) {
    addCorr(seed, 0, 0);
    g = Proto.deriveGrid(seed);
    const side = Math.round(g.qrSize * 1.3);
    const half = side / 2;
    for (const [dx, dy] of Proto.candidateOffsets()) {
      const cx = g.centerX + dx * g.pitch, cy = g.centerY + dy * g.pitch;
      if (cx - half < 0 || cy - half < 0 || cx + half > W || cy + half > H) continue;
      const rx = Math.round(cx - half), ry = Math.round(cy - half);
      const t = crop(img, rx, ry, side, side);
      if (!t) continue;
      const r = jsQR(t.data, t.width, t.height);
      if (r && r.binaryData) addCorr(r, rx, ry);
    }
  }
  /* 阶段 B（兜底）：半帧大瓦片扫描（≥ 单码尺寸，保证整码落入） */
  if (corr.length < 3) {
    const tw = Math.floor(W / 2), th = Math.floor(H / 2);
    const xstep = Math.floor(tw / 2), ystep = Math.floor(th / 2);
    const nx = Math.ceil((W - tw) / xstep) + 1, ny = Math.ceil((H - th) / ystep) + 1;
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
      const x = Math.min(W - tw, Math.round(c * xstep));
      const y = Math.min(H - th, Math.round(r * ystep));
      const t = crop(img, x, y, tw, th);
      if (!t) continue;
      const qr = jsQR(t.data, t.width, t.height);
      if (qr && qr.binaryData) {
        const pkt = Proto.decodePacket(qr.binaryData);
        if (pkt) {
          const dg = Proto.deriveGrid(qr);
          corr.push({ cell: pkt.cell, x: dg.centerX + x, y: dg.centerY + y, size: dg.qrSize });
          sizes.push(dg.qrSize);
        }
      }
    }
  }
  if (!corr.length) return [];
  /* 阶段 C：仿射拟合 + 逐格验证 */
  const medSize = median(sizes) || (g ? g.qrSize : 320);
  const T = corr.length >= 3 ? Proto.fitAffine(corr) : null;
  const found = [];
  if (T) {
    /* 验证裁剪：比码略大（容纳透视残差）但小于码距（避免含入邻码） */
    const cside = Math.round(medSize * 1.06);
    for (let cellId = 0; cellId < 6; cellId++) {
      const pos = T.apply(cellId);
      const chalf = cside / 2;
      if (pos.x + cside < 0 || pos.y + cside < 0 || pos.x - cside > W || pos.y - cside > H) continue;
      const rx = Math.round(pos.x - chalf), ry = Math.round(pos.y - chalf);
      const t2 = crop(img, rx, ry, cside, cside);
      if (!t2) continue;
      const r2 = jsQR(t2.data, t2.width, t2.height);
      if (r2 && r2.binaryData) {
        const pkt2 = Proto.decodePacket(r2.binaryData);
        if (pkt2 && pkt2.cell === cellId) {
          const dg2 = Proto.deriveGrid(r2);
          const rs = Math.round(dg2.qrSize + 8);
          found.push({ cell: cellId, x: Math.round(dg2.centerX + rx - rs / 2), y: Math.round(dg2.centerY + ry - rs / 2), w: rs, h: rs });
          if (handlePkt) handlePkt(pkt2);
        }
      }
    }
  } else {
    const seen = {};
    for (const c of corr) {
      if (seen[c.cell]) continue;
      seen[c.cell] = true;
      const h2 = c.size / 2 + 4;
      found.push({ cell: c.cell, x: Math.round(c.x - h2), y: Math.round(c.y - h2), w: Math.round(c.size + 8), h: Math.round(c.size + 8) });
    }
  }
  return found;
}

/* 传输会话：布局与分块统一由 computeLayoutParams 决定（与 sender.js 一致） */
function session(fileBytes, opts) {
  const W = opts.W || 1280, H = opts.H || 853;
  const P = Proto.computeLayoutParams(W, H, opts.maxVersion || 29, opts.px || 4);
  const L = Proto.gridLayout(W, H, P.qrDrawn);
  const px = P.px;
  const chunkSize = P.chunkSize;
  const fecN = opts.fecN === 0 ? 0 : (opts.fecN || Proto.FEC_DEFAULT_N);
  const { packets, meta } = Proto.packetize(fileBytes, 'sim.bin', chunkSize, fecN, 0);

  const order = [];
  for (let i = 1; i < packets.length; i++) order.push(i);   /* 数据 + FEC 奇偶 */
  let pos = 0;
  function reshuffle() {
    for (let j = order.length - 1; j > 0; j--) { const k = (Math.random() * (j + 1)) | 0; const t = order[j]; order[j] = order[k]; order[k] = t; }
    pos = 0;
  }

  const chunks = new Array(meta.chunks);
  let got = 0, frames = 0, metaSeen = false, regions = [];
  /* FEC 分块接收（与 receiver.js 同算法） */
  const info = Proto.fecBlockInfo(meta);
  const blockData = new Array(Math.max(1, info.blocks)), blockParity = new Array(Math.max(1, info.blocks));
  const blockHave = new Array(Math.max(1, info.blocks)).fill(0), blockDone = new Uint8Array(Math.max(1, info.blocks));
  for (let b = 0; b < info.blocks; b++) {
    blockData[b] = new Array(info.dataCount(b)).fill(null);
    blockParity[b] = new Array(info.K).fill(null);
  }
  function tryDecodeBlock(b) {
    if (blockDone[b]) return;
    const count = info.dataCount(b);
    const present = [];
    for (let i = 0; i < count; i++) if (blockData[b][i]) {
      const r = new Array(count).fill(0); r[i] = 1;
      present.push({ row: r, symbols: blockData[b][i] });
    }
    const prs = Proto.fecParityRows(count, info.K);
    for (let p2 = 0; p2 < info.K; p2++) if (blockParity[b][p2]) present.push({ row: prs[p2], symbols: blockParity[b][p2] });
    if (present.length < count) return;
    const rec = Proto.fecDecode(present, count);
    if (!rec) return;
    blockDone[b] = 1;
    const base = b * meta.fecN;
    for (let i = 0; i < count; i++) if (!chunks[base + i]) { chunks[base + i] = rec[i]; got++; }
  }
  const handlePkt = (pkt) => {
    if (pkt.isMeta) { metaSeen = true; return; }
    if (info.blocks === 0) {
      if (pkt.isParity) return;
      if (pkt.index >= 1 && pkt.index <= meta.chunks && !chunks[pkt.index - 1]) {
        chunks[pkt.index - 1] = pkt.payload; got++;
      }
      return;
    }
    let b, ppos;
    if (!pkt.isParity) {
      b = Math.floor((pkt.index - 1) / meta.fecN); ppos = (pkt.index - 1) % meta.fecN;
      if (blockData[b][ppos]) return;
      blockData[b][ppos] = pkt.payload; blockHave[b]++;
    } else {
      const pp = pkt.index - meta.chunks - 1;
      if (pp < 0 || info.K <= 0) return;
      b = Math.floor(pp / info.K); ppos = pp % info.K;
      if (blockParity[b][ppos]) return;
      blockParity[b][ppos] = pkt.payload; blockHave[b]++;
    }
    if (blockHave[b] >= info.dataCount(b)) tryDecodeBlock(b);
  };

  const maxFrames = opts.maxFrames || 300;
  for (frames = 0; frames < maxFrames && (got < meta.chunks || !metaSeen); frames++) {
    /* 槽位（与 sender.js 一致）：元数据每 4 帧轮换码位（无独占码位）；
     * 队列耗尽重建；小文件剩余槽位填元数据 */
    const slots = new Array(6).fill(null);
    if (frames % 4 === 0) slots[Math.floor(frames / 4) % 6] = 0;
    for (let i = 0; i < 6; i++) {
      if (slots[i] !== null) continue;
      if (order.length === 0 || pos >= order.length) reshuffle();
      if (pos < order.length) { slots[i] = order[pos++]; }
      else { slots[i] = 0; }
    }
    /* 失败模型：opts.failCell 为持续失败码位（反光/遮挡）；否则每帧随机丢一个码位 */
    const failCell = (typeof opts.failCell === 'number') ? opts.failCell : ((Math.random() * 6) | 0);
    const payloads = slots.map((ix, cell) => (cell === failCell || ix == null) ? null : patchCell(packets[ix], cell));
    let img = renderFrame(payloads, W, H, frames % 4, L, px);
    if (opts.warp) img = warp(img.data, W, H, opts.warp.dstW, opts.warp.dstH, opts.warp.corners);
    addNoise(img, 0.002);

    if (frames % 10 === 0 || frames === 0) {
      regions = locate(img, handlePkt);
    }
    for (const rg of regions) {
      const t = crop(img, rg.x, rg.y, rg.w, rg.h);
      if (!t) continue;
      const qr = jsQR(t.data, t.width, t.height);
      if (!qr) continue;
      const pkt = Proto.decodePacket(qr.binaryData);
      if (!pkt) continue;
      handlePkt(pkt);
    }
  }
  return { frames, got, metaSeen, chunks, meta, regions, fileBytes };
}

/* ---------- 测试主体 ---------- */
console.log('== 场景 1：正对屏幕，常规文件（40KB） ==');
{
  const fileBytes = new Uint8Array(40000);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 131 + 9) & 255;
  const r = session(fileBytes, { maxFrames: 300 });
  ok(r.got === r.meta.chunks, `历经 ${r.frames} 帧收齐 ${r.meta.chunks} 包`);
  ok(r.metaSeen, '元数据已收到');
  const assembled = Proto.assemble(r.meta, r.chunks);
  ok(assembled && Proto.crc32(assembled) === r.meta.crc32 &&
     Buffer.compare(Buffer.from(assembled), Buffer.from(r.fileBytes)) === 0, '整文件 CRC 校验一致');
}

console.log('\n== 场景 2：正对屏幕，小文件（1.5KB，空槽位由元数据填充） ==');
{
  const fileBytes = new Uint8Array(1500);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 53 + 7) & 255;
  const r = session(fileBytes, { maxFrames: 60 });
  console.log(`  码位锁定 ${r.regions.length}/6（空槽位已由元数据填充，部分锁定也可完成传输）`);
  ok(r.got === r.meta.chunks, `历经 ${r.frames} 帧收齐 ${r.meta.chunks} 包`);
  ok(r.metaSeen, '元数据已收到');
  const assembled = Proto.assemble(r.meta, r.chunks);
  ok(assembled && Proto.crc32(assembled) === r.meta.crc32 &&
     Buffer.compare(Buffer.from(assembled), Buffer.from(r.fileBytes)) === 0, '整文件 CRC 校验一致');
  console.log(`  帧数=${r.frames}（1.5KB 应数秒内完成）`);
}

console.log('\n== 场景 3：3% 透视畸变（模拟手机斜对屏幕） ==');
{
  const fileBytes = new Uint8Array(40000);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 97 + 3) & 255;
  const r = session(fileBytes, {
    maxFrames: 300,
    warp: { dstW: 1240, dstH: 840, corners: [[20, 30], [1220, 20], [1235, 810], [30, 830]] }
  });
  console.log(`  透视下码位锁定 ${r.regions.length}/6（部分锁定也能完成传输）`);
  ok(r.got === r.meta.chunks, `透视下历经 ${r.frames} 帧收齐 ${r.meta.chunks} 包`);
  const assembled = Proto.assemble(r.meta, r.chunks);
  ok(assembled && Proto.crc32(assembled) === r.meta.crc32 &&
     Buffer.compare(Buffer.from(assembled), Buffer.from(r.fileBytes)) === 0, '透视下整文件 CRC 校验一致');
}

console.log('\n== 场景 4：数据包头 total 支撑元数据前的进度估算 ==');
{
  const fileBytes = new Uint8Array(5000);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 11 + 5) & 255;
  const { packets } = Proto.packetize(fileBytes, 'p.bin', 404);
  const d = Proto.decodePacket(packets[1]);
  ok(d && d.total === Math.ceil(5000 / 404), `数据包头携带 total=${d.total}，元数据前即可估算进度`);
}

console.log('\n== 场景 5：高速档（1920×1080，px=3，v33） ==');
{
  const fileBytes = new Uint8Array(300000);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 61 + 11) & 255;
  const r = session(fileBytes, { W: 1920, H: 1080, maxVersion: 33, px: 3, maxFrames: 200 });
  const P = Proto.computeLayoutParams(1920, 1080, 33, 3);
  console.log(`  布局: px=${P.px} v${P.version} qrDrawn=${P.qrDrawn} chunk=${P.chunkSize}（单帧 ≈${(P.chunkSize * 6 / 1024).toFixed(1)}KB，含 FEC 奇偶）`);
  ok(r.got === r.meta.chunks && r.metaSeen, `高速档 ${r.frames} 帧收齐 ${r.meta.chunks} 块`);
  const assembled = Proto.assemble(r.meta, r.chunks);
  ok(assembled && Proto.crc32(assembled) === r.meta.crc32 &&
     Buffer.compare(Buffer.from(assembled), Buffer.from(r.fileBytes)) === 0, '高速档整文件 CRC 校验一致');
}

console.log('\n== 场景 6：0 号码位持续失败（反光/遮挡）——轮换元数据防卡死 ==');
{
  const fileBytes = new Uint8Array(40000);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 73 + 19) & 255;
  const r = session(fileBytes, { maxFrames: 300, failCell: 0 });
  ok(r.got === r.meta.chunks, `0 号码位持续失败仍收齐 ${r.meta.chunks} 包（${r.frames} 帧）`);
  ok(r.metaSeen, '元数据经轮换码位到达（不再卡死）');
  const assembled = Proto.assemble(r.meta, r.chunks);
  ok(assembled && Proto.crc32(assembled) === r.meta.crc32 &&
     Buffer.compare(Buffer.from(assembled), Buffer.from(r.fileBytes)) === 0, '整文件 CRC 校验一致');
  console.log(`  帧数=${r.frames}`);
}

console.log('\n== 场景 7：FEC 消除尾部拖尾（100KB + 持续失败码位） ==');
{
  const fileBytes = new Uint8Array(100000);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 43 + 17) & 255;
  const rFec = session(fileBytes, { maxFrames: 300, failCell: 1, fecN: Proto.FEC_DEFAULT_N });
  const rNoFec = session(fileBytes, { maxFrames: 300, failCell: 1, fecN: 0 });
  ok(rFec.got === rFec.meta.chunks && rFec.metaSeen, `FEC：${rFec.frames} 帧完成（无需 100% 收齐）`);
  ok(rNoFec.got === rNoFec.meta.chunks && rNoFec.metaSeen, `无 FEC：${rNoFec.frames} 帧完成（尾部等下一轮循环补包）`);
  console.log(`  对比：FEC ${rFec.frames} 帧 vs 无 FEC ${rNoFec.frames} 帧（大文件时差距更大——每轮循环耗时数十秒）`);
}

console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
