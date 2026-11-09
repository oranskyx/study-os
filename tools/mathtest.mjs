// 公式与 Markdown 渲染验证：真的执行 KaTeX，看 DOM 里有没有生成 .katex 元素。
// 用法：先起服务，然后 node tools/mathtest.mjs
//
// 背景：原来 KaTeX 走 jsdelivr CDN，国内直接连不上（HTTP 000），
// 公式全部退化成原始 $...$。这个测试就是为了保证这种事不会再静默发生。

import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:7788';

const results = [];
const check = (name, ok, extra = '') => results.push({ name, ok: Boolean(ok), extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await fn()) return true; } catch { /* keep waiting */ }
    await sleep(120);
  }
  return false;
}

// ---------------------------------------------------------------- 1. 静态资源
console.log('\n[1] 本地 KaTeX 资源');
for (const p of [
  'katex.min.css',
  'katex.min.js',
  'contrib/auto-render.min.js',
  'fonts/KaTeX_Main-Regular.woff2',
]) {
  const res = await fetch(`${BASE}/vendor/katex/${p}`);
  check(`/vendor/katex/${p}`, res.ok, `HTTP ${res.status}`);
}

const html = await fetch(`${BASE}/`).then((r) => r.text());
check('页面不再引用 CDN', !/jsdelivr|unpkg|cdn\./.test(html));
check('页面引用本地 katex', /\/vendor\/katex\/katex\.min\.js/.test(html));

// ---------------------------------------------------------------- 2. 真跑一遍
console.log('\n[2] 在 jsdom 里真执行 KaTeX 和 app.js');
const appJs = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const vc = new VirtualConsole();
const pageErrors = [];
vc.on('jsdomError', (e) => pageErrors.push(e.message));

const dom = new JSDOM(html, {
  url: `${BASE}/`,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;

const loaded = await waitFor(() => typeof window.renderMathInElement === 'function', 25000);
check('KaTeX auto-render 真的加载了', loaded,
  loaded ? 'window.renderMathInElement 可用' : '超时未加载');

// app.js 是 ESM 文件但本身没有 import/export，可以直接 eval
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? new URL(input, BASE).toString() : input;
  return globalThis.fetch(url, init);
};
window.addEventListener('error', (e) => pageErrors.push(`window.error: ${e.message}`));

if (loaded) {
  try {
    window.eval(appJs);
  } catch (e) {
    pageErrors.push(`eval app.js: ${e.message}`);
  }

  // 等首屏渲染
  await waitFor(() => (window.document.querySelector('#main')?.textContent || '').length > 20);

  // 直接塞一段公式，验证渲染管线本身
  const probe = window.document.createElement('div');
  probe.innerHTML = '行内 $x^{2}+1$ 与独立 $$\\int_0^1 x\\,dx$$ 都能渲染';
  window.document.body.appendChild(probe);
  window.renderMathInElement(probe, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
    ],
    throwOnError: false,
  });
  check('行内与独立公式都生成了 .katex',
    probe.querySelectorAll('.katex').length >= 2,
    `${probe.querySelectorAll('.katex').length} 个 .katex，${probe.querySelectorAll('.katex-display').length} 个独立公式`);
  check('渲染后不再残留裸 $ 符号',
    !/\$/.test(probe.textContent.replace(/\u00a0/g, ' ')),
    probe.textContent.slice(0, 40));

  // 坏公式不能把整页搞崩
  const bad = window.document.createElement('div');
  bad.innerHTML = '坏公式 $\\frac{1}{$ 之后还有正文';
  window.renderMathInElement(bad, { delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false });
  check('坏公式不抛错、不影响正文', bad.textContent.includes('之后还有正文'));

  // 题库里的真题干应该被渲染成公式
  window.location.hash = '#/bank';
  const atBank = await waitFor(
    () => window.document.querySelector('#main')?.dataset?.view === 'bank'
  );
  await waitFor(() => window.document.querySelectorAll('[data-act="q-open"]').length > 0, 8000);

  const katexInBank = window.document.querySelectorAll('#main .katex').length;
  check('错题库卡片里的公式已渲染', katexInBank > 0, `${katexInBank} 个 .katex`);

  const firstStem = window.document.querySelector('#main .stem');
  const stemText = firstStem?.textContent || '';
  check('题干里没有裸露的 $...$ 源码',
    !/\$[^$]{1,80}\$/.test(stemText),
    stemText.slice(0, 50) || '(无题干)');

  // 单题详情
  const card = window.document.querySelector('[data-act="q-open"]');
  if (card) {
    card.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await waitFor(() => (window.document.querySelector('#main')?.textContent || '').includes('做对了'), 10000);
    const detailMath = window.document.querySelectorAll('#main .katex').length;
    check('单题详情页公式已渲染', detailMath > 0, `${detailMath} 个 .katex`);
  }

  // 周报：Markdown 结构
  window.location.hash = '#/report';
  await waitFor(() => window.document.querySelector('#main')?.dataset?.view === 'report');
  await waitFor(() => window.document.querySelector('#main .md'), 10000);
  const md = window.document.querySelector('#main .md');
  if (md) {
    const heads = md.querySelectorAll('h2, h3').length;
    check('周报 Markdown 渲染成了标题结构（不是一坨原文）', heads > 0, `${heads} 个标题`);
    check('周报里没有残留的 Markdown 记号',
      !/^##\s/m.test(md.textContent) && !/\*\*/.test(md.textContent),
      (md.textContent.match(/^##\s.*/m) || [''])[0].slice(0, 40));
  } else {
    check('周报 Markdown 渲染', false, '没找到 .md 容器');
  }
}

// ---------------------------------------------------------------- 结果
if (pageErrors.length) {
  console.log('\n  运行时错误：');
  for (const e of [...new Set(pageErrors)].slice(0, 8)) console.log(`    · ${String(e).slice(0, 160)}`);
}

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.extra ? ` — ${r.extra}` : ''}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${'='.repeat(46)}`);
console.log(`  渲染检查：通过 ${results.length - failed}   失败 ${failed}   运行时错误 ${pageErrors.length}`);
console.log('='.repeat(46) + '\n');
process.exit(failed ? 1 : 0);
