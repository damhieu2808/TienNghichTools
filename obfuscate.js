// Làm rối code JS trong thư mục bản phân phối (pack.ps1 gọi: node obfuscate.js dist\TNTool).
// Giữ nguyên tên biến toàn cục (renameGlobals: false) vì popup.js dùng hàm của license.js/admin.js qua
// phạm vi chung, và tn.js gọi các class của game (NetMgr, ...) theo tên.
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const dir = process.argv[2];
if (!dir) throw new Error('Thiếu thư mục: node obfuscate.js <thư mục>');

const base = {
  target: 'browser',
  compact: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 1,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  transformObjectKeys: false, // dữ liệu gửi server ({type, id, ...}) phải giữ nguyên khóa
  selfDefending: false,
  debugProtection: false,
  unicodeEscapeSequence: false,
};
// tn.js chạy trong game, móc vào mọi gói tin: không làm rối luồng xử lý để khỏi chậm game.
const options = {
  'tn.js': { ...base, controlFlowFlattening: false, deadCodeInjection: false },
  'license.js': { ...base, controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, deadCodeInjection: true, deadCodeInjectionThreshold: 0.4 },
  'popup.js': { ...base, controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.5, deadCodeInjection: true, deadCodeInjectionThreshold: 0.2 },
};

for (const [file, opts] of Object.entries(options)) {
  const p = path.join(dir, file);
  const src = fs.readFileSync(p, 'utf8');
  const res = JavaScriptObfuscator.obfuscate(src, opts).getObfuscatedCode();
  fs.writeFileSync(p, res, 'utf8');
  console.log(`${file}: ${src.length} -> ${res.length} ký tự`);
}
