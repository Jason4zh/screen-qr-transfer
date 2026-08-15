/* 屏码传 · 核心逻辑 Node 测试：协议 + 二维码编解码往返 */
'use strict';
const assert = require('assert');
const qrcode = require('../lib/qrcode.js');
const jsQR = require('../lib/jsqr.js');
const Proto = require('../src/protocol.js');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

function bin(bytes) {
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return s;
}

/* 用与发送端相同的方式把 QR 矩阵渲染成位图，再喂给 jsQR */
function qrToImageData(qr, modulePx) {
  const mods = qr.getModuleCount(), quiet = 4, total = mods + quiet * 2;
  const w = total * modulePx;
  const data = new Uint8ClampedArray(w * w * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255; }
  for (let r = 0; r < mods; r++) for (let c = 0; c < mods; c++) {
    if (qr.isDark(r, c)) {
      for (let dy = 0; dy < modulePx; dy++) for (let dx = 0; dx < modulePx; dx++) {
        const x = (c + quiet) * modulePx + dx, y = (r + quiet) * modulePx + dy;
        const o = (y * w + x) * 4;
        data[o] = 0; data[o + 1] = 0; data[o + 2] = 0;
      }
    }
  }
  return { data, width: w, height: w };
}

function encodeQr(bytes) {
  const qr = qrcode(0, 'L');
  qr.addData(bin(bytes), 'Byte');
  qr.make();
  return qr;
}
function versionOf(qr) { return (qr.getModuleCount() - 17) / 4; }
function versionForLen(len) {
  if (len === 0) return 1;
  try {
    const b = new Uint8Array(len);
    for (let i = 0; i < len; i++) b[i] = (i * 31 + 7) & 255;
    return versionOf(encodeQr(b));
  } catch (e) { return 41; }
}

console.log('== CRC32 ==');
ok(Proto.crc32(new TextEncoder().encode('123456789')) === 0xCBF43926, 'CRC32 标准向量 "123456789" → 0xCBF43926');
ok(Proto.crc32(new Uint8Array(0)) === 0x00000000, 'CRC32 空输入 → 0');

console.log('\n== 容量表与库实测对比 ==');
const measured = [0];
for (let v = 1; v <= 40; v++) {
  let lo = 0, hi = 3200;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (versionForLen(mid) <= v) lo = mid; else hi = mid - 1;
  }
  measured.push(lo);
}
let capOk = true;
for (let v = 1; v <= 40; v++) {
  if (measured[v] !== Proto.CAPACITY_L[v]) {
    capOk = false;
    console.log(`    v${v}: 实测 ${measured[v]} vs 表中 ${Proto.CAPACITY_L[v]}`);
  }
}
ok(capOk, 'CAPACITY_L 表与 qrcode-generator 实测一致（Byte 模式 / L 纠错）');
console.log('  实测表: ' + measured.slice(1).join(','));

console.log('\n== QR 往返（编码→渲染→jsQR 解码，含高字节） ==');
const sizes = [16, 50, 100, 200, 400, 600, 800, 838, 1200, 2000];
for (const n of sizes) {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 131 + 29) & 255;
  const qr = encodeQr(bytes);
  const res = jsQR(qrToImageData(qr, 5).data, qrToImageData(qr, 5).width, qrToImageData(qr, 5).height);
  const okFlag = res && Buffer.compare(Buffer.from(res.binaryData), Buffer.from(bytes)) === 0;
  ok(okFlag, `往返 ${n} 字节（v${versionOf(qr)} @5px/模块）`);
}
{
  const bytes = new Uint8Array(600);
  for (let i = 0; i < 600; i++) bytes[i] = (i * 73 + 11) & 255;
  const qr = encodeQr(bytes);
  const img = qrToImageData(qr, 3);
  const res = jsQR(img.data, img.width, img.height);
  ok(res && Buffer.compare(Buffer.from(res.binaryData), Buffer.from(bytes)) === 0, `往返 600 字节 @3px/模块（v${versionOf(qr)}）`);
}
{
  const bytes = new Uint8Array(500).fill(255);
  const qr = encodeQr(bytes);
  const img = qrToImageData(qr, 4);
  const res = jsQR(img.data, img.width, img.height);
  ok(res && Buffer.compare(Buffer.from(res.binaryData), Buffer.from(bytes)) === 0, '往返 500×0xFF');
}

