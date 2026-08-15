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
  const m = JSON.parse(new TextDecoder().decode(decoded[0].payload));
  ok(m.name === '测试文件.bin' && m.size === 250000 && m.chunks === expectN, '元数据解析正确');
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
  ok(Proto.decodePacket(Uint8Array.from([0x53, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1, 2, 3, 4])) === null, 'CRC 错误包被拒绝');
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
  ok(d && d.index === 3 && Buffer.compare(Buffer.from(d.payload), Buffer.from(pkt.subarray(17))) === 0,
     `v20 数据包（838B 负载 @5px/模块）往返 + 包校验通过`);
}

console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
