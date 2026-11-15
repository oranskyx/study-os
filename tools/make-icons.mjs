// 把 public/icon.svg 渲染成各尺寸 PNG（Android 主屏图标必须是 PNG）。
//   npm run icons
// 用无头 Edge 截 SVG，不引入图形库、不依赖 ImageMagick。
//
// 只导航一次，之后靠改 SVG 尺寸 + 截当前视口，避免多次 Page.navigate 把 CDP 会话搞掉
// （"Not attached to an active page" 这个错就是这么来的）。
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchEdge, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public');
const svg = readFileSync(path.join(OUT, 'icon.svg'), 'utf8');
const SIZES = [[192, 'icon-192.png'], [512, 'icon-512.png'], [180, 'apple-touch-icon.png'], [256, 'icon-256.png']];

const cdp = await launchEdge({ width: 512, height: 512, deviceScaleFactor: 1, mobile: false });
const { send } = cdp;
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

const html = '<!doctype html><meta charset="utf-8">'
  + '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style>'
  + svg;
await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
await sleep(500);

for (const [size, name] of SIZES) {
  await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  await send('Runtime.evaluate', {
    expression: '(() => { const s = document.querySelector("svg"); s.style.width = "' + size + 'px"; s.style.height = "' + size + 'px"; })()',
  });
  await sleep(180);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const b64 = shot?.result?.data ?? shot?.data;
  if (!b64) throw new Error('截图失败：' + JSON.stringify(shot).slice(0, 120));
  writeFileSync(path.join(OUT, name), Buffer.from(b64, 'base64'));
  console.log('  ' + name + '  ' + size + '×' + size);
}
cdp.close();
console.log('图标已生成：public/icon-*.png + apple-touch-icon.png');
