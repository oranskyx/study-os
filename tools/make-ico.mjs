// 把 PNG 打成 Windows .ico（Vista+ 允许 ICO 里直接放 PNG 数据，免去 BMP 转换）。
//   node tools/make-ico.mjs public/icon-256.png assets/icon.ico
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('用法：node tools/make-ico.mjs <输入.png> <输出.ico>');
  process.exit(1);
}
const png = readFileSync(src);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);  // reserved
header.writeUInt16LE(1, 2);  // type: icon
header.writeUInt16LE(1, 4);  // count
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);          // width 0 = 256
entry.writeUInt8(0, 1);          // height 0 = 256
entry.writeUInt8(0, 2);          // palette
entry.writeUInt8(0, 3);          // reserved
entry.writeUInt16LE(1, 4);       // planes
entry.writeUInt16LE(32, 6);      // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);     // offset
writeFileSync(out, Buffer.concat([header, entry, png]));
console.log('已生成 ' + out + '（' + (22 + png.length) + ' 字节）');
