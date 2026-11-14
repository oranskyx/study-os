// 无头 Edge + CDP 的最小封装。
// 之前 designcheck / cropcheck / cropcheck-extra 各自抄了一遍启动与 CDP 客户端
// （每份约 70 行），参数还越抄越不一致。这里只留一份。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const findEdge = () => CANDIDATES.find((p) => existsSync(p));

/**
 * 起一个无头 Edge，返回 { send, evaluate, waitUntil, close }。
 * 没有 Edge 时抛 { code: 'NO_EDGE' }，调用方自行决定跳过还是失败。
 */
export async function launchEdge({ width = 390, height = 844, deviceScaleFactor = 1, mobile = true } = {}) {
  const edge = findEdge();
  if (!edge) {
    const err = new Error('没找到 Edge');
    err.code = 'NO_EDGE';
    throw err;
  }
  const port = 9300 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(path.join(tmpdir(), 'sos-cdp-'));
  const child = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--force-device-scale-factor=' + deviceScaleFactor,
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--window-size=' + width + ',' + height, 'about:blank',
  ], { stdio: 'ignore' });

  const close = () => {
    try { child.kill(); } catch { /* 已退出 */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 占用中 */ }
  };
  process.on('exit', close);

  const deadline = Date.now() + 20000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { up = true; break; }
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!up) { close(); throw new Error('Edge DevTools 起不来'); }

  const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then((r) => r.json());
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  if (width) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
  }

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.error) throw new Error(r.error.message);
    return r.result?.result?.value;
  };

  const waitUntil = async (expr, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await evaluate(expr)) return true; } catch { /* 页面还在加载 */ }
      await sleep(200);
    }
    return false;
  };

  const closeWs = () => { try { ws.close(); } catch { /* 已关 */ } close(); };
  return { send, evaluate, waitUntil, close: closeWs, port };
}
