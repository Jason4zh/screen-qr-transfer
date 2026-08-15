/* 构建：将模板 + 内联库 + 源码合并为单一可运行 HTML，并做语法校验 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

const tpl = read('template.html');
const parts = {
  '/*__QRCODE_LIB__*/': read('lib/qrcode.js'),
  '/*__JSQR_LIB__*/': read('lib/jsqr.js'),
  '/*__PROTOCOL_JS__*/': read('src/protocol.js'),
  '/*__SENDER_JS__*/': read('src/sender.js'),
  '/*__RECEIVER_JS__*/': read('src/receiver.js'),
  '/*__APP_JS__*/': read('src/app.js')
};

let out = tpl;
for (const k of Object.keys(parts)) {
  if (!out.includes(k)) { console.error('缺少占位符: ' + k); process.exit(1); }
  out = out.split(k).join(parts[k]);
}
if (out.includes('/*__')) { console.error('仍有未替换的占位符'); process.exit(1); }

/* 安全校验：script 块内不得出现 </script>（防止内联库截断脚本） */
const scriptBody = out.match(/<script>([\s\S]*)<\/script>/);
if (!scriptBody) { console.error('未找到 <script> 块'); process.exit(1); }
if (/<\/script/i.test(scriptBody[1])) { console.error('内联脚本中含 </script>，禁止内联'); process.exit(1); }

/* 语法校验（只解析不执行） */
try { new Function(scriptBody[1]); }
catch (e) { console.error('内联脚本语法错误:', e.message); process.exit(1); }

const dest = path.join(root, '..', 'index.html');
fs.writeFileSync(dest, out);
console.log('✔ 已生成 ' + dest + '（' + out.length + ' 字节）');