console.log('\n== 包编解码（含 cell 码位字段） ==');
{
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const p = Proto.encodePacket(7, 100, payload, false, 4);
  const d = Proto.decodePacket(p);
  ok(d && d.index === 7 && d.total === 100 && d.cell === 4 && !d.isMeta, '数据包 cell 字段往返');
  const pm = Proto.encodePacket(0, 100, new TextEncoder().encode('{"v":1}'), true, 0);
  const dm = Proto.decodePacket(pm);
  ok(dm && dm.isMeta && dm.cell === 0, '元数据包 cell=0');
  ok(Proto.HEADER_LEN === 18, '头部长度 18（含 cell 字节）');
  const p2 = Uint8Array.from(p); p2[3] = 5;   /* 发送端按槽位改写 cell 字节（header 不参与 CRC） */
  const d2 = Proto.decodePacket(p2);
  ok(d2 && d2.cell === 5, 'cell 字节可被改写且仍可解码');
}

console.log('\n== 仿射拟合（码位→位置） ==');
{
  function model(cell) { return { u: cell % 3, v: Math.floor(cell / 3) }; }
  function groundTruth(cell) {
    const m = model(cell);
    return { x: 100 + m.u * 220 + m.v * 30, y: 80 + m.u * 25 + m.v * 180 };
  }
  const corr = [];
  for (let c = 0; c < 6; c++) {
    const gt = groundTruth(c);
    corr.push({ cell: c, x: gt.x + (Math.random() - 0.5) * 2, y: gt.y + (Math.random() - 0.5) * 2 });
  }
  const T = Proto.fitAffine(corr);
  ok(!!T, '仿射拟合成功');
  if (T) {
    let maxErr = 0;
    for (let c = 0; c < 6; c++) {
      const p = T.apply(c);
      const gt = groundTruth(c);
      maxErr = Math.max(maxErr, Math.abs(p.x - gt.x), Math.abs(p.y - gt.y));
    }
    ok(maxErr < 3, `仿射拟合最大误差 ${maxErr.toFixed(2)}px（含 2px 噪声）`);
  }
  ok(Proto.fitAffine([{ cell: 0, x: 1, y: 1 }, { cell: 1, x: 2, y: 1 }]) === null, '对应点不足 3 个返回 null');
  ok(Proto.fitAffine([{ cell: 0, x: 1, y: 1 }, { cell: 1, x: 2, y: 1 }, { cell: 2, x: 3, y: 1 }]) === null, '共线对应点返回 null（退化）');
}

