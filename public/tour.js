// 保姆级新手指引：一步一步告诉刚上手的人「这个按钮是干什么的」。
// 不依赖任何库；挂到 window.__tour，app.js 在启动后调用 maybeStart()。
const KEY = 'sos_tour_done';
const STEPS = [
  {
    sel: '#tabbar',
    title: '下面这一排是「去哪儿」',
    body: '首页、录入、错题库、考试、复习单、报表、设置——想干什么就点哪个。记不住没关系，先跟着走一遍。',
  },
  {
    sel: '#main .card',
    title: '首页告诉你今天该做什么',
    body: '打开就看到「今天」：该复习哪几道错题、这周还剩多少没做。照着做就行，不用自己想该干什么。',
  },
  {
    sel: '#tabbar [data-tab="capture"]',
    title: '录入：把错题拍下来',
    body: '点「录入」→ 拍一张照片 → 等它自己识别。字、公式、图都会变成能搜索的文字。',
    next: 'capture',
  },
  {
    sel: '#tabbar [data-tab="bank"]',
    title: '错题库：所有错题都在这',
    body: '这里能看到每道题错在哪、错了几次。想找某道题，用上面的搜索框，或者按科目、考点筛。',
    next: 'bank',
  },
  {
    sel: '#tabbar [data-tab="exams"]',
    title: '考试：考完来记分数',
    body: '建一场考试（比如「2026高一上期中」），把六科分数和排名填进去，它会算总分率、找薄弱科目。',
    next: 'exams',
  },
  {
    sel: '#tabbar [data-tab="report"]',
    title: '报表：每周看一眼',
    body: '周报告诉你这一周做了什么；月报告诉你结构性问题在哪。看不懂的词点一下都有解释。',
    next: 'report',
  },
  {
    sel: '#tabbar [data-tab="settings"]',
    title: '设置：给家长用的',
    body: '填模型 key、装到手机、备份数据都在这里。小孩平时不用动它。',
    next: 'settings',
  },
];

let el = null;
let idx = 0;
let onResize = null;

const isDone = () => {
  try { return localStorage.getItem(KEY) === '1'; } catch { return true; }
};
const markDone = () => {
  try { localStorage.setItem(KEY, '1'); } catch { /* 隐私模式 */ }
};

function build() {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'tour';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '新手指引');
  el.innerHTML =
    '<div class="tour-hole"></div>'
    + '<div class="tour-card">'
    + '  <div class="tour-step"></div>'
    + '  <h3 class="tour-title"></h3>'
    + '  <p class="tour-body"></p>'
    + '  <div class="tour-actions">'
    + '    <button class="btn sm ghost" data-t="skip">跳过</button>'
    + '    <span class="spacer" style="flex:1"></span>'
    + '    <button class="btn sm" data-t="prev">上一步</button>'
    + '    <button class="btn sm primary" data-t="next">下一步</button>'
    + '  </div>'
    + '</div>';
  document.body.appendChild(el);

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]')?.dataset.t;
    if (t === 'skip') return finish();
    if (t === 'prev') return go(idx - 1);
    if (t === 'next') return idx >= STEPS.length - 1 ? finish() : go(idx + 1);
  });
  return el;
}

function place() {
  const step = STEPS[idx];
  const card = el.querySelector('.tour-card');
  const hole = el.querySelector('.tour-hole');
  const target = step.sel ? document.querySelector(step.sel) : null;

  el.querySelector('.tour-step').textContent = '第 ' + (idx + 1) + ' / ' + STEPS.length + ' 步';
  el.querySelector('.tour-title').textContent = step.title;
  el.querySelector('.tour-body').textContent = step.body;
  el.querySelector('[data-t="prev"]').style.display = idx === 0 ? 'none' : '';
  el.querySelector('[data-t="next"]').textContent = idx === STEPS.length - 1 ? '开始用吧' : '下一步';

  const vw = innerWidth;
  const vh = innerHeight;
  if (target) {
    const r = target.getBoundingClientRect();
    const pad = 6;
    hole.style.cssText = 'left:' + (r.left - pad) + 'px;top:' + (r.top - pad) + 'px;width:' + (r.width + pad * 2) + 'px;height:' + (r.height + pad * 2) + 'px;';
    hole.style.display = 'block';
    // 卡片放不下的方向就翻到另一边
    const below = r.bottom + 12;
    const above = r.top - 12;
    const need = 190;
    if (below + need < vh) {
      card.style.top = below + 'px';
      card.style.bottom = 'auto';
    } else {
      card.style.top = Math.max(8, above - need) + 'px';
      card.style.bottom = 'auto';
    }
    const left = Math.min(Math.max(10, r.left + r.width / 2 - 150), vw - 310);
    card.style.left = left + 'px';
    card.style.width = Math.min(300, vw - 20) + 'px';
  } else {
    hole.style.display = 'none';
    card.style.top = '30%';
    card.style.left = '50%';
    card.style.transform = 'translateX(-50%)';
    card.style.width = Math.min(300, vw - 20) + 'px';
  }
}

function go(n) {
  idx = Math.max(0, Math.min(STEPS.length - 1, n));
  // 有的步骤需要先把页面切过去，才找得到目标元素
  const step = STEPS[idx];
  if (step.next && window.__app?.go) {
    const cur = (location.hash || '#/').replace(/^#\/?/, '').split('/')[0];
    if (cur !== step.next) {
      window.__app.go(step.next);
      setTimeout(place, 260);
      return;
    }
  }
  place();
}

function finish() {
  markDone();
  stop();
  if (idx === STEPS.length - 1) {
    try { window.__app?.toast?.('以后想再看，去「设置 → 再看一遍新手指引」', 'ok'); } catch { /* 忽略 */ }
  }
}

export function start() {
  build();
  el.style.display = 'block';
  idx = 0;
  document.body.classList.add('tour-open');
  onResize = () => requestAnimationFrame(place);
  addEventListener('resize', onResize);
  addEventListener('scroll', onResize, true);
  const esc = (e) => { if (e.key === 'Escape') finish(); };
  addEventListener('keydown', esc);
  el._esc = esc;
  go(0);
}

export function stop() {
  if (!el) return;
  el.style.display = 'none';
  document.body.classList.remove('tour-open');
  if (onResize) {
    removeEventListener('resize', onResize);
    removeEventListener('scroll', onResize, true);
    onResize = null;
  }
  if (el._esc) removeEventListener('keydown', el._esc);
}

export function maybeStart() {
  if (isDone()) return false;
  setTimeout(() => { start(); }, 700);
  return true;
}

export function reset() {
  try { localStorage.removeItem(KEY); } catch { /* 忽略 */ }
  start();
}

window.__tour = { start, stop, maybeStart, reset, isDone };