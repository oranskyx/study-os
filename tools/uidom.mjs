// 前端 DOM 级验证：用 jsdom 真正执行 public/app.js，逐个视图渲染并检查 DOM。
// 不依赖图形环境，能抓到白屏、运行时报错、事件绑定失效这类问题。
// 用法：先起服务，然后 node tools/uidom.mjs

import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardSettings, hardDeleteQuestions } from './settings-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:7788';

// 设置页那段会真的写库；跑完必须把你原来的 key 原样还回去
const settingsGuard = guardSettings();

// 跑之前先实测一次"当前生效的模型"，收尾时拿它比对（不读表里的快照，
// 因为干净环境里配置可能全来自 .env/默认值，表里压根没有这一行）
const visionModelAtStart = await globalThis
  .fetch(`${BASE}/api/settings`)
  .then((r) => r.json())
  .then((d) => d.config?.vision?.model ?? null)
  .catch(() => null);

const results = [];
const check = (name, ok, extra = '') => results.push({ name, ok: Boolean(ok), extra });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 依赖外部进程（mock 服务）的断言：条件不满足时明确跳过，而不是假装失败 */
const skips = [];
const skip = (name, why) => skips.push({ name, why });

async function waitFor(fn, { timeout = 6000, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await fn()) return true; } catch { /* 继续等 */ }
    await sleep(100);
  }
  return false;
}

const html = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appJs = readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

const pageErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => pageErrors.push(`jsdomError: ${e.message}`));
vc.on('error', (...a) => pageErrors.push(`console.error: ${a.join(' ')}`));

const dom = new JSDOM(html, {
  url: `${BASE}/`,
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;

// jsdom 没有 fetch，也没法解析相对路径 —— 代理到真实服务
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? new URL(input, BASE).toString() : input;
  return globalThis.fetch(url, init);
};
window.addEventListener('error', (e) => pageErrors.push(`window.error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  pageErrors.push(`unhandledrejection: ${e.reason}`)
);

// ---------------------------------------------------------------- 执行应用
try {
  window.eval(appJs);
} catch (e) {
  console.log(`\n✗ app.js 执行即抛错：${e.message}\n${e.stack}`);
  process.exit(1);
}

const $ = (s) => window.document.querySelector(s);
const mainText = () => ($('#main')?.textContent || '').replace(/\s+/g, ' ').trim();

const booted = await waitFor(() => mainText().length > 20, { label: '首屏渲染' });
check('首屏完成渲染（不是白屏 / 不是一直"加载中"）', booted, `正文 ${mainText().length} 字`);
check('顶部周期标签已填充', ($('#weekLabel')?.textContent || '').includes('-W'), $('#weekLabel')?.textContent || '空');
check('底部导航渲染了 6 个页签', window.document.querySelectorAll('#tabbar button').length === 6,
  `${window.document.querySelectorAll('#tabbar button').length} 个`);

// ---------------------------------------------------------------- 逐视图
// 用 #main 的 data-view 标记判定"真的切过去了"，
// 否则可能拿上一个视图的残留文本误判为通过（假绿灯）。
const views = [
  ['home', '总览'],
  ['bank', '头次错'],
  ['sheet', '复习单'],
  ['report', '重做正确率'],
  ['settings', '识题'],
  ['capture', '拍一页错题本'],
];

for (const [view, marker] of views) {
  window.location.hash = `#/${view}`;
  const switched = await waitFor(
    () => window.document.querySelector('#main')?.dataset?.view === view,
    { label: view }
  );
  const settled = await waitFor(() => mainText().includes(marker), { label: `${view}:marker` });
  const t = mainText();
  const isError = window.document.querySelector('#main')?.dataset?.view === `${view}:error`;

  check(`视图 ${view} 真的切换过去了`, switched, `data-view=${window.document.querySelector('#main')?.dataset?.view}`);
  check(`视图 ${view} 渲染出该视图专有内容`, settled, `找「${marker}」，实际开头「${t.slice(0, 44)}」`);
  check(`视图 ${view} 没有渲染异常`, !isError && !t.includes('请求失败') && !t.includes('Cannot read'),
    isError ? '落入 error 分支' : '');
}

// ---------------------------------------------------------------- 交互
// 造一道临时题，保证交互测试不依赖库里已有数据；测完删掉。
const seedRes = await globalThis.fetch(`${BASE}/api/questions/bulk`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    questions: [
      { stem: '临时测试题：求 $1+1$。', kp_name: '集合的概念与表示', correct_answer: '2', difficulty: 1 },
    ],
  }),
}).then((r) => r.json());
const tmpIds = seedRes.ids || [];
check('可通过接口造题（供交互测试）', tmpIds.length === 1, `id=${tmpIds[0]}`);