console.log('\n== Reed-Solomon FEC 纠删码 ==');
{
  /* GF 基础 */
  ok(Proto.gfMul(2, 3) === 6 && Proto.gfMul(0, 7) === 0, 'GF(256) 乘法');
  ok(Proto.gfMul(7, Proto.gfInv(7)) === 1, 'GF(256) 求逆');
  /* 矩阵求逆 */
  const M = [[1, 2], [3, 4]];
  const Inv = Proto.gfMatrixInvert(M);
  const prod = [[0, 0], [0, 0]];
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    prod[i][j] = Proto.gfMul(M[i][0], Inv[0][j]) ^ Proto.gfMul(M[i][1], Inv[1][j]);
  }
  ok(prod[0][0] === 1 && prod[0][1] === 0 && prod[1][0] === 0 && prod[1][1] === 1, 'GF 矩阵求逆 M×M⁻¹=I');
  /* 小规模：N=4 K=2，穷举所有擦除组合 */
  const N = 4, K = 2;
  const data = [];
  for (let i = 0; i < N; i++) {
    const p = new Uint8Array(32);
    for (let j = 0; j < 32; j++) p[j] = (i * 61 + j * 13 + 7) & 255;
    data.push(p);
  }
  const rows = Proto.fecParityRows(N, K);
  const parities = Proto.fecEncode(data, rows);
  let allCombos = true;
  for (let mask = 0; mask < 64; mask++) {
    const present = [];
    let cnt = 0;
    for (let i = 0; i < N; i++) if (mask & (1 << i)) { present.push({ row: (() => { const r = new Array(N).fill(0); r[i] = 1; return r; })(), symbols: data[i] }); cnt++; }
    for (let p = 0; p < K; p++) if (mask & (1 << (N + p))) { present.push({ row: rows[p], symbols: parities[p] }); cnt++; }
    if (cnt < N) continue;
    const rec = Proto.fecDecode(present, N);
    let okc = rec != null;
    if (okc) for (let i = 0; i < N; i++) if (Buffer.compare(Buffer.from(rec[i]), Buffer.from(data[i])) !== 0) { okc = false; break; }
    if (!okc) { allCombos = false; break; }
  }
  ok(allCombos, `N=4 K=2 全部 ${1 << (N + K)} 种擦除组合可恢复`);
  /* 大组：N=100 K=15，随机擦除 12% */
  const N2 = 100, K2 = 15;
  const data2 = [];
  for (let i = 0; i < N2; i++) {
    const p = new Uint8Array(200);
    for (let j = 0; j < 200; j++) p[j] = (i * 31 + j * 7 + 3) & 255;
    data2.push(p);
  }
  const rows2 = Proto.fecParityRows(N2, K2);
  const parities2 = Proto.fecEncode(data2, rows2);
  const present2 = [];
  for (let i = 0; i < N2; i++) {
    if (Math.random() < 0.88) {
      const r = new Array(N2).fill(0); r[i] = 1;
      present2.push({ row: r, symbols: data2[i] });
    }
  }
  for (let p = 0; p < K2; p++) if (Math.random() < 0.88) present2.push({ row: rows2[p], symbols: parities2[p] });
  ok(present2.length >= N2, `N=100 K=15 擦除后剩余 ${present2.length} ≥ 100`);
  const rec2 = Proto.fecDecode(present2, N2);
  let ok2 = rec2 != null;
  if (ok2) for (let i = 0; i < N2; i++) if (Buffer.compare(Buffer.from(rec2[i]), Buffer.from(data2[i])) !== 0) { ok2 = false; break; }
  ok(ok2, 'N=100 K=15 随机擦除 12% 后完整恢复');
}

console.log('\n== FEC 分包与整链路（多轮循环 + 丢包/持续失败码位） ==');
{
  const fileBytes = new Uint8Array(300000);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 89 + 5) & 255;
  const chunkSize = 622;
  const fecN = 100, fecK = 0;   /* 0 → 自动 20% */
  const { packets, meta } = Proto.packetize(fileBytes, 'fec.bin', chunkSize, fecN, fecK);
  const info = Proto.fecBlockInfo(meta);
  const blocks = info.blocks;
  ok(packets.length === 1 + meta.chunks + blocks * info.K, `包数 = 元数据 + ${meta.chunks} 数据 + ${blocks}×${info.K} 奇偶（冗余 ${info.K}%）`);
  ok(meta.fecN === fecN, '元数据携带 FEC 参数');

  /* 模拟发送端循环 + 接收端分块收集：
   * 每帧 6 个槽位，其中 1 个槽位（cell 0）持续失败 → 每轮约 1/6 包丢失 */
  const chunks = new Array(meta.chunks);
  const blockData = new Array(blocks), blockParity = new Array(blocks), blockHave = new Array(blocks).fill(0), blockDone = new Uint8Array(blocks);
  for (let b = 0; b < blocks; b++) {
    blockData[b] = new Array(info.dataCount(b)).fill(null);
    blockParity[b] = new Array(info.K).fill(null);
  }
  let decoded = 0;
  function tryDecode(b) {
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
    const base = b * fecN;
    for (let i = 0; i < count; i++) if (!chunks[base + i]) { chunks[base + i] = rec[i]; decoded++; }
  }
  const order = [];
  for (let i = 1; i < packets.length; i++) order.push(i);
  let passes = 0;
  const maxPasses = 6;
  for (passes = 1; passes <= maxPasses && decoded < meta.chunks; passes++) {
    for (let j = order.length - 1; j > 0; j--) { const k = (Math.random() * (j + 1)) | 0; const t = order[j]; order[j] = order[k]; order[k] = t; }
    for (let i = 0; i < order.length; i++) {
      if (i % 6 === 0 && Math.random() < 0.5) continue;   /* 该槽位所在 cell 半概率失败 */
      if (Math.random() < 0.05) continue;                 /* 额外 5% 瞬态丢包 */
      const d = Proto.decodePacket(packets[order[i]]);
      if (!d) continue;
      let b, pos;
      if (!d.isParity) {
        b = Math.floor((d.index - 1) / fecN); pos = (d.index - 1) % fecN;
        if (blockData[b][pos]) continue;
        blockData[b][pos] = d.payload; blockHave[b]++;
      } else {
        const pp = d.index - meta.chunks - 1;
        b = Math.floor(pp / info.K); pos = pp % info.K;
        if (blockParity[b][pos]) continue;
        blockParity[b][pos] = d.payload; blockHave[b]++;
      }
      if (blockHave[b] >= info.dataCount(b)) tryDecode(b);
    }
  }
  ok(decoded === meta.chunks, `持续失败码位 + 5% 瞬态丢包下，${passes} 轮内 FEC 恢复全部 ${meta.chunks} 块`);
  ok(passes <= 3, `无需 100% 收齐：${passes} 轮即完成（无 FEC 时尾部需数十轮）`);
  const assembled = Proto.assemble(meta, chunks);
  ok(assembled && Proto.crc32(assembled) === meta.crc32 &&
     Buffer.compare(Buffer.from(assembled), Buffer.from(fileBytes)) === 0, 'FEC 恢复后整文件 CRC 校验一致');
}

