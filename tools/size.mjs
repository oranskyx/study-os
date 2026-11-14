// 代码体检：把"屎山"变成可看见的数字。
// 用法：npm run stats [-- --ref=HEAD]（不带参数只看工作区）
//
// 只回答三个问题：
//   1. 每个文件多大（谁在膨胀）
//   2. 与 git ref 相比，净增/净减多少（AI 只增不减的毛病有没有犯）
//   3. 最大的那几个文件里，有没有重复函数名（模块边界漏了）
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const refArg = process.argv.find((a) => a.startsWith('--ref='));
const ref = refArg ? refArg.split('=')[1] : null;
const SRC = /^(server|public|tools)\/.*\.(mjs|js|css)$/;
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });

function lines(text) {
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

const now = {};
for (const f of git('ls-files').split('\n').filter((f) => SRC.test(f))) {
  now[f] = lines(readFileSync(path.join(ROOT, f), 'utf8'));
}
const nowTotal = Object.values(now).reduce((a, b) => a + b, 0);

console.log('\n  文件行数（降序）');
for (const [f, n] of Object.entries(now).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + String(n).padStart(6) + '  ' + f);
}
console.log('  ' + String(nowTotal).padStart(6) + '  （合计）\n');

if (ref) {
  const old = {};
  for (const f of git('ls-tree', '-r', '--name-only', ref).split('\n').filter((f) => SRC.test(f))) {
    try { old[f] = lines(git('show', ref + ':' + f)); } catch { old[f] = 0; }
  }
  const oldTotal = Object.values(old).reduce((a, b) => a + b, 0);
  const delta = nowTotal - oldTotal;
  console.log('  对比 ' + ref + '：' + oldTotal + ' → ' + nowTotal +
    '（' + (delta > 0 ? '净增 ' + delta : '净减 ' + -delta) + ' 行）');
  const changed = Object.keys({ ...now, ...old })
    .map((f) => [f, (now[f] || 0) - (old[f] || 0)])
    .filter(([, d]) => d !== 0)
    .sort((a, b) => a[1] - b[1]);
  for (const [f, d] of changed) {
    console.log('    ' + (d > 0 ? '+' + d : d) + '\t' + f);
  }
  console.log('');
}

// 同名函数在多文件出现 = 复制粘贴的痕迹
const seen = new Map();
for (const f of Object.keys(now)) {
  const s = readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of s.matchAll(/^(?:export )?(?:async )?function ([a-zA-Z_$][\w$]*)/gm)) {
    if (!seen.has(m[1])) seen.set(m[1], []);
    seen.get(m[1]).push(f);
  }
}
const dup = [...seen.entries()].filter(([, v]) => v.length > 1);
if (dup.length) {
  console.log('  同名函数出现在多个文件（可能是重复实现）：');
  for (const [name, files] of dup) console.log('    ' + name + ' → ' + files.join(', '));
  console.log('');
}
