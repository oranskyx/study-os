// 手机端真机适配检查：用无头 Edge + CDP 在真实浏览器引擎里量尺寸。
// jsdom 没有排版引擎，量不出溢出，所以这项必须用真浏览器。
//
// 用法：先起服务，然后 node tools/mobilecheck.mjs [URL]
// 默认量本机局域网 IP，顺便证明「手机走局域网地址能打开」这条链路是通的。
import { launchEdge, sleep } from './cdp.mjs';

const results = [];
const check = (name, ok, extra = '') => results.push({ name, ok: Boolean(ok), extra });

let cdp;
try {
  cdp = await launchEdge({ width: 390, height: 844, deviceScaleFactor: 3 });
} catch (e) {
  // 用 2 表示「跳过」，别用 0 —— 否则这一套一项没跑也显示"通过"，是假绿灯。
  if (e.code === 'NO_EDGE') { console.error('没找到 Edge，无法做手机端检查（跳过，退出码 2）'); process.exit(2); }
  console.error(e.message);
  process.exit(1);
}
const { send, evaluate, waitUntil } = cdp;

// ---------------------------------------------------------------- 视口实测
const VIEWPORTS = [
  { name: 'iPhone 12/13 (390×844)', w: 390, h: 844 },
  { name: '小屏安卓 (360×640)', w: 360, h: 640 },
  { name: '大屏 iPhone (414×896)', w: 414, h: 896 },
];

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:7788';

await send('Page.enable');
await send('Runtime.enable');
const MEASURE = `(() => {
  const vw = window.innerWidth;
  const de = document.documentElement;
  const nav = document.querySelector('nav.tabbar');
  const navRect = nav ? nav.getBoundingClientRect() : null;
  const navBtns = nav ? [...nav.querySelectorAll('button')] : [];
  const btnH = navBtns.map(b => Math.round(b.getBoundingClientRect().height));
  const btnW = navBtns.map(b => Math.round(b.getBoundingClientRect().width));

  // 找出所有超出右边界的元素（排除本来就该横向滚动的容器）
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1.5) {
      let p = el.parentElement, inScroller = false;
      while (p) {
        const st = getComputedStyle(p);
        if (st.overflowX === 'auto' || st.overflowX === 'scroll') { inScroller = true; break; }
        p = p.parentElement;
      }
      if (!inScroller) offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 30),
        right: Math.round(r.right),
      });
    }
  }

  const inputs = [...document.querySelectorAll('input, select, textarea')]
    .filter(el => el.offsetParent !== null)
    .map(el => ({ tag: el.tagName.toLowerCase(), fs: parseFloat(getComputedStyle(el).fontSize) }));

  const smallTargets = [...document.querySelectorAll('button, a, [data-act]')]
    .filter(el => el.offsetParent !== null)
    .map(el => ({
      label: (el.textContent || '').trim().slice(0, 12),
      h: Math.round(el.getBoundingClientRect().height),
      w: Math.round(el.getBoundingClientRect().width),
    }))
    .filter(t => t.h < 32 || t.w < 32);

  return {
    vw,
    scrollWidth: de.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    hasViewportMeta: !!document.querySelector('meta[name=viewport]'),
    viewportContent: document.querySelector('meta[name=viewport]')?.content || '',
    navFixed: nav ? getComputedStyle(nav).position : null,
    navBottomGap: navRect ? Math.round(window.innerHeight - navRect.bottom) : null,
    navCount: navBtns.length,
    navBtnH: btnH, navBtnW: btnW,
    offenders: offenders.slice(0, 6),
    offenderCount: offenders.length,
    inputs,
    inputFontSizes: [...new Set(inputs.map(i => i.fs))],
    smallTargets: smallTargets.slice(0, 6),
    smallTargetCount: smallTargets.length,
    view: document.querySelector('#main')?.dataset?.view || null,
    title: document.querySelector('header.top h1')?.textContent || '',
  };
})()`;