window.location.hash = '#/bank';
await waitFor(() => window.document.querySelector('#main')?.dataset?.view === 'bank');
await waitFor(() => window.document.querySelectorAll('[data-act="q-open"]').length > 0);

const cards = window.document.querySelectorAll('[data-act="q-open"]');
check('错题库渲染出题目卡片（可点击）', cards.length > 0, `${cards.length} 张`);

// 筛选按钮
const keyFilter = window.document.querySelector('[data-act="bank-filter"][data-status="key"]');
check('筛选按钮存在', Boolean(keyFilter));
if (keyFilter) {
  keyFilter.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => window.document.querySelector('[data-act="bank-filter"][data-status="key"].primary'));
  check('点「重点错题」筛选后按钮高亮',
    Boolean(window.document.querySelector('[data-act="bank-filter"][data-status="key"].primary')));

  // 复位筛选，否则下一步找不到刚造的「头次错」题
  const allFilter = window.document.querySelector('[data-act="bank-filter"][data-status="all"]');
  if (allFilter) {
    allFilter.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await waitFor(() => window.document.querySelector(`[data-act="q-open"][data-id="${tmpIds[0]}"]`));
    check('点「全部」筛选后能复位', Boolean(window.document.querySelector('[data-act="bank-filter"][data-status="all"].primary')));
  }
}

// 点刚造的那张卡进详情
window.location.hash = '#/bank';
await waitFor(() => window.document.querySelector('#main')?.dataset?.view === 'bank');
await waitFor(() => window.document.querySelector(`[data-act="q-open"][data-id="${tmpIds[0]}"]`));

const target = window.document.querySelector(`[data-act="q-open"][data-id="${tmpIds[0]}"]`);
check('能在列表里定位到刚造的题', Boolean(target));
if (target) {
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const ok = await waitFor(() => mainText().includes('做对了') && mainText().includes('变式题'));
  check(`点卡片进入单题详情（#${tmpIds[0]}）`, ok, window.location.hash);
  check('详情页有「这次做对了 / 又错了」按钮',
    window.document.querySelectorAll('[data-act="mark"]').length === 2);
  check('详情页有「AI 深挖错因」「出变式题」',
    Boolean(window.document.querySelector('[data-act="diagnose"]')) &&
    Boolean(window.document.querySelector('[data-act="variants"]')));

  const kpSel = window.document.querySelector('select[data-act="setKp"]');
  check('详情页有考点下拉框', Boolean(kpSel), kpSel ? `当前「${kpSel.value}」` : '');
  if (kpSel) {
    const before = kpSel.value;
    kpSel.value = '函数的奇偶性';
    kpSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    const saved = await waitFor(() => {
      const s = window.document.querySelector('select[data-act="setKp"]');
      return s && s.value === '函数的奇偶性';
    });
    const persisted = await globalThis
      .fetch(`${BASE}/api/questions/${tmpIds[0]}`)
      .then((r) => r.json())
      .then((d) => d.question?.kp_name);
    check('改考点后前端刷新且已落库', saved && persisted === '函数的奇偶性',
      `「${before}」→「${persisted}」`);
  }
}

