// 设计体检：用无头 Edge + CDP 量真实排版与配色，并输出截图。
// 目的：在没有"眼睛"的情况下，用可核对的数据判断页面是否可读、是否溢出、对比度是否达标。
//
// 用法：node tools/designcheck.mjs [BASE] [--routes=/,/bank] [--widths=390,1280]
// 依赖服务已启动（默认 http://127.0.0.1:7790），截图写到 data/_shots/design/。

import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'http://127.0.0.1:7790';
const argOf = (k, d) => {
  const a = process.argv.find((x) => x.startsWith('--' + k + '='));
  return a ? a.slice(('--' + k + '=').length) : d;
};
const ROUTES = argOf('routes', '/,/capture,/bank,/sheet,/report,/settings').split(',').map((s) => s.trim()).filter(Boolean);
const WIDTHS = argOf('widths', '390,1280').split(',').map(Number);
const OUT = path.resolve('data/_shots/design');
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
if (!EDGE) { console.error('没找到 Edge，跳过（退出码 2）'); process.exit(2); }

const PORT = 9400 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-design-'));
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--force-device-scale-factor=2',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { child.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

async function waitCdp(timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if ((await fetch('http://127.0.0.1:' + PORT + '/json/version')).ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}
if (!(await waitCdp())) { console.error('Edge DevTools 起不来'); process.exit(1); }

const targets = await fetch('http://127.0.0.1:' + PORT + '/json/list').then((r) => r.json());
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');

const METRICS = `(() => {
  const rgb = (s) => { const m = String(s).match(/[\d.]+/g); return m ? m.map(Number) : null; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const blend = (fg, bg) => { const a = fg.length > 3 ? fg[3] : 1; return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a))); };
  const bgOf = (el) => {
    let node = el, out = [255, 255, 255];
    while (node && node !== document.documentElement) {
      const c = rgb(getComputedStyle(node).backgroundColor);
      if (c && (c.length < 4 || c[3] > 0.05)) { out = c.length > 3 ? blend(c, out) : c.slice(0, 3); break; }
      node = node.parentElement;
    }
    return out;
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };

  const fonts = {}, sizes = [], lowContrast = [], smallTargets = [], radii = {}, sticky = [];
  let shadows = 0;
  const all = [...document.querySelectorAll('body *')];
  for (const el of all) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
    if (txt) {
      const fs = parseFloat(s.fontSize);
      fonts[fs] = (fonts[fs] || 0) + 1;
      sizes.push(fs);
      const fg = rgb(s.color);
      if (fg) {
        const bg = bgOf(el);
        const fgx = fg.length > 3 ? blend(fg, bg) : fg.slice(0, 3);
        const cr = ratio(fgx, bg);
        const bold = Number(s.fontWeight) >= 600;
        const large = fs >= 24 || (bold && fs >= 18.66);
        if (cr < (large ? 3 : 4.5)) lowContrast.push({ text: txt.slice(0, 24), fs, cr: Math.round(cr * 100) / 100, fg: s.color, bg: 'rgb(' + bg.join(',') + ')' });
      }
    }
    if (['BUTTON', 'A', 'SELECT', 'INPUT', 'TEXTAREA', 'LABEL'].includes(el.tagName)) {
      const r = el.getBoundingClientRect();
      if (el.tagName !== 'LABEL' || el.control) {
        if (r.height > 0 && (r.height < 43.5 || (el.tagName === 'A' && r.width < 43.5 && r.height < 43.5))) {
          smallTargets.push({ tag: el.tagName, text: (el.textContent || el.value || '').trim().slice(0, 18), w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
    }
    const rad = s.borderRadius && s.borderRadius !== '0px' ? s.borderRadius : null;
    if (rad) radii[rad] = (radii[rad] || 0) + 1;
    if (s.boxShadow && s.boxShadow !== 'none') shadows++;
    if ((s.position === 'sticky' || s.position === 'fixed') && el.tagName !== 'BODY') sticky.push({ tag: el.tagName, cls: el.className && String(el.className).slice(0, 30) });
  }
  const over = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = getComputedStyle(el);
    const clips = ['auto', 'hidden', 'scroll', 'clip'].includes(s.overflowX);
    if (!clips && (r.right > innerWidth + 1 || el.scrollWidth > el.clientWidth + 1)) {
      over.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 28), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), sw: el.scrollWidth, text: (el.textContent || '').trim().slice(0, 20) });
    }
  }
  const root = getComputedStyle(document.documentElement);
  const vars = {};
  for (const k of ['--bg', '--card', '--ink', '--ink-2', '--muted', '--line', '--accent', '--r']) vars[k] = root.getPropertyValue(k).trim();
  const main = document.querySelector('main');
  const mr = main ? main.getBoundingClientRect() : null;
  return {
    route: location.hash || '#/',
    title: document.title,
    view: (document.getElementById('main') || {}).dataset ? document.getElementById('main').dataset.view : null,
    viewport: { w: innerWidth, h: innerHeight },
    overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    overflowers: over.slice(0, 8),
    docHeight: document.documentElement.scrollHeight,
    fonts, textCount: sizes.length,
    minText: sizes.length ? Math.min(...sizes) : null,
    lowContrast: lowContrast.slice(0, 12), lowContrastCount: lowContrast.length,
    smallTargets: smallTargets.slice(0, 10), smallTargetCount: smallTargets.length,
    radii, shadowCount: shadows, sticky: sticky.slice(0, 8),
    mainWidth: mr ? Math.round(mr.width) : null,
    vars,
    bodyFont: getComputedStyle(document.body).font,
  };
})()`;

const report = [];
for (const width of WIDTHS) {
  const height = width < 600 ? 844 : 900;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 600 });
  for (const route of ROUTES) {
    const url = route.includes('.html') ? BASE + route : BASE + '/#' + (route === '/' ? '' : route);
    await send('Page.navigate', { url });
    await sleep(Number(argOf('wait', 1400)));
    const act = argOf('act', '');
    if (act) {
      await send('Runtime.evaluate', { expression: 'document.querySelector(' + JSON.stringify(act) + ') && document.querySelector(' + JSON.stringify(act) + ').click()' });
      await sleep(1600);
    }
    let m = null;
    try {
      const r = await send('Runtime.evaluate', { expression: METRICS, returnByValue: true, awaitPromise: true });
      m = r.result && r.result.value;
      if (r.exceptionDetails) m = { error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || '').split('\n').slice(0, 3).join(' | ') };
    } catch (e) { m = { error: String(e.message).slice(0, 120) }; }
    let shot = null;
    try {
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const name = (route.replace(/[^a-z0-9]+/gi, '') || 'home') + '-' + width + '.png';
      writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64'));
      shot = name;
    } catch {}
    report.push({ width, route, shot, metrics: m });
    if (process.argv.includes('--dump')) {
      const d = await send('Runtime.evaluate', { expression: 'document.body.innerText.replace(/\\s+/g," ").slice(0,1600)', returnByValue: true });
      console.log('  [text] ' + (d.result && d.result.value));
    }
    const mm = m || {};
    if (mm.error) console.log('  [metrics error] ' + mm.error);
    console.log('[' + width + 'px] ' + route.padEnd(12) + ' view=' + String(mm.view) + ' 溢出=' + mm.overflowX + 'px  文本块=' + mm.textCount + '  最小字号=' + mm.minText + '  低对比度=' + mm.lowContrastCount + '  小触控=' + mm.smallTargetCount + '  圆角种类=' + Object.keys(mm.radii || {}).length + '  阴影=' + mm.shadowCount);
  }
}
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(String.fromCharCode(10) + '截图与报告：' + OUT);
process.exit(0);
