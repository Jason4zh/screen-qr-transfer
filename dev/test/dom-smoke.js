/* 构建产物冒烟测试：以 DOM 桩加载最终 HTML 中的内联脚本，
 * 验证：模块可加载、协议可用、发送端可完成选文件→分包→渲染一帧。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error('未找到脚本块'); process.exit(1); }

/* ---------- 最小 DOM 桩 ---------- */
function makeCtx() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(t, prop) {
      if (prop === 'measureText') return () => ({ width: 100 });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      return (...args) => { calls.push(String(prop) + (prop === 'fillRect' ? ':' + args.join(',') : '')); };
    },
    set() { return true; }
  });
  return { ctx, calls };
}

function makeCanvas() {
  const { ctx, calls } = makeCtx();
  return { width: 0, height: 0, getContext: () => ctx, _calls: calls };
}

function makeElement(id) {
  const { ctx, calls } = makeCtx();
  const el = {
    id, style: {}, dataset: {}, _h: 0, value: '', checked: false, innerHTML: '', textContent: '',
    clientWidth: 640, clientHeight: 360, width: 0, height: 0, files: [],
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, click() {}, setAttribute() {},
    getContext: () => ctx,
    play: () => Promise.resolve(),
    pause() {},
    _calls: calls
  };
  return el;
}

const elements = {};
const createdCanvases = [];
const documentStub = {
  getElementById: (id) => (elements[id] || (elements[id] = makeElement(id))),
  createElement: (tag) => { const c = makeCanvas(); createdCanvases.push(c); return c; },
  body: { style: {}, appendChild() {} },
  documentElement: { requestFullscreen: () => Promise.resolve() },
  fullscreenElement: null,
  exitFullscreen: () => Promise.resolve(),
  addEventListener() {}
};

const sandbox = {
  console, setTimeout, clearTimeout, performance, TextEncoder, TextDecoder, Uint8Array,
  Int32Array, Uint8ClampedArray, ArrayBuffer, JSON, Math, String, Date, Promise, Number,
  document: documentStub,
  navigator: { mediaDevices: null, wakeLock: { request: () => Promise.resolve() } },
  location: { protocol: 'file:', hostname: '', href: 'file:///x.html' },
  isSecureContext: true,
  window: null,  /* 下面赋值 */
  globalThis: null, /* 下面赋值 */
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  Blob: function () {},
  FileReader: function () { this.readAsArrayBuffer = () => {}; },
  requestAnimationFrame() {}
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.innerWidth = 1920;
sandbox.window.innerHeight = 1080;
sandbox.window.devicePixelRatio = 1;
sandbox.window.addEventListener = () => {};
sandbox.window.requestFullscreen = () => Promise.resolve();
sandbox.window.matchMedia = () => ({ matches: false, addListener() {} });

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

try {
  vm.runInNewContext(m[1], sandbox, { filename: 'built-script.js', timeout: 20000 });
} catch (e) {
  console.error('加载内联脚本失败:', e.stack);
  process.exit(1);
}
console.log('✔ 内联脚本加载无异常\n');

/* 协议（构建产物内） */
const Proto = sandbox.QRProtocol;
ok(!!Proto && typeof Proto.packetize === 'function', 'QRProtocol 已暴露');
{
  const bytes = new Uint8Array(12345);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 89 + 3) & 255;
  const { packets, meta } = Proto.packetize(bytes, '冒烟.bin', 404);
  const dec = packets.map(p => Proto.decodePacket(p));
  const chunks = new Array(meta.chunks);
  dec.forEach(d => { if (d.index >= 1) chunks[d.index - 1] = d.payload; });
  const assembled = Proto.assemble(meta, chunks);
  ok(assembled && Proto.crc32(assembled) === meta.crc32 && Buffer.compare(Buffer.from(assembled), Buffer.from(bytes)) === 0,
    '构建产物内协议 分包→解码→组装 一致');
}
ok(Proto.crc32(new TextEncoder().encode('123456789')) === 0xCBF43926, 'CRC32 校验');

/* 发送端：选文件 → 预估 → 开始 → 渲染一帧 */
const Sender = sandbox.Sender;
const UI = sandbox.UI;
ok(!!Sender && !!UI, 'Sender / UI 已暴露');
{
  const bytes = new Uint8Array(40000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 53 + 11) & 255;
  Sender.setConfig('balanced', true, false);
  Sender.setFile('smoke-test.bin', bytes);
  const est = Sender.estimate();
  ok(est && est.chunkSize > 0 && est.cols >= 1 && est.rows >= 1 && est.version >= 1 && est.version <= 40,
    `预估正常 chunk=${est.chunkSize} 码阵=${est.cols}x${est.rows} v${est.version} bps≈${Math.round(est.bps)}`);
  Sender.start();
  const canvas = elements['txCanvas'];
  const drawCalls = canvas._calls;
  /* 主画布：背景 + 空单元 fillRect + 贴图 drawImage；模块像素画在离屏画布上 */
  const offRects = createdCanvases.reduce((s, c) => s + c._calls.filter(x => x.startsWith('fillRect')).length, 0);
  ok(offRects > 3000, `离屏画布绘制了 ${offRects} 次 fillRect（QR 模块逐格绘制，v17≈7千格）`);
  ok(drawCalls.includes('drawImage'), 'drawImage 被调用（QR 贴图缩放）');
  ok(elements['txOverlay'].style.display === 'flex', '发送遮罩已显示');
  ok(/smoke-test\.bin/.test(elements['txLabel'].textContent || ''), '状态标签含文件名');
  ok(/帧/.test(elements['sendStats'].innerHTML || ''), '统计面板已更新');
  Sender.stop();
  ok(elements['txOverlay'].style.display === 'none', '停止后遮罩隐藏');
}
/* 对齐测试模式 */
{
  Sender.setConfig('fast', true, false);
  Sender.align();
  ok(elements['txOverlay'].style.display === 'flex', '对齐测试遮罩显示');
  Sender.stop();
}
/* 接收端模块可加载且 stop 安全（未启动时调用） */
{
  const Receiver = sandbox.Receiver;
  ok(!!Receiver, 'Receiver 已暴露');
  Receiver.stop();
  ok(true, 'Receiver.stop 空转安全');
}

console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