for (const vp of VIEWPORTS) {
  console.log(`── ${vp.name} ──`);
  await send('Emulation.setDeviceMetricsOverride', {
    width: vp.w,
    height: vp.h,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await send('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36',
  });
  await send('Page.navigate', { url: BASE });
  const ready = await waitUntil(
    `!!(document.querySelector('#main') && document.querySelector('#main').dataset.view)`,
    20000
  );

  const m = await evaluate(MEASURE);
  check(`[${vp.w}] 页面加载出内容`, ready && m.view, `视图=${m.view}`);

  check(
    `[${vp.w}] 没有横向溢出`,
    m.scrollWidth <= vp.w + 1 && m.bodyScrollWidth <= vp.w + 1,
    `scrollWidth=${m.scrollWidth} / 视口=${m.vw}${m.offenderCount ? ` · 溢出元素 ${m.offenderCount} 个: ${JSON.stringify(m.offenders)}` : ''}`
  );

  check(
    `[${vp.w}] 底部导航固定在底部`,
    m.navFixed === 'fixed' && m.navBottomGap === 0 && m.navCount >= 5,
    `position=${m.navFixed} · 距底=${m.navBottomGap}px · ${m.navCount} 个入口`
  );

  check(
    `[${vp.w}] 导航按钮高度够点`,
    m.navBtnH.length > 0 && Math.min(...m.navBtnH) >= 36,
    `高度 ${JSON.stringify(m.navBtnH)}`
  );

  check(
    `[${vp.w}] 触摸目标不小于 32px`,
    m.smallTargetCount === 0,
    m.smallTargetCount ? `${m.smallTargetCount} 个偏小: ${JSON.stringify(m.smallTargets)}` : '全部达标'
  );

  // 输入框只在设置页/采集页出现，单独量一遍
  await send('Page.navigate', { url: `${BASE}#/settings` });
  const settingsReady = await waitUntil(
    `document.querySelector('#main')?.dataset.view === 'settings'`,
    15000
  );
  const s = await evaluate(`(() => {
    const els = [...document.querySelectorAll('input, select, textarea')]
      .filter(el => el.offsetParent !== null);
    return {
      view: document.querySelector('#main')?.dataset?.view || null,
      count: els.length,
      sizes: [...new Set(els.map(el => parseFloat(getComputedStyle(el).fontSize)))],
      tags: [...new Set(els.map(el => el.tagName.toLowerCase()))],
    };
  })()`);
  check(
    `[${vp.w}] 输入框字号 ≥16px（iOS 聚焦时不缩放）`,
    settingsReady && s.count > 0 && s.sizes.every((f) => f >= 16),
    `${s.count} 个输入框 [${s.tags.join(',')}] 字号 ${JSON.stringify(s.sizes)}px` +
      (s.sizes.some((f) => f < 16) ? ' ← 会被 iOS 强制放大' : '')
  );

  // 拍照/相册：必须两个入口，且「拍照」要能强制调起相机
  await send('Page.navigate', { url: `${BASE}#/capture` });
  const capReady = await waitUntil(
    `document.querySelector('#main')?.dataset.view === 'capture'`,
    15000
  );
  const cap = await evaluate(`(() => {
    const cam = document.querySelector('#capCam');
    const gal = document.querySelector('#capFile');
    const inLabel = (el) => !!el && !!el.closest('label');
    return {
      view: document.querySelector('#main')?.dataset?.view || null,
      camExists: !!cam,
      camCapture: cam?.getAttribute('capture') ?? null,
      camAccept: cam?.getAttribute('accept') ?? null,
      camInLabel: inLabel(cam),
      galExists: !!gal,
      galCapture: gal?.getAttribute('capture') ?? null,
      galAccept: gal?.getAttribute('accept') ?? null,
      galInLabel: inLabel(gal),
      btnLabels: [...document.querySelectorAll('#main label.btn')].map((l) =>
        (l.textContent || '').trim()
      ),
    };
  })()`);

  check(
    `[${vp.w}] 录入页有「拍照」入口且带 capture`,
    capReady && cap.camExists && cap.camCapture === 'environment' && cap.camAccept === 'image/*',
    `capture=${cap.camCapture} accept=${cap.camAccept} · 按钮 ${JSON.stringify(cap.btnLabels)}`
  );
  check(
    `[${vp.w}] 「拍照」用 label 包住 input（否则浏览器会忽略 capture 直接开相册）`,
    cap.camInLabel,
    cap.camInLabel ? '在 label 内，是真实用户手势' : '不在 label 内，只能靠 JS 点击'
  );
  check(
    `[${vp.w}] 另有「从相册选」入口（不强制相机）`,
    cap.galExists && cap.galCapture === null && cap.galAccept === 'image/*' && cap.galInLabel,
    `capture=${cap.galCapture} accept=${cap.galAccept}`
  );

  // 长公式和表格最容易横向溢出，每个内容页都量一遍
  const ROUTES = [
    ['#/capture', '录入'],
    ['#/bank', '错题库'],
    ['#/sheet', '复习单'],
    ['#/report', '周报'],
  ];
  for (const [hash, name] of ROUTES) {
    await send('Page.navigate', { url: `${BASE}${hash}` });
    const ok = await waitUntil(
      `document.querySelector('#main')?.dataset.view === '${hash.slice(2)}'`,
      15000
    );
    await sleep(600); // 等 KaTeX 渲染完再量，否则量的是渲染前的高度
    const o = await evaluate(`(() => ({
      sw: document.documentElement.scrollWidth,
      vw: window.innerWidth,
      katex: document.querySelectorAll('.katex').length,
      wide: [...document.querySelectorAll('table')].map(t => Math.round(t.scrollWidth)),
    }))()`);
    check(
      `[${vp.w}] ${name}页不横向溢出`,
      ok && o.sw <= o.vw + 1,
      `scrollWidth=${o.sw} · 公式 ${o.katex} 个` +
        (o.wide.length ? ` · 表格宽 ${JSON.stringify(o.wide)}` : '')
    );
  }

  console.log('');
}

// ---------------------------------------------------------------- 结果
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.extra ? ` — ${r.extra}` : ''}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${'='.repeat(46)}`);
console.log(`  手机端检查：通过 ${results.length - failed}   失败 ${failed}`);
console.log('='.repeat(46) + '\n');

cdp.close();
process.exit(failed ? 1 : 0);
