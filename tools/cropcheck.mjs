// 裁切编辑器对齐检查：裁切框必须和图片像素级重合，旋转/缩放后也不能偏。
// 用法：先起服务 + 本地 mock，然后 node tools/cropcheck.mjs [BASE]
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardSettings } from './settings-guard.mjs';
import { launchEdge, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:7788';
const MOCK = process.env.MOCK || 'http://127.0.0.1:7799/v1';
const PHOTO = path.join(ROOT, 'data', '_crop_test.jpg');
const results = [];
const check = (n, ok, extra = '') => results.push({ n, ok: Boolean(ok), extra });

if (!existsSync(PHOTO)) {
  console.error('缺少测试图片：' + PHOTO);
  process.exit(1);
}

const guard = guardSettings();
await fetch(BASE + '/api/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    vision: { baseUrl: MOCK, apiKey: 'mock', model: 'mock-vl-1' },
    text: { baseUrl: MOCK, apiKey: 'mock', model: 'mock-text-1' },
  }),
});

let cdp;
try {
  cdp = await launchEdge({ width: 390, height: 844, deviceScaleFactor: 3 });
} catch (e) {
  if (e.code === 'NO_EDGE') { console.error('没找到 Edge，跳过（退出码 2）'); process.exit(2); }
  console.error(e.message);
  process.exit(1);
}
const { send, evaluate, waitUntil } = cdp;
process.on('exit', () => guard.restore());

/** 量一次：图片矩形 vs 裁切框矩形，返回偏差 */
const measure = () => evaluate(`(() => {
  const v = document.querySelector('.ed-view');
  const c = document.querySelector('.ed-crop');
  if (!v || !c) return null;
  const a = v.getBoundingClientRect();
  const b = c.getBoundingClientRect();
  const full = b.width >= a.width - 3 && b.height >= a.height - 3;
  return {
    dx: Math.round(b.left - a.left), dy: Math.round(b.top - a.top),
    dw: Math.round(a.width - b.width), dh: Math.round(a.height - b.height),
    img: [Math.round(a.width), Math.round(a.height)],
    box: [Math.round(b.width), Math.round(b.height)],
    full,
  };
})()`);

await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Page.navigate', { url: `${BASE}/#/capture` });
await waitUntil(`document.querySelector('#main')?.dataset.view === 'capture'`);
await sleep(500);

let opened = false;
for (let a = 0; a < 5 && !opened; a++) {
  const { result: doc } = await send('DOM.getDocument', { depth: -1 });
  const { result: node } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#capCam' });
  if (!node?.nodeId) { await sleep(400); continue; }
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [PHOTO] });
  opened = await waitUntil(`!!document.querySelector('.ed-view')`, 6000);
}
check('选完图弹出裁切编辑器', opened);

await sleep(400);
const m1 = await measure();
check('默认全图：裁切框和图片完全重合',
  m1 && m1.full && Math.abs(m1.dx) <= 1 && Math.abs(m1.dy) <= 1,
  m1 ? `偏移 ${m1.dx},${m1.dy} · 图 ${m1.img} · 框 ${m1.box}` : '量不到');

// 右转 90° 后仍要重合（旋转会改宽高比，最容易暴露偏移）
await evaluate(`document.querySelector('[data-ed="rotR"]').click()`);
await sleep(600);
const m2 = await measure();
check('旋转 90° 后裁切框仍然贴合图片',
  m2 && m2.full && Math.abs(m2.dx) <= 1 && Math.abs(m2.dy) <= 1,
  m2 ? `偏移 ${m2.dx},${m2.dy} · 图 ${m2.img}` : '量不到');

// 缩小后再量：框的左上角必须还贴着图片上的对应点
await evaluate(`(() => {
  const h = document.querySelector('.ed-crop [data-h="se"]');
  const r = h.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const o = (cx, cy) => ({ bubbles: true, cancelable: true, composed: true, pointerId: 1, clientX: cx, clientY: cy });
  h.dispatchEvent(new PointerEvent('pointerdown', o(x, y)));
  window.dispatchEvent(new PointerEvent('pointermove', o(x - 60, y - 60)));
  window.dispatchEvent(new PointerEvent('pointerup', o(x - 60, y - 60)));
})()`);
await sleep(400);
const m3 = await measure();
check('缩小后框仍在图片范围内且左上角不偏',
  m3 && Math.abs(m3.dx) <= 1 && Math.abs(m3.dy) <= 1 && m3.dw > 20 && m3.dh > 20,
  m3 ? `偏移 ${m3.dx},${m3.dy} · 框 ${m3.box} / 图 ${m3.img}` : '量不到');

// 再拖回全图大小（用户反馈：缩小后拉不回去）
await evaluate(`(() => {
  const h = document.querySelector('.ed-crop [data-h="se"]');
  const r = h.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const o = (cx, cy) => ({ bubbles: true, cancelable: true, composed: true, pointerId: 1, clientX: cx, clientY: cy });
  h.dispatchEvent(new PointerEvent('pointerdown', o(x, y)));
  window.dispatchEvent(new PointerEvent('pointermove', o(x + 400, y + 400)));
  window.dispatchEvent(new PointerEvent('pointerup', o(x + 400, y + 400)));
})()`);
await sleep(400);
const m4 = await measure();
check('缩小后能重新拉回整张图',
  m4 && m4.full,
  m4 ? `框 ${m4.box} / 图 ${m4.img}` : '量不到');

cdp.close();
guard.restore();

console.log('');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.n}${r.extra ? ` — ${r.extra}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n  裁切对齐检查：通过 ${results.length - failed}   失败 ${failed}\n`);
process.exit(failed ? 1 : 0);
