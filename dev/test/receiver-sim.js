/* 接收端全链路仿真：发送端真实帧序列（含彩色边框/洗牌/元数据插入）→ 位图渲染，
 * 接收端算法：整帧 jsQR 找种子 → 推导 3×2 网格 → 候选紧裁剪解码 → 区域跟踪 →
 * 包收集 → 重组校验。含噪点与随机丢码位，验证丢帧恢复能力。 */
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

/* 发送端渲染：彩色边框 + 白色区域 + 3×2 网格（与 sender.js 同公式） */
function renderFrame(payloads, W, H, frameNo, L) {
  const data = new Uint8ClampedArray(W * H * 4);
  const bg = PALETTE[frameNo % 4];
  for (let i = 0; i < data.length; i += 4) { data[i] = bg[0]; data[i + 1] = bg[1]; data[i + 2] = bg[2]; data[i + 3] = 255; }
  const m = L.m;
  for (let y = m; y < m + H - 2 * m; y++) for (let x = m; x < m + W - 2 * m; x++) {
    const o = (y * W + x) * 4; data[o] = data[o + 1] = data[o + 2] = 255;
  }
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
    const p = payloads[r * 3 + c];
    if (p == null) continue;
    const cell = L.cells[r * 3 + c];
    const qr = makeQr(p), mods = qr.getModuleCount();
    const scale = L.qrSize / (mods + 8);
    const x0 = Math.round(cell.x - L.qrSize / 2), y0 = Math.round(cell.y - L.qrSize / 2);
    for (let mm = 0; mm < mods; mm++) for (let nn = 0; nn < mods; nn++) {
      if (qr.isDark(mm, nn)) {
        const X0 = x0 + Math.round((nn + 4) * scale), Y0 = y0 + Math.round((mm + 4) * scale);
        const X1 = x0 + Math.round((nn + 5) * scale), Y1 = y0 + Math.round((mm + 5) * scale);
        for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) {
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const o = (Y * W + X) * 4; data[o] = data[o + 1] = data[o + 2] = 0;
        }
      }
    }
  }
  return { data, width: W, height: H };
}

function crop(img, x, y, w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const so = ((y + yy) * img.width + (x + xx)) * 4, do_ = (yy * w + xx) * 4;
    d[do_] = img.data[so]; d[do_ + 1] = img.data[so + 1]; d[do_ + 2] = img.data[so + 2]; d[do_ + 3] = 255;
  }
  return { data: d, width: w, height: h };
}

function addNoise(img, pct) {
  const n = img.data.length / 4;
  for (let i = 0; i < n * pct; i++) {
    const o = ((Math.random() * n) | 0) * 4;
    const v = Math.random() < 0.5 ? 0 : 255;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
  }
}