console.log('\n== 分包 / 组包 / 丢包 / 篡改 ==');
{
  const fileBytes = new Uint8Array(250000);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 97 + 13) & 255;
  const chunkSize = 620;
  const { packets, meta } = Proto.packetize(fileBytes, '测试文件.bin', chunkSize);
  const expectN = Math.ceil(250000 / 620);
  ok(packets.length === expectN + 1, `分包数量 ${packets.length} = 元数据+${expectN}`);
  const decoded = packets.map(p => Proto.decodePacket(p));
  ok(decoded.every(Boolean), '所有包可解码且 CRC 通过');
  ok(decoded[0].isMeta && decoded[0].index === 0, '首包为元数据包');
  /* 元数据已填充到 chunkSize：与数据包同长度 → 同版本 → 绘制尺寸统一 */
  ok(decoded[0].payload.length === chunkSize, '元数据负载补齐到 chunkSize（同屏统一版本）');
  const m = Proto.parseMetaPayload(decoded[0].payload);
  ok(m.name === '测试文件.bin' && m.size === 250000 && m.chunks === expectN, '元数据解析正确（\0 截断）');
  /* 丢 5% 包（保留元数据）：缺包时应返回 null，等待后续轮次重传 */
  const kept = decoded.filter((d, i) => i === 0 || i % 20 !== 0);
  const chunksPartial = new Array(meta.chunks);
  kept.forEach(d => { if (d.index >= 1) chunksPartial[d.index - 1] = d.payload; });
  ok(Proto.assemble(meta, chunksPartial) === null, '缺包时组装返回 null（等待重传轮次）');
  /* 全部包到齐后组装 + 整文件校验一致 */
  const chunksAll = new Array(meta.chunks);
  decoded.forEach(d => { if (d.index >= 1) chunksAll[d.index - 1] = d.payload; });
  const assembled = Proto.assemble(meta, chunksAll);
  ok(assembled && Proto.crc32(assembled) === meta.crc32 &&
     Buffer.compare(Buffer.from(assembled), Buffer.from(fileBytes)) === 0, '全部包到齐后组装 + 整文件校验一致');
  /* 乱序重排后仍正确 */
  const shuffled = decoded.slice(1).reverse();
  const chunks2 = new Array(meta.chunks);
  shuffled.forEach(d => { chunks2[d.index - 1] = d.payload; });
  const assembled2 = Proto.assemble(meta, chunks2);
  ok(assembled2 && Buffer.compare(Buffer.from(assembled2), Buffer.from(fileBytes)) === 0, '乱序接收后组装一致');
  /* 篡改检测 */
  const bad = Uint8Array.from(packets[5]); bad[20] ^= 0xFF;
  ok(Proto.decodePacket(bad) === null, '篡改包被 CRC 拒绝');
  ok(Proto.decodePacket(new Uint8Array(10)) === null, '过短数据被拒绝');
  ok(Proto.decodePacket(Uint8Array.from([0x53, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 4, 0, 0, 0, 0, 1, 2, 3, 4])) === null, 'CRC 错误包被拒绝');
}