// 导航点击
window.location.hash = '#/home';
await sleep(800);
const navBtn = window.document.querySelector('[data-act="nav"][data-to="capture"]');
check('首页有「拍照录入」入口', Boolean(navBtn));
if (navBtn) {
  navBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(900);
  check('点「拍照录入」跳到录入页', window.location.hash.includes('capture'), window.location.hash);
  check('录入页有文件选择控件', Boolean($('#capFile')));
}

// ---------------------------------------------------------------- 打印页
{
  const meta = await globalThis.fetch(`${BASE}/api/meta`).then((r) => r.json());
  void meta;
  const sheetRes = await globalThis.fetch(`${BASE}/api/sheet`).then((r) => r.json());
  if (sheetRes.sheet) {
    check('复习单接口可供打印页使用', Array.isArray(sheetRes.items), `${sheetRes.items.length} 条`);
  } else {
    // 没有单子时也走一遍生成，验证打印数据形状
    const built = await globalThis.fetch(`${BASE}/api/sheet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ perDay: 4 }),
    }).then((r) => r.json());
    check('打印所需复习单可生成', Number.isFinite(built.sheetId), `sheetId=${built.sheetId} total=${built.total}`);
  }
}

// ---------------------------------------------------------------- 设置页：可视化配置
const MOCK = process.env.MOCK || 'http://127.0.0.1:7799/v1';

window.location.hash = '#/settings';
await waitFor(() => window.document.querySelector('#main')?.dataset?.view === 'settings');
await waitFor(() => window.document.querySelector('[data-set="vision.baseUrl"]'));

const baseIn = window.document.querySelector('[data-set="vision.baseUrl"]');
const keyIn = window.document.querySelector('[data-set="vision.apiKey"]');
const modelIn = window.document.querySelector('[data-set="vision.model"]');
check('设置页有 Base URL / API Key / 模型 三个输入框',
  Boolean(baseIn && keyIn && modelIn));
check('API Key 是密码框且不回显已存的 key',
  keyIn?.type === 'password' && keyIn?.value === '');
check('页面上没有明文 API Key',
  !/sk-[A-Za-z0-9]{8,}/.test(window.document.querySelector('#main').textContent));

// 服务商预设一键填表
const presetSel = window.document.querySelector('[data-act="preset"][data-kind="vision"]');
check('有服务商预设下拉（不是写死一家）', Boolean(presetSel),
  presetSel ? `${presetSel.options.length - 1} 个预设` : '');
if (presetSel) {
  presetSel.value = 'zhipu';
  presetSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => (window.document.querySelector('[data-set="vision.baseUrl"]')?.value || '').includes('bigmodel'));
  const b2 = window.document.querySelector('[data-set="vision.baseUrl"]').value;
  const m2 = window.document.querySelector('[data-set="vision.model"]').value;
  check('选预设后自动填好 Base URL 和模型名',
    b2.includes('bigmodel') && m2 === 'glm-4v-flash', `${b2} · ${m2}`);
}

// 获取模型列表：需要本地 mock 服务在跑，否则跳过而不是判失败
const setInput = (sel, val) => {
  const el = window.document.querySelector(sel);
  if (!el) return false;
  el.value = val;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  return true;
};

let mockUp = false;
try {
  const r = await globalThis.fetch(`${MOCK}/models`, { signal: AbortSignal.timeout(2500) });
  mockUp = r.ok;
} catch { mockUp = false; }

if (!mockUp) {
  skip('「获取模型列表」成功并渲染成下拉框', `mock 服务没运行（${MOCK}）`);
  skip('从下拉里选模型后回填到模型输入框', '依赖上一条');
  skip('点保存后配置真的落库并生效', '避免把测试配置写进你的真实配置');
  skip('保存后出现「清除这个 key」按钮', '依赖上一条');
} else {
  setInput('[data-set="vision.baseUrl"]', MOCK);
  setInput('[data-set="vision.apiKey"]', 'mock');
  window.document.querySelector('[data-act="fetch-models"][data-kind="vision"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const gotDropdown = await waitFor(
    () => window.document.querySelector('select[data-set="vision.model"]'),
    { timeout: 15000 }
  );
  const modelSel = window.document.querySelector('select[data-set="vision.model"]');
  check('「获取模型列表」成功并渲染成下拉框', Boolean(gotDropdown),
    modelSel ? `${modelSel.options.length - 1} 个模型` :
    (window.document.querySelector('#main').textContent.match(/拉取模型列表失败[^\n]{0,60}/) || ['没有下拉，也没看到报错'])[0]);

  if (modelSel) {
    modelSel.value = 'mock-vl-1';
    modelSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => window.document.querySelector('[data-set="vision.model"]')?.value === 'mock-vl-1');
    check('从下拉里选模型后回填到模型输入框',
      window.document.querySelector('[data-set="vision.model"]')?.value === 'mock-vl-1');
  }

  // 保存
  window.document.querySelector('[data-act="save-settings"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const saved = await waitFor(async () => {
    const cfg = await globalThis.fetch(`${BASE}/api/settings`).then((r) => r.json());
    return cfg.config?.vision?.baseUrl === MOCK && cfg.config?.vision?.model === 'mock-vl-1';
  }, { timeout: 12000 });
  const cfgNow = await globalThis.fetch(`${BASE}/api/settings`).then((r) => r.json());
  check('点保存后配置真的落库并生效', saved,
    `${cfgNow.config.vision.model} @ ${cfgNow.config.vision.baseUrl} · ready=${cfgNow.config.vision.ready}`);
  check('保存后出现「清除这个 key」按钮',
    Boolean(window.document.querySelector('[data-act="clear-key"]')));
}

// ---------------------------------------------------------------- 还原配置
// 设置页那几条断言会真的改库；这里必须把跑之前的样子原样还回去。
// 用「跑之前实测一次」而不是「读快照表」来比对：干净环境里 settings 表可能
// 根本没有 vision_model 这一行（配置全走 .env/默认），拿表值比会误报。
settingsGuard.restore();
{
  const after = await globalThis.fetch(`${BASE}/api/settings`).then((r) => r.json());
  check('测试跑完后配置已还原（没弄丢你的真实 key 和模型）',
    after.config?.vision?.model === visionModelAtStart,
    `${after.config?.vision?.model} @ ${after.config?.vision?.baseUrl}（跑之前是 ${visionModelAtStart}）`);
}

// ---------------------------------------------------------------- 清理
// 放在最后：前面检查打印数据时还需要这道题在场。
// 走接口删是软删除，所以再真删一遍，别在库里留测试行。
for (const id of tmpIds) {
  await globalThis.fetch(`${BASE}/api/questions/${id}`, { method: 'DELETE' });
}
hardDeleteQuestions(tmpIds);

// ---------------------------------------------------------------- 结果
console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.extra ? ` — ${r.extra}` : ''}`);
}

const uniq = [...new Set(pageErrors)];
if (uniq.length) {
  console.log('\n  页面运行时错误：');
  for (const e of uniq.slice(0, 12)) console.log(`    · ${e.slice(0, 240)}`);
}

if (skips.length) {
  console.log('\n  跳过（条件不具备，不算失败）：');
  for (const s of skips) console.log(`    - ${s.name} — ${s.why}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${'='.repeat(46)}`);
console.log(`  DOM 检查：通过 ${results.length - failed}   失败 ${failed}   跳过 ${skips.length}   ${uniq.length ? `运行时错误 ${uniq.length}` : '无运行时错误'}`);
console.log('='.repeat(46) + '\n');

process.exit(failed || uniq.length ? 1 : 0);
