#!/usr/bin/env node
// 一条命令跑完全部测试，而且**不碰你真实的 data/**。
//
//   npm run test:all            跑完自动清理临时目录
//   npm run test:all -- --keep  保留临时目录，方便出问题时翻日志
//
// 做法：在系统临时目录里新建一个空的 DATA_DIR，另起一个服务（随机空闲端口）+
// 一个 mock 模型服务，所有测试只对这套临时环境发请求。跑完杀掉、删掉。
//
// 顺序有讲究：e2e 会先把「有公式的题目」灌进去，mathtest 才有东西可测；
// 其余几个套件各自造自己的数据，互不影响。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');
const results = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitUp(url, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1200) })).ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

const children = [];
function launch(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

function cleanup(dir) {
  for (const c of children) {
    try { c.kill(); } catch { /* 已经退了 */ }
  }
  if (!KEEP) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 文件被占用 */ }
  }
}

/** 跑一个测试脚本，实时转发输出，返回 { code, summary, ms } */
function runSuite(name, script, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = launch([path.join('tools', script)], env);
    let tail = '';
    const onData = (buf) => {
      const text = buf.toString();
      process.stdout.write(text);
      tail = (tail + text).slice(-2000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      // 各套件的小结格式略有差异（有逗号/没逗号/带跳过），这里都兼容
      const m = tail.match(/通过\s*(\d+)\D{0,4}失败\s*(\d+)/g);
      const last = m ? m[m.length - 1].replace(/\s+/g, ' ') : null;
      resolve({ name, code, summary: last, ms: Date.now() - started });
    });
  });
}

// ---------------------------------------------------------------- 准备环境
const dataDir = mkdtempSync(path.join(tmpdir(), 'studyos-test-'));
const appPort = await freePort();
const mockPort = await freePort();
const APP = `http://127.0.0.1:${appPort}`;
const MOCK = `http://127.0.0.1:${mockPort}/v1`;

console.log('');
console.log('  隔离测试环境');
console.log(`  临时数据  ${dataDir}`);
console.log(`  应用      ${APP}`);
console.log(`  mock      ${MOCK}`);
console.log('');

const app = launch([path.join('server', 'index.mjs')], {
  PORT: String(appPort),
  DATA_DIR: dataDir,
  HOST: '127.0.0.1',
});
const mock = launch([path.join('tools', 'mock-ai.mjs')], { MOCK_PORT: String(mockPort) });

let fatal = null;
if (!(await waitUp(`${APP}/api/meta`))) fatal = '应用没能在 25 秒内起来';
if (!fatal && !(await waitUp(`${MOCK}/models`))) fatal = 'mock 模型服务没能在 25 秒内起来';

if (fatal) {
  console.error(`  [FATAL] ${fatal}`);
  cleanup(dataDir);
  process.exit(1);
}

// 让临时实例指向 mock，别去花真钱
await fetch(`${APP}/api/settings`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    vision: { baseUrl: MOCK, apiKey: 'mock', model: 'mock-vl-1' },
    text: { baseUrl: MOCK, apiKey: 'mock', model: 'mock-text-1' },
  }),
});

// ---------------------------------------------------------------- 跑测试
// DATA_DIR 必须一起传下去：几个套件会用自己的「配置快照守卫」直接读库，
// 不传的话它们会去读真实的 data/study.db，隔离就白做了。
const BASE_ENV = { BASE: APP, APP, MOCK, DATA_DIR: dataDir, PORT: String(appPort) };

const SUITES = [
  ['test:e2e', 'e2e-mock.mjs'],
  ['test:math', 'mathtest.mjs'],
  ['test:ui', 'uidom.mjs'],
  ['test:api', 'smoke.mjs'],
  ['test:mobile', 'mobilecheck.mjs'],
];

for (const [name, script] of SUITES) {
  if (!readdirSync(path.join(ROOT, 'tools')).includes(script)) {
    results.push({ name, code: null, summary: '文件不存在，跳过', ms: 0 });
    continue;
  }
  results.push(await runSuite(name, script, BASE_ENV));
}

cleanup(dataDir);

// ---------------------------------------------------------------- 汇总
console.log('');
console.log('  ==============================================================');
let failed = 0;
for (const r of results) {
  const skipped = r.code === 2;
  const ok = r.code === 0;
  if (!ok && !skipped) failed++;
  const state = r.code === null ? '跳过' : skipped ? '跳过' : ok ? '通过' : '失败';
  console.log(`  ${state}  ${r.name.padEnd(12)} ${(r.summary || `退出码 ${r.code}`).padEnd(22)} ${String(Math.round(r.ms / 1000))}s`);
}
console.log('  ==============================================================');
console.log(`  ${failed ? `${failed} 个套件失败` : `全部 ${results.length} 个套件通过`}（耗时 ${Math.round(results.reduce((a, r) => a + r.ms, 0) / 1000)}s）`);
if (KEEP) console.log(`  临时目录已保留：${dataDir}`);
console.log('');

process.exit(failed ? 1 : 0);
