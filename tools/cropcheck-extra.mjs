// 裁剪编辑器新增能力自检：缩放、重新框选、边把手、双指
// 复用 cropcheck 的 CDP 思路，但只看新功能是否可用。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:7788';
const PHOTO = path.join(ROOT, 'data', '_crop_test.jpg');
const PORT = 9900 + Math.floor(Math.random() * 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, extra = '') => results.push({ n, ok: Boolean(ok), extra });

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
const profile = mkdtempSync(path.join(tmpdir(), 'cropx-'));
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} });

for (let i = 0; i < 80; i++) {
  try { if ((await fetch('http://127.0.0.1:' + PORT + '/json/version')).ok) break; } catch {}
  await sleep(250);
}
const list = await fetch('http://127.0.0.1:' + PORT + '/json/list').then((r) => r.json());
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const waitUntil = async (expr, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(expr)) return true; } catch {}
    await sleep(200);
  }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Page.navigate', { url: BASE + '/#/capture' });
await waitUntil("document.querySelector('#main')?.dataset.view === 'capture'");
await sleep(400);

const { result: doc } = await send('DOM.getDocument', { depth: -1 });
const { result: node } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#capCam' });
await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [PHOTO] });
check('编辑器打开', await waitUntil("!!document.querySelector('.ed-view')", 6000));
await sleep(400);

check('有缩放按钮', (await evaluate("document.querySelectorAll('[data-ed=\"zoomIn\"],[data-ed=\"zoomOut\"]').length === 2")));
check('有重新框选按钮', await evaluate("!!document.querySelector('[data-ed=\"reselect\"]')"));
check('有四边把手', (await evaluate("document.querySelectorAll('.ed-crop i.edge').length")) === 4);

const before = await evaluate("document.querySelector('.ed-view').getBoundingClientRect().width");
await evaluate("document.querySelector('[data-ed=\"zoomIn\"]').click()");
await sleep(400);
const after = await evaluate("document.querySelector('.ed-view').getBoundingClientRect().width");
check('放大后图片真的变大', after > before * 1.2, before.toFixed(0) + 'px → ' + after.toFixed(0) + 'px');
check('缩放比显示更新', /150%/.test((await evaluate("document.querySelector('.ed-zoom-v').textContent")) || ''));

await evaluate("document.querySelector('[data-ed=\"zoomOut\"]').click()");
await sleep(300);
const back = await evaluate("document.querySelector('.ed-view').getBoundingClientRect().width");
check('缩小能回到适应大小', Math.abs(back - before) < 2, back.toFixed(0) + 'px');

// 重新框选 → 框消失，再拖一下能画新框
await evaluate("document.querySelector('[data-ed=\"reselect\"]').click()");
await sleep(300);
const w1 = await evaluate("document.querySelector('.ed-crop').getBoundingClientRect().width");
// 框宽 0 时元素仍有 2px×2 的边框，所以判定放宽到 6px
check('重新框选后框被清空', w1 <= 6, 'w=' + w1.toFixed(1));

await evaluate(`(() => {
  const st = document.querySelector('.ed-stage');
  const r = st.getBoundingClientRect();
  const o = (cx, cy) => ({ bubbles: true, cancelable: true, composed: true, pointerId: 3, clientX: cx, clientY: cy });
  const x = r.left + r.width * 0.3, y = r.top + r.height * 0.3;
  st.dispatchEvent(new PointerEvent('pointerdown', o(x, y)));
  window.dispatchEvent(new PointerEvent('pointermove', o(x + 80, y + 60)));
  window.dispatchEvent(new PointerEvent('pointerup', o(x + 80, y + 60)));
})()`);
await sleep(400);
const w2 = await evaluate("document.querySelector('.ed-crop').getBoundingClientRect().width");
check('清空后能重新画出新框', w2 > 20, 'w=' + w2.toFixed(1));

// 边把手：拖右边只能改宽
await evaluate("document.querySelector('[data-ed=\"reset\"]').click()");
await sleep(300);
const box1 = await evaluate("JSON.stringify(document.querySelector('.ed-crop').getBoundingClientRect())");
await evaluate(`(() => {
  const h = document.querySelector('.ed-crop [data-h="e"]');
  const r = h.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const o = (cx, cy) => ({ bubbles: true, cancelable: true, composed: true, pointerId: 4, clientX: cx, clientY: cy });
  h.dispatchEvent(new PointerEvent('pointerdown', o(x, y)));
  window.dispatchEvent(new PointerEvent('pointermove', o(x - 50, y)));
  window.dispatchEvent(new PointerEvent('pointerup', o(x - 50, y)));
})()`);
await sleep(400);
const box2 = await evaluate("JSON.stringify(document.querySelector('.ed-crop').getBoundingClientRect())");
const a = JSON.parse(box1), b = JSON.parse(box2);
check('拖右边把手只改宽度', Math.abs(b.height - a.height) < 2 && b.width < a.width - 20,
  'h ' + a.height.toFixed(0) + '→' + b.height.toFixed(0) + ' · w ' + a.width.toFixed(0) + '→' + b.width.toFixed(0));

// 双指缩放
await evaluate(`(() => {
  const st = document.querySelector('.ed-stage');
  const r = st.getBoundingClientRect();
  const o = (id, cx, cy) => ({ bubbles: true, cancelable: true, composed: true, pointerId: id, isPrimary: id === 1, clientX: cx, clientY: cy });
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  st.dispatchEvent(new PointerEvent('pointerdown', o(1, cx - 40, cy)));
  st.dispatchEvent(new PointerEvent('pointerdown', o(2, cx + 40, cy)));
  window.dispatchEvent(new PointerEvent('pointermove', o(1, cx - 90, cy)));
  window.dispatchEvent(new PointerEvent('pointermove', o(2, cx + 90, cy)));
  window.dispatchEvent(new PointerEvent('pointerup', o(2, cx + 90, cy)));
  window.dispatchEvent(new PointerEvent('pointerup', o(1, cx - 90, cy)));
})()`);
await sleep(400);
const zoomTxt = await evaluate("document.querySelector('.ed-zoom-v').textContent");
const zoomPct = Number(String(zoomTxt || '').replace('%', ''));
check('双指张开能放大', zoomPct > 100 && zoomPct <= 400, 'zoom=' + zoomTxt);

ws.close();
console.log('');
for (const r of results) console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.n + (r.extra ? ' — ' + r.extra : ''));
const failed = results.filter((r) => !r.ok).length;
console.log('\n  裁剪编辑器：通过 ' + (results.length - failed) + '   失败 ' + failed + '\n');
process.exit(failed ? 1 : 0);