/* ---------- 测试主体 ---------- */
console.log('== 流式多帧传输仿真（噪点 + 随机丢码位 + 周期性重新定位） ==');
{
  const fileBytes = new Uint8Array(25000);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 131 + 9) & 255;
  const chunkSize = 404;
  const { packets, meta } = Proto.packetize(fileBytes, 'stream-sim.bin', chunkSize);
  const W = 1280, H = 853;
  const L = Proto.gridLayout(W, H);
  ok(L.qrSize > 250 && L.gap >= 40, `布局合理 qrSize=${L.qrSize} gap=${L.gap}（jsQR 多码可检测的间距）`);

  /* 发送端行为：洗牌窗口 + 每 24 帧在槽 0 插入元数据 */
  const order = [];
  for (let i = 1; i <= meta.chunks; i++) order.push(i);
  let pos = 0;
  function reshuffle() {
    for (let j = order.length - 1; j > 0; j--) { const k = (Math.random() * (j + 1)) | 0; const t = order[j]; order[j] = order[k]; order[k] = t; }
    pos = 0;
  }

  const chunks = new Array(meta.chunks);
  const received = new Uint8Array(meta.chunks + 1);
  let got = 0, frames = 0, relocates = 0, metaSeen = false;
  let regions = [];

  for (frames = 0; frames < 300 && got < meta.chunks; frames++) {
    /* 构造本帧槽位 */
    const slots = new Array(6).fill(null);
    if (frames % 24 === 0) slots[0] = 0;
    for (let i = 0; i < 6; i++) {
      if (slots[i] !== null) continue;
      if (pos >= order.length) reshuffle();
      slots[i] = order[pos++];
    }
    /* 随机丢一个码位（模拟某区域连续失败） */
    const dropCell = (Math.random() * 6) | 0;
    const payloads = slots.map((ix, cell) => (cell === dropCell || ix == null) ? null : packets[ix]);
    const img = renderFrame(payloads, W, H, frames % 4, L);
    addNoise(img, 0.002);

    /* 接收端：周期性重新定位（每 25 帧一次） */
    if (frames % 25 === 0 || frames === 0) {
      relocates++;
      const seed = jsQR(img.data, W, H);
      if (seed) {
        const g = Proto.deriveGrid(seed);
        const found = [];
        for (const [dx, dy] of Proto.candidateOffsets()) {
          const cx = g.centerX + dx * g.pitch, cy = g.centerY + dy * g.pitch;
          const half = g.qrSize / 2 + 4, side = Math.round(g.qrSize + 8);
          if (cx - half < 0 || cy - half < 0 || cx + half > W || cy + half > H) continue;
          const t = crop(img, Math.round(cx - half), Math.round(cy - half), side, side);
          const r = jsQR(t.data, t.width, t.height);
          if (r && r.binaryData) {
            const pkt = Proto.decodePacket(r.binaryData);
            if (pkt) found.push({ x: Math.round(cx - half), y: Math.round(cy - half), w: side, h: side, fails: 0, ok: 1 });
          }
        }
        if (found.length) regions = found;
      }
    }
    /* 区域跟踪解码 */
    for (const rg of regions) {
      const t = crop(img, rg.x, rg.y, rg.w, rg.h);
      const qr = jsQR(t.data, t.width, t.height);
      if (!qr) continue;
      const pkt = Proto.decodePacket(qr.binaryData);
      if (!pkt) continue;
      if (pkt.isMeta) { metaSeen = true; continue; }
      if (pkt.index >= 1 && pkt.index <= meta.chunks && !received[pkt.index]) {
        received[pkt.index] = 1; got++;
        chunks[pkt.index - 1] = pkt.payload;
      }
    }
  }
  ok(got === meta.chunks, `历经 ${frames} 帧收齐 ${meta.chunks} 个数据包（每帧噪点+随机丢码）`);
  ok(metaSeen, '元数据包已收到');
  const assembled = Proto.assemble(meta, chunks);
  ok(assembled && Proto.crc32(assembled) === meta.crc32 &&
     Buffer.compare(Buffer.from(assembled), Buffer.from(fileBytes)) === 0, '整文件 CRC 校验一致');
  console.log(`  帧数=${frames}（理论最少 ${Math.ceil(meta.chunks / 5)}，重新定位 ${relocates} 次）`);
}

console.log('\n== 小文件（不足 6 包，含空槽位） ==');
{
  const fileBytes = new Uint8Array(1000);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 53 + 7) & 255;
  const { packets, meta } = Proto.packetize(fileBytes, 'small.bin', 404);
  const W = 1280, H = 853;
  const L = Proto.gridLayout(W, H);
  let got = 0;
  const chunks = new Array(meta.chunks);
  for (let frames = 0; frames < 40 && got < meta.chunks; frames++) {
    const slots = [0, 1, 2, 3, null, null];
    const payloads = slots.map(ix => ix == null ? null : packets[ix]);
    const img = renderFrame(payloads, W, H, frames % 4, L);
    const seed = jsQR(img.data, W, H);
    if (!seed) continue;
    const g = Proto.deriveGrid(seed);
    for (const [dx, dy] of Proto.candidateOffsets()) {
      const cx = g.centerX + dx * g.pitch, cy = g.centerY + dy * g.pitch;
      const half = g.qrSize / 2 + 4, side = Math.round(g.qrSize + 8);
      if (cx - half < 0 || cy - half < 0 || cx + half > W || cy + half > H) continue;
      const t = crop(img, Math.round(cx - half), Math.round(cy - half), side, side);
      const r = jsQR(t.data, t.width, t.height);
      if (r && r.binaryData) {
        const pkt = Proto.decodePacket(r.binaryData);
        if (pkt && pkt.index >= 1 && pkt.index <= meta.chunks && !chunks[pkt.index - 1]) {
          chunks[pkt.index - 1] = pkt.payload; got++;
        }
      }
    }
  }
  const assembled = Proto.assemble(meta, chunks);
  ok(assembled && Proto.crc32(assembled) === meta.crc32 &&
     Buffer.compare(Buffer.from(assembled), Buffer.from(fileBytes)) === 0, `小文件（3 包）传输成功`);
}

console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