console.log('\n== 布局参数（整数模块像素，模块均匀） ==');
{
  const P = Proto.computeLayoutParams(1280, 853, 29, 4);
  ok(P.px >= 3 && P.qrDrawn === P.px * P.total && P.total === P.version * 4 + 25,
     `1280x853 标准: px=${P.px} v${P.version} qrDrawn=${P.qrDrawn} chunk=${P.chunkSize}`);
  const P2 = Proto.computeLayoutParams(1920, 1080, 29, 4);
  ok(P2.px >= 4 && P2.version >= 20, `1920x1080 标准: px=${P2.px} v${P2.version} qrDrawn=${P2.qrDrawn}`);
  const P3 = Proto.computeLayoutParams(1920, 1080, 33, 3);
  ok(P3.px === 3 && P3.version >= 29, `1920x1080 高速: px=${P3.px} v${P3.version} qrDrawn=${P3.qrDrawn} chunk=${P3.chunkSize}`);
  const P4 = Proto.computeLayoutParams(1280, 853, 33, 3);
  ok(P4.version >= 20, `1280x853 高速: px=${P4.px} v${P4.version} chunk=${P4.chunkSize}`);
  /* 布局适配检查：网格必须落在白色区域内 */
  const L = Proto.gridLayout(1280, 853, P.qrDrawn);
  const gridW = 3 * P.qrDrawn + 2 * L.gap, gridH = 2 * P.qrDrawn + L.gap;
  ok(gridW <= 1280 - 2 * L.m && gridH <= 853 - 2 * L.m, `网格 ${gridW}x${gridH} ≤ 白色区域 ${1280 - 2 * L.m}x${853 - 2 * L.m}`);
  /* 接收端推导与发送端布局一致：解码任意 QR 得到的尺寸 == qrDrawn */
  const fileBytes = new Uint8Array(5000);
  const { packets } = Proto.packetize(fileBytes, 'x.bin', P.chunkSize);
  const qr = encodeQr(packets[1]);
  const img = qrToImageData(qr, P.px);
  const res = jsQR(img.data, img.width, img.height);
  const dg = res ? Proto.deriveGrid(res) : null;
  ok(dg && Math.abs(dg.qrSize - P.qrDrawn) < 2, `接收端推导尺寸 ${dg ? Math.round(dg.qrSize) : '-'} ≈ 发送端绘制 ${P.qrDrawn}`);
}

console.log('\n== 高版本大负载 @3px 整数模块（高速档可靠性） ==');
{
  for (const [ver, px] of [[25, 3], [29, 3], [33, 3]]) {
    const cap = Proto.CAPACITY_L[ver];
    const payload = new Uint8Array(cap - 40);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 131 + 29) & 255;
    const pkt = Proto.encodePacket(1, 100, payload, false, 0);
    let okc = 0;
    for (let t = 0; t < 5; t++) {
      const qr = encodeQr(pkt);
      const img = qrToImageData(qr, px);
      const res = jsQR(img.data, img.width, img.height);
      if (res && Buffer.compare(Buffer.from(res.binaryData), Buffer.from(pkt)) === 0) okc++;
    }
    ok(okc === 5, `v${ver}（负载 ${payload.length}B @${px}px 整数模块）往返 ${okc}/5`);
  }
}

console.log('\n== v20 大负载数据包的 QR 往返 ==');
{
  const fileBytes = new Uint8Array(100000);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 53 + 3) & 255;
  const { packets } = Proto.packetize(fileBytes, 'a.bin', 838);
  const pkt = packets[3];
  const qr = encodeQr(pkt);
  const img = qrToImageData(qr, 5);
  const res = jsQR(img.data, img.width, img.height);
  const d = res ? Proto.decodePacket(res.binaryData) : null;
  ok(d && d.index === 3 && Buffer.compare(Buffer.from(d.payload), Buffer.from(pkt.subarray(18))) === 0,
     `v20 数据包（838B 负载 @5px/模块）往返 + 包校验通过`);
}

console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
