// 错题中枢 · 前端（零构建，原生 ESM）

// ---------------------------------------------------------------- 基础工具
const $ = (s, el = document) => el.querySelector(s);

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 按科目分组的考点下拉选项。subjectId 为空时列全部。 */
function kpOptions(subjectId, selected = '') {
  const list = (S.meta?.kps || []).filter((k) => !subjectId || k.subject_id === subjectId);
  const byChapter = new Map();
  for (const k of list) {
    if (!byChapter.has(k.chapter)) byChapter.set(k.chapter, []);
    byChapter.get(k.chapter).push(k);
  }
  const out = [];
  if (selected && !list.some((k) => k.name === selected)) {
    out.push(`<option value="${esc(selected)}" selected>${esc(selected)}（不在列表，保留）</option>`);
  }
  for (const [chapter, items] of byChapter) {
    out.push(`<optgroup label="${esc(chapter)}">`);
    for (const k of items) {
      out.push(
        `<option value="${esc(k.name)}" ${k.name === selected ? 'selected' : ''}>${esc(k.name)}</option>`
      );
    }
    out.push('</optgroup>');
  }
  return out.join('');
}

/** 保留 $...$ / $$...$$ 数学片段，其余做 HTML 转义。
 *  这样 LaTeX 里的 < > 不会被吃掉，又不会引入标签注入。 */
/** 模型有时会输出 MathJax 的 \( ... \) / \[ ... \]，统一成 $ ... $ 再交给 KaTeX */
function normMath(s) {
  return String(s ?? '')
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, x) => '$$' + x + '$$')
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, x) => '$' + x + '$');
}

function mEsc(s) {
  const parts = normMath(s).split(/(\$\$[\s\S]*?\$\$|\$[^$\n]*?\$)/g);
  return parts
    .map((p) => {
      if (/^\$\$[\s\S]*\$\$$/.test(p) || /^\$[^$\n]*\$$/.test(p)) return p;
      return esc(p);
    })
    .join('');
}

/** 行内富文本：转义 + 轻量 Markdown（粗体、行内代码）+ 换行，公式原样留给 KaTeX */
function richInline(s) {
  return mEsc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

/** 块级富文本：完整 Markdown（标题/列表/引用/分隔线），公式原样留给 KaTeX */
const richBlock = (s) => mdToHtml(s);

function mdToHtml(src) {
  const lines = String(src || '').split(/\r?\n/);
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const inline = (s) =>
    mEsc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      closeList();
      const lv = Math.min(3, m[1].length + 1);
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

let mathWarned = false;
const mathReady = () => typeof window.renderMathInElement === 'function';

/** 把元素里的 $...$ / $$...$$ 渲染成公式。返回渲染出的公式个数。 */
function typeset(el) {
  if (!el) return 0;
  if (!mathReady()) {
    // 脚本可能还没执行完：稍后补一次；真的加载失败才提示，不静默显示源码
    setTimeout(() => {
      if (mathReady()) typeset(el);
      else if (!mathWarned) {
        mathWarned = true;
        toast('公式组件没加载，公式会显示成 $...$ 源码', 'err');
      }
    }, 400);
    return 0;
  }
  try {
    window.renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
      errorColor: '#a5331f',
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
    });
  } catch { /* 单条公式失败不影响正文 */ }
  return el.querySelectorAll('.katex').length;
}

const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString('zh-CN', {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

const fmtDay = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
};

async function api(path, { method = 'GET', body, form } = {}) {
  const opt = { method, headers: {} };
  if (form) opt.body = form;
  else if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 ${res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(msg, kind = 'info') {
  const map = { info: 'info', ok: 'ok', err: 'err', warn: 'warn' };
  const box = $('#toast');
  box.innerHTML = `<div class="hint ${map[kind] || 'info'}" style="box-shadow:var(--shadow);margin:0">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.innerHTML = ''; }, 4200);
}

// ---------------------------------------------------------------- 状态
const S = {
  meta: null,
  cap: { subject: 'math', busy: null, drafts: [], page: null, error: null, note: '' },
  bank: { status: 'all', q: '' },
  sheet: { results: {}, busy: false },
  report: { mode: 'week', busy: false },
  settings: {
    loaded: false,
    presets: [],
    presetOf: {},
    form: {
      vision: { baseUrl: '', apiKey: '', model: '' },
      text: { baseUrl: '', apiKey: '', model: '' },
    },
    models: { vision: [], text: [] },
    busy: null,
    note: null,
  },
};

// ---------------------------------------------------------------- 导航
const TABS = [
  ['home', '首页'],
  ['capture', '录入'],
  ['bank', '错题库'],
  ['sheet', '复习单'],
  ['report', '周报'],
  ['settings', '设置'],
];

function renderTabbar(active) {
  $('#tabbar').innerHTML = TABS.map(
    ([k, label]) =>
      `<button data-act="nav" data-to="${k}" class="${k === active ? 'on' : ''}">${label}</button>`
  ).join('');
}

function go(name) { location.hash = `#/${name}`; }

// ---------------------------------------------------------------- 视图：首页
async function viewHome() {
  const m = S.meta;
  const c = m.counts;
  const cfgOk = m.config.vision.ready;
  const html = [];

  if (!cfgOk) {
    html.push(`<div class="hint err">
      <strong>还没配置模型 key</strong><br>
      把 <code>study-os/.env.example</code> 复制成 <code>.env</code>，填上 <code>VISION_API_KEY</code>，
      然后重启服务。识题必须用支持视觉的模型（DeepSeek 的 <code>deepseek-flash</code>）。
    </div>`);
  }

  html.push(`
    <div class="card">
      <h2><span class="dot"></span>总览</h2>
      <div class="stats">
        <div class="s"><div class="n">${c.first}</div><div class="l">头次错</div></div>
        <div class="s key"><div class="n">${c.key}</div><div class="l">重点错题</div></div>
        <div class="s due"><div class="n">${m.dueNow}</div><div class="l">已到期</div></div>
        <div class="s done"><div class="n">${c.archived}</div><div class="l">已掌握</div></div>
      </div>
      <p class="muted" style="margin:11px 0 0">
        本周 ${m.week}（${m.weekRange.start} ~ ${m.weekRange.end}）·
        ${m.rules.ARCHIVE_AFTER_DAYS} 天没再错自动归档 · 复习单每天 ${m.rules.SHEET_PER_DAY} 题上限
      </p>
    </div>
  `);

  const dow = new Date().getDay();
  const weekend = dow === 0 || dow === 6;
  html.push(`
    <div class="card">
      <h2><span class="dot"></span>${weekend ? '周末该干的活' : '本周该干的活'}</h2>
      <ol class="small" style="padding-left:20px;margin:0 0 12px;line-height:2">
        <li>把错题本整页<b>拍照上传</b>，AI 识题后逐条确认入库</li>
        <li><b>生成复习单</b>并打印，周日带回学校，周一到周五每天做几道</li>
        <li>周六回来<b>回收复习单</b>（勾 √ / ×），系统自动排下一轮</li>
        <li>生成<b>周报</b>，把方法论更新抄进本子</li>
      </ol>
      <div class="row">
        <button class="btn primary" data-act="nav" data-to="capture">拍照录入</button>
        <button class="btn" data-act="nav" data-to="sheet">复习单</button>
        <button class="btn" data-act="nav" data-to="report">周报</button>
      </div>
    </div>
  `);

  if (m.dueNow > 0) {
    html.push(`<div class="hint warn">
      有 <strong>${m.dueNow}</strong> 道题已经到期该复习了。周末一次性处理掉，别让它们堆到下周。
    </div>`);
  }

  // 手机上打开：二维码 + 局域网地址（拉不到就整块不显示，不影响首页其它内容）
  let lan = null;
  try { lan = await api('/api/lan'); } catch { lan = null; }
  if (lan?.qr) {
    html.push(`
      <div class="card" style="margin-top:12px">
        <h2><span class="dot"></span>手机上打开</h2>
        <p class="small" style="margin:0 0 10px">
          手机和电脑连同一个 WiFi，用手机相机扫一下这个码，直接进这个页面。
        </p>
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
          <img src="${lan.qr}" alt="局域网访问二维码" width="148" height="148"
               style="border-radius:10px;border:1px solid var(--line);background:#fff;flex:none">
          <div style="min-width:0">
            <div class="small muted">地址</div>
            <div style="font-size:15px;font-weight:600;word-break:break-all">${esc(lan.primary)}</div>
            <div class="small muted" style="margin-top:8px;line-height:1.6">
              扫不开通常是两种情况：电脑防火墙挡了入站，或者两边不在同一个 WiFi。
            </div>
          </div>
        </div>
      </div>`);
  }

  return html.join('');
}

// ---------------------------------------------------------------- 视图：录入
async function viewCapture() {
  const cap = S.cap;
  const h = [];

  h.push(`
    <div class="card">
      <h2><span class="dot"></span>拍一页错题本</h2>
      <div class="row" style="margin-bottom:12px">
        <select id="capSubject" style="width:auto;flex:1">
          ${(S.meta?.subjects || []).map(
            (s) => `<option value="${s.id}" ${s.id === cap.subject ? 'selected' : ''}>${esc(s.name)}</option>`
          ).join('')}
        </select>
      </div>
      ${cap.busy ? `
        <button class="btn primary block" disabled>
          <span class="spin"></span> ${cap.busy === 'compress' ? '压缩中' : cap.busy === 'upload' ? '上传中' : 'AI 识题中（约 20 秒）'}
        </button>
      ` : `
        <div class="row" style="gap:8px">
          <label class="btn primary" style="flex:1;margin:0">
            拍照
            <input type="file" id="capCam" accept="image/*" capture="environment" hidden>
          </label>
          <label class="btn" style="flex:1;margin:0">
            从相册选
            <input type="file" id="capFile" accept="image/*" hidden>
          </label>
          <button class="btn" style="flex:1;margin:0" data-act="cap-manual">手动录入</button>
        </div>
      `}
      <p class="muted" style="margin:9px 0 0">
        拍完或选完会先在手机里压到 1400px 再上传，省流量也省钱。一页尽量拍清楚、别裁掉边。<br>
        <span style="opacity:.85">「拍照」会直接调相机；个别浏览器（微信内置、部分机型自带浏览器）会忽略这个设置直接弹相册，换 Chrome / Safari 打开就正常。</span>
      </p>
    </div>
  `);

  if (cap.manual) {
    h.push(`
      <div class="card">
        <h2><span class="dot"></span>手动录入一道</h2>
        <p class="muted" style="margin:0 0 10px">不打字也行：题目你已经在纸上做过，这里只记「值得重做」的那部分。</p>
        <label class="field"><span>题干（LaTeX 用 $...$）</span>
          <textarea id="mStem" rows="5" placeholder="已知 $f(x)=x^2-2x+3$，求最值。"></textarea></label>
        <div class="row" style="gap:10px;flex-wrap:wrap">
          <label class="field" style="flex:1;min-width:140px"><span>我的答案</span>
            <textarea id="mMine" rows="2"></textarea></label>
          <label class="field" style="flex:1;min-width:140px"><span>正确答案</span>
            <textarea id="mRight" rows="2"></textarea></label>
        </div>
        <label class="field"><span>错因</span>
          <textarea id="mCause" rows="2" placeholder="例如：配方时漏了常数项"></textarea></label>
        <div class="row" style="gap:10px;flex-wrap:wrap">
          <label class="field" style="flex:1;min-width:160px"><span>考点</span>
            <select id="mKp"><option value="">（未标注）</option>${kpOptions(cap.subject)}</select></label>
          <label class="field" style="flex:0 0 92px"><span>难度</span>
            <select id="mDiff">${[1,2,3,4,5].map((n) => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        </div>
        <div class="row" style="gap:8px;margin-top:10px">
          <button class="btn primary" data-act="cap-save-manual">存入错题库</button>
          <button class="btn ghost" data-act="cap-manual-cancel">取消</button>
        </div>
      </div>
    `);
  }

  if (cap.error) {
    h.push(`<div class="hint err">${esc(cap.error)}</div>`);
  }

  if (cap.drafts.length) {
    h.push(`
      <div class="card">
        <h2><span class="dot"></span>识别结果 · ${cap.drafts.length} 道</h2>
        <p class="muted" style="margin:0 0 10px">
          逐条核对。看不准的字段留空比填错好——错的东西进了库，后面复习全是浪费。
        </p>
        <div id="drafts"></div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" data-act="save-drafts">全部存入错题库</button>
          <button class="btn ghost" data-act="discard-drafts">丢弃</button>
        </div>
      </div>
    `);
  } else if (!cap.busy) {
    h.push(`<div class="empty">还没有待确认的识别结果。<br>拍一页错题本开始。</div>`);
  }

  return h.join('');
}

/** 识别结果里的即时预览：边改边看公式/排版效果。
 *  没内容就整块隐藏，免得一堆空框框。 */
function mountDraftPreview(root) {
  for (const pv of root.querySelectorAll('.pv[data-pv]')) {
    const [i, key] = pv.dataset.pv.split(':');
    const keys = key === 'answer' ? ['my_answer', 'correct_answer'] : [key];
    const val = (k) => root.querySelector(`textarea[data-dk="${k}"][data-i="${i}"]`)?.value ?? '';

    let timer = null;
    const paint = () => {
      const text = key === 'answer'
        ? [
            val('my_answer').trim() ? `我的答案：${val('my_answer').trim()}` : '',
            val('correct_answer').trim() ? `正确答案：${val('correct_answer').trim()}` : '',
          ].filter(Boolean).join('\n\n')
        : val(key).trim();
      pv.innerHTML = text ? richBlock(text) : '';
      pv.classList.toggle('on', Boolean(text));
      if (text) typeset(pv);
    };

    paint();
    for (const k of keys) {
      root.querySelector(`textarea[data-dk="${k}"][data-i="${i}"]`)
        ?.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(paint, 200);   // 打字时不要每个键都重排公式
        });
    }
  }
}

function draftCard(d, i) {
  const conf = typeof d.confidence === 'number' ? Math.round(d.confidence * 100) : null;
  const confColor = conf == null ? 'var(--muted)' : conf >= 80 ? 'var(--ok)' : conf >= 55 ? 'var(--warn)' : 'var(--bad)';
  const chapterOpts = kpOptions(d.subject_id || S.cap.subject, d.kp_name);

  return `
    <div class="q" data-draft="${i}">
      <div class="head">
        <label class="row" style="gap:6px;font-size:13px;cursor:pointer">
          <input type="checkbox" data-dk="keep" data-i="${i}" ${d.keep ? 'checked' : ''} style="width:auto">
          保留
        </label>
        <span class="badge first">#${i + 1}</span>
        ${conf != null ? `<span class="badge" style="color:${confColor}">置信 ${conf}%</span>` : ''}
        ${d.kp_alt?.length ? `<span class="badge">还可能是：${esc(d.kp_alt.slice(0, 2).join(' / '))}</span>` : ''}
      </div>
      <label class="field">
        <span>考点</span>
        <select data-dk="kp_name" data-i="${i}">
          <option value="">（未标注）</option>
          ${chapterOpts}
        </select>
      </label>
      <label class="field">
        <span>题干（LaTeX 用 $...$）</span>
        <textarea data-dk="stem" data-i="${i}" rows="5">${esc(d.stem)}</textarea>
      </label>
      <div class="pv" data-pv="${i}:stem"></div>
      <div class="row" style="gap:10px">
        <label class="field" style="flex:1;min-width:140px">
          <span>我的答案</span>
          <textarea data-dk="my_answer" data-i="${i}" rows="2">${esc(d.my_answer || '')}</textarea>
        </label>
        <label class="field" style="flex:1;min-width:140px">
          <span>正确答案</span>
          <textarea data-dk="correct_answer" data-i="${i}" rows="2">${esc(d.correct_answer || '')}</textarea>
        </label>
      </div>
      <div class="pv" data-pv="${i}:answer"></div>
      <label class="field">
        <span>错因（我写的）</span>
        <textarea data-dk="error_cause" data-i="${i}" rows="2">${esc(d.error_cause || '')}</textarea>
      </label>
      <div class="pv" data-pv="${i}:error_cause"></div>
      <label class="field">
        <span>解析</span>
        <textarea data-dk="solution" data-i="${i}" rows="3">${esc(d.solution || '')}</textarea>
      </label>
      <div class="pv" data-pv="${i}:solution"></div>
      <div class="row" style="gap:10px">
        <label class="field" style="flex:1;min-width:120px">
          <span>错因类型</span>
          <select data-dk="error_type" data-i="${i}">
            ${['', '概念不清', '计算失误', '审题偏差', '方法缺失', '记忆不牢', '表达不规范']
              .map((t) => `<option value="${t}" ${t === (d.error_type || '') ? 'selected' : ''}>${t || '（未分类）'}</option>`)
              .join('')}
          </select>
        </label>
        <label class="field" style="flex:1;min-width:120px">
          <span>难度</span>
          <select data-dk="difficulty" data-i="${i}">
            ${[1, 2, 3, 4, 5]
              .map((n) => `<option value="${n}" ${n === (d.difficulty || 3) ? 'selected' : ''}>${n}</option>`)
              .join('')}
          </select>
        </label>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------- 视图：错题库
async function viewBank() {
  const subj = S.bank.subject || 'all';
  const query = `/api/questions?status=${encodeURIComponent(S.bank.status)}${subj !== 'all' ? `&subject=${encodeURIComponent(subj)}` : ''}`;
  const list = await api(query);
  const filters = [
    ['all', '全部'],
    ['first', '头次错'],
    ['key', '重点错题'],
    ['archived', '已掌握'],
  ];
  const subjects = [{ id: 'all', name: '全部科目' }].concat(S.meta?.subjects || []);
  const h = [`
    <div class="bank-toolbar">
      <div class="seg seg-subject">
        ${subjects
          .map(
            (s) =>
              `<button class="seg-btn ${subj === s.id ? 'on' : ''}" data-act="bank-subject" data-subject="${s.id}">${esc(s.name)}</button>`
          )
          .join('')}
      </div>
      <div class="seg seg-status">
        ${filters
          .map(
            ([k, label]) =>
              `<button class="seg-btn ${S.bank.status === k ? 'on' : ''}" data-act="bank-filter" data-status="${k}">${label}</button>`
          )
          .join('')}
        <span class="spacer" style="flex:1"></span>
        <span class="count">${list.length}</span>
      </div>
    </div>
  `];

  if (!list.length) {
    h.push('<div class="empty">这里还是空的。先拍一页错题本。</div>');
    return h.join('');
  }

  h.push('<div class="bank-scroll">');
  h.push(
    list
      .map((q) => {
        const badge =
          q.status === 'key'
            ? '<span class="badge key">重点</span>'
            : q.status === 'archived'
            ? '<span class="badge archived">已掌握</span>'
            : '<span class="badge first">头次</span>';
        return `
        <div class="q" data-act="q-open" data-id="${q.id}" style="cursor:pointer">
          <div class="head">
            ${badge}
            <span class="badge d">${esc(q.kp_name || '未标注')}</span>
            <span class="badge d">难度 ${q.difficulty || '?'}</span>
            ${q.error_count > 1 ? `<span class="badge" style="color:var(--bad)">错 ${q.error_count} 次</span>` : ''}
            <span class="spacer" style="flex:1"></span>
            <span class="id">#${q.id}</span>
          </div>
          <div class="stem clamp">${richInline(q.stem)}</div>
          ${q.error_cause ? `<div class="cause">${esc(q.error_cause).slice(0, 90)}</div>` : ''}
        </div>`;
      })
      .join('')
  );
  h.push('</div>');

  return h.join('');
}


/** 单题全字段编辑表单（改题干/答案/错因/解析/科目/难度都要能改） */
const ERROR_TYPES = ['概念不清', '计算失误', '审题偏差', '方法缺失', '记忆不牢', '表达不规范'];

function editQuestionForm(q) {
  const sel = (name, opts, cur) =>
    '<select data-qf="' + name + '">' +
    opts.map(([v, label]) => '<option value="' + esc(v) + '"' + (String(v) === String(cur ?? '') ? ' selected' : '') + '>' + esc(label) + '</option>').join('') +
    '</select>';
  return `
    <div class="edit-form">
      <label class="field"><span>题干（LaTeX 用 $...$）</span>
        <textarea data-qf="stem" rows="6">${esc(q.stem || '')}</textarea></label>
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <label class="field" style="flex:1;min-width:140px"><span>我的答案</span>
          <textarea data-qf="my_answer" rows="2">${esc(q.my_answer || '')}</textarea></label>
        <label class="field" style="flex:1;min-width:140px"><span>正确答案</span>
          <textarea data-qf="correct_answer" rows="2">${esc(q.correct_answer || '')}</textarea></label>
      </div>
      <label class="field"><span>错因（我写的）</span>
        <textarea data-qf="error_cause" rows="2">${esc(q.error_cause || '')}</textarea></label>
      <label class="field"><span>解析</span>
        <textarea data-qf="solution" rows="5">${esc(q.solution || '')}</textarea></label>
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <label class="field" style="flex:1;min-width:120px"><span>科目</span>
          ${sel('subject_id', (S.meta?.subjects || []).map((x) => [x.id, x.name]), q.subject_id)}</label>
        <label class="field" style="flex:1;min-width:120px"><span>错因类型</span>
          ${sel('error_type', [['', '（未分类）']].concat(ERROR_TYPES.map((t) => [t, t])), q.error_type)}</label>
        <label class="field" style="flex:1;min-width:100px"><span>难度</span>
          ${sel('difficulty', [1,2,3,4,5].map((n) => [n, String(n)]), q.difficulty)}</label>
      </div>
      <div class="row" style="gap:8px;margin-top:10px">
        <button class="btn primary" data-act="save-q" data-id="${q.id}">保存修改</button>
        <button class="btn ghost" data-act="edit-q" data-id="${q.id}">取消</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 视图：单题
async function viewQuestion(id) {
  const d = await api(`/api/questions/${id}`);
  const q = d.question;
  const badge =
    q.status === 'key'
      ? '<span class="badge key">重点错题</span>'
      : q.status === 'archived'
      ? '<span class="badge archived">已掌握（已归档）</span>'
      : '<span class="badge first">头次错</span>';

  return `
    <div class="row" style="margin-bottom:10px">
      <button class="btn sm ghost" data-act="nav" data-to="bank">← 错题库</button>
      <span class="spacer" style="flex:1"></span>
      <span class="id">#${q.id}</span>
    </div>

    <div class="card">
      <div class="head" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px">
        ${badge}
        <span class="badge d">${esc(q.kp_name || '未标注')}</span>
        <span class="badge d">难度 ${q.difficulty || '?'}</span>
        ${q.error_type ? `<span class="badge d">${esc(q.error_type)}</span>` : ''}
        ${q.error_count > 1 ? `<span class="badge" style="color:var(--bad)">累计错 ${q.error_count} 次</span>` : ''}
      </div>
      <div class="stem" style="margin-bottom:12px">${richInline(q.stem)}</div>
      <label class="field">
        <span>考点（改完立刻生效，趋势分析和薄弱点排行都靠它）</span>
        <select data-act="setKp" data-id="${q.id}">
          <option value="">（未标注）</option>
          ${kpOptions(q.subject_id, q.kp_name)}
        </select>
      </label>
      <div class="row" style="gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <button class="btn ok sm" data-act="mark" data-id="${q.id}" data-r="correct">这次做对了</button>
        <button class="btn bad sm" data-act="mark" data-id="${q.id}" data-r="wrong">又错了</button>
        <button class="btn sm" data-act="diagnose" data-id="${q.id}">AI 深挖错因</button>
        <button class="btn sm" data-act="variants" data-id="${q.id}">出变式题</button>
        <button class="btn sm ghost" data-act="edit-q" data-id="${q.id}">${S.editQ === q.id ? '收起编辑' : '编辑'}</button>
      </div>
      ${S.editQ === q.id ? editQuestionForm(q) : `
      ${panel('我的答案', q.my_answer)}
      ${panel('正确答案', q.correct_answer)}
      ${panel('错因（我写的）', q.error_cause)}
      ${panel('AI 归因', q.error_cause_ai, 'info')}
      <div class="field">
        <span>解析</span>
        ${q.solution
          ? `<div class="pv on">${richBlock(q.solution)}</div>`
          : `<p class="muted" style="margin:0 0 8px">还没有解析。解析不自动生成——题目太难、你也不需要，点按钮才花钱。</p>`}
        <button class="btn sm" data-act="solution" data-id="${q.id}">
          ${q.solution ? '重新生成解析' : '生成解析（花 token）'}
        </button>
      </div>`}
      <p class="muted" style="margin:10px 0 0;font-size:12px">
        首错 ${fmtTime(q.first_error_at)} · 最近错 ${fmtTime(q.last_error_at)} ·
        复习 ${q.review_count || 0} 次 · 连对 ${q.correct_streak || 0} 次<br>
        下次复习 ${fmtDay(q.next_review_at)}
        ${q.archived_at ? ` · 归档于 ${fmtDay(q.archived_at)}` : ''}
      </p>
    </div>

    <div class="card">
      <h2><span class="dot"></span>变式题（${d.variants.length}）</h2>
      ${d.variants.length
        ? d.variants
            .map(
              (v) => `
        <div class="q">
          <div class="head">
            <span class="badge">${kindName(v.kind)}</span>
            ${v.tier ? `<span class="badge d">${esc(v.tier)}</span>` : ''}
            <span class="badge ${v.source === 'textbook' ? 'd' : 'first'}">${v.source === 'textbook' ? '教辅' : 'AI'}</span>
            ${v.ref ? `<span class="badge d">${esc(v.ref).slice(0, 30)}</span>` : ''}
          </div>
          <div class="stem">${richInline(v.stem)}</div>
          <details style="margin-top:7px">
            <summary class="small" style="cursor:pointer;color:var(--accent)">看答案与解析</summary>
            <div class="small" style="margin-top:7px">${richInline(v.answer || '—')}</div>
            <div class="small" style="margin-top:5px;color:var(--ink-2)">${richBlock(v.solution || '')}</div>
          </details>
        </div>`
            )
            .join('')
        : '<div class="empty" style="padding:18px">还没生成。点上面的「出变式题」。</div>'}
      <p class="muted" style="margin:8px 0 0;font-size:12px">
        大模块的题去教辅里找更靠谱，AI 更擅长小考点的换数换情境。
      </p>
    </div>

    <div class="card">
      <h2><span class="dot"></span>重做记录（${d.attempts.length}）</h2>
      ${d.attempts.length
        ? d.attempts
            .map(
              (a) =>
                `<div class="row between" style="padding:5px 0;border-bottom:1px dashed var(--line)">
                  <span class="small">${fmtTime(a.at)}</span>
                  <span class="badge ${a.result === 'correct' ? 'archived' : 'key'}">${a.result === 'correct' ? '做对' : '做错'}</span>
                </div>`
            )
            .join('')
        : '<div class="empty" style="padding:14px">还没有记录</div>'}
    </div>
  `;
}

function panel(label, value, kind = '') {
  if (!value) return '';
  return `<div class="hint ${kind}" style="background:var(--subtle);border-color:var(--line);color:var(--ink-2);margin-bottom:8px">
    <div class="small" style="color:var(--muted);margin-bottom:3px">${label}</div>
    <div style="color:var(--ink)">${richBlock(value)}</div>
  </div>`;
}

const kindName = (k) =>
  ({ same: '同构变式', trap: '陷阱对比', layered: '分层递进', cross: '跨考点' }[k] || k);

// ---------------------------------------------------------------- 视图：复习单
async function viewSheet() {
  const d = await api('/api/sheet');
  const h = [];

  if (!d.sheet) {
    h.push(`
      <div class="card">
        <h2><span class="dot"></span>${esc(d.week)} 还没有复习单</h2>
        <p class="small" style="line-height:1.8">
          复习单是按遗忘曲线排的：把下周到期的题挑出来，平均分到周一到周五，每天 ${S.meta?.rules?.SHEET_PER_DAY || 4} 道。
          打印出来带进学校，做一道勾一道，周六回来点勾回收。
          <br><span class="muted">周末生成的单子自动排到下一周——因为你在校用的是下周一到周五。</span>
        </p>
        <button class="btn primary block" data-act="sheet-build" ${S.sheet.busy ? 'disabled' : ''}>
          ${S.sheet.busy ? '<span class="spin"></span> 生成中' : `生成 ${esc(d.week)} 复习单（${esc(S.meta?.sheetWeekRange?.start || '')} 起）`}
        </button>
      </div>
    `);
    return h.join('');
  }

  const items = d.items || [];
  const byDay = {};
  for (const it of items) (byDay[it.day] ||= []).push(it);
  const dayNames = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五' };
  const marked = Object.keys(S.sheet.results).length;

  h.push(`
    <div class="card">
      <h2><span class="dot"></span>${esc(d.sheet.week)} 复习单</h2>
      <p class="muted" style="margin:0 0 12px">
        共 ${items.length} 题 · 状态：${d.sheet.status === 'returned' ? '已回收' : d.sheet.status === 'printed' ? '已打印' : '草稿'}
      </p>
      <div class="row">
        <button class="btn" data-act="sheet-print" data-id="${d.sheet.id}">打印 / 导出 PDF</button>
        <button class="btn" data-act="sheet-build" data-force="1">重排</button>
      </div>
    </div>
  `);

  h.push(`
    <div class="card">
      <h2><span class="dot"></span>回收：做对打 √，做错打 ×</h2>
      ${Object.keys(byDay).sort()
        .map((day) => `
        <div class="day-group">
          <h3>${dayNames[day] || '第' + day + '天'} <span class="pill">${byDay[day].length} 题</span></h3>
          ${byDay[day]
            .map((it) => {
              const r = S.sheet.results[it.question_id];
              return `
              <div class="slot">
                <div class="idx">${it.position}</div>
                <div class="body">
                  <div class="small" style="font-weight:600">${esc(it.kp_name || '未标注')} · 难度 ${it.difficulty || '?'}</div>
                  <div class="small" style="color:var(--muted);margin-top:2px">#${it.question_id} ${richInline((it.stem || '').replace(/\s+/g, ' ').slice(0, 60))}</div>
                </div>
                <div class="marks">
                  <button class="ok ${r === 'correct' ? 'on ok' : ''}" data-act="sheet-mark" data-q="${it.question_id}" data-r="correct">√</button>
                  <button class="bad ${r === 'wrong' ? 'on bad' : ''}" data-act="sheet-mark" data-q="${it.question_id}" data-r="wrong">×</button>
                </div>
              </div>`;
            })
            .join('')}
        </div>`)
        .join('')}
      <div class="row" style="margin-top:14px">
        <button class="btn primary" data-act="sheet-submit" data-id="${d.sheet.id}" ${marked ? '' : 'disabled'}>
          提交回收结果（已勾 ${marked} 题）
        </button>
      </div>
      <p class="muted" style="margin:9px 0 0;font-size:12px">
        提交后系统会把「做错」的题打回复习曲线重新走一遍，「做对」的往后推，30 天不再错的自动归档。
      </p>
    </div>
  `);

  return h.join('');
}

// ---------------------------------------------------------------- 视图：周报 / 月报
async function viewReport() {
  const monthMode = (S.report.mode || 'week') === 'month';
  const d = monthMode ? await api('/api/report/monthly') : await api('/api/report');
  const st = d.stats;
  const period = monthMode ? d.month : d.week;
  const h = [];

  h.push(`
    <div class="row" style="margin-bottom:12px">
      <button class="btn sm ${monthMode ? '' : 'primary'}" data-act="report-mode" data-mode="week">本周</button>
      <button class="btn sm ${monthMode ? 'primary' : ''}" data-act="report-mode" data-mode="month">本月</button>
      <span class="spacer" style="flex:1"></span>
      <span class="muted">${esc(period)}</span>
    </div>
  `);

  h.push(`
    <div class="card">
      <h2><span class="dot"></span>${esc(period)} 数据</h2>
      <div class="stats">
        <div class="s"><div class="n">${st.new_questions}</div><div class="l">新增错题</div></div>
        <div class="s due"><div class="n">${st.accuracy == null ? '—' : st.accuracy + '%'}</div><div class="l">重做正确率</div></div>
        <div class="s key"><div class="n">${monthMode ? st.promoted : st.attempts}</div><div class="l">${monthMode ? '升级为重点' : '重做次数'}</div></div>
        <div class="s done"><div class="n">${monthMode ? st.archived : st.archived_this_week}</div><div class="l">${monthMode ? '本月归档' : '本周归档'}</div></div>
      </div>
      <p class="muted" style="margin:10px 0 0">
        环比上${monthMode ? '月' : '周'}：新增 ${delta(st.new_questions, st.new_questions_prev)}，
        正确率 ${st.accuracy_prev == null ? '无历史数据' : `${st.accuracy_prev}% → ${st.accuracy == null ? '—' : st.accuracy + '%'}`}
        ${monthMode ? ` · 当前重点错题 ${st.key_total} / 在库 ${st.active_total}` : ''}
      </p>
    </div>
  `);

  if (monthMode && st.by_week?.length) {
    const max = Math.max(1, ...st.by_week.map((w) => w.n));
    h.push(`<div class="card">
      <h2><span class="dot"></span>每周新增走势</h2>
      ${st.by_week
        .map(
          (w) => `
        <div class="row" style="gap:8px;padding:3px 0;align-items:center">
          <span class="small" style="width:76px;color:var(--muted)">${esc(w.week)}</span>
          <div style="flex:1;height:9px;background:#f1f2f5;border-radius:5px;overflow:hidden">
            <div style="height:100%;width:${Math.round((w.n / max) * 100)}%;background:var(--accent);border-radius:5px"></div>
          </div>
          <span class="badge">${w.n}</span>
        </div>`
        )
        .join('')}
    </div>`);
  }

  if (st.by_kp?.length) {
    h.push(`<div class="card">
      <h2><span class="dot"></span>${monthMode ? '本月' : '本周'}错得最多的考点</h2>
      ${st.by_kp
        .map(
          (k) =>
            `<div class="row between" style="padding:4px 0"><span class="small">${esc(k.kp)}</span><span class="badge">${k.n} 道</span></div>`
        )
        .join('')}
    </div>`);
  }

  if (st.by_error_type?.length) {
    h.push(`<div class="card">
      <h2><span class="dot"></span>错在哪一类</h2>
      ${st.by_error_type
        .map(
          (k) =>
            `<div class="row between" style="padding:4px 0"><span class="small">${esc(k.type)}</span><span class="badge">${k.n} 道</span></div>`
        )
        .join('')}
    </div>`);
  }

  if (monthMode && st.top_repeat?.length) {
    h.push(`<div class="card">
      <h2><span class="dot"></span>反复错的题（结构性缺口）</h2>
      ${st.top_repeat
        .map(
          (q) => `
        <div class="row between" data-act="q-open" data-id="${q.id}"
             style="padding:7px 0;border-bottom:1px dashed var(--line);cursor:pointer;gap:8px">
          <span class="small" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            #${q.id} ${esc(q.kp_name || '未标注')} · ${esc((q.stem || '').replace(/\s+/g, ' ').slice(0, 26))}
          </span>
          <span class="badge key">错 ${q.error_count} 次</span>
        </div>`
        )
        .join('')}
    </div>`);
  }

  h.push(`<div class="row" style="margin-bottom:12px">
    <button class="btn primary" data-act="report-gen" ${S.report.busy ? 'disabled' : ''}>
      ${
        S.report.busy
          ? '<span class="spin"></span> 生成中（约 30 秒）'
          : d.report
          ? `重新生成${monthMode ? '月报' : '周报'}`
          : `生成${monthMode ? '本月月报' : '本周周报'}`
      }
    </button>
  </div>`);

  if (d.report) {
    h.push(`<div class="card">
      <h2><span class="dot"></span>${monthMode ? '月度复盘' : '一页纸周报'}</h2>
      <div class="md">${richBlock(d.report.body_md)}</div>
      <p class="muted" style="margin:12px 0 0;font-size:12px">生成于 ${fmtTime(d.report.created_at)}</p>
    </div>`);
  } else {
    h.push(
      `<div class="empty">还没生成。${
        monthMode ? '月底花 5 分钟看完，重点是把方法论抄下来。' : '周日下午花 3 分钟读完就够。'
      }</div>`
    );
  }

  return h.join('');
}

const delta = (a, b) => {
  const d = (a || 0) - (b || 0);
  if (d === 0) return '持平';
  return d > 0 ? `<span style="color:var(--bad)">+${d}</span>` : `<span style="color:var(--ok)">${d}</span>`;
};

// ---------------------------------------------------------------- 视图：设置
const SRC_LABEL = { ui: '界面', env: '环境变量', default: '默认', inherit: '继承识题', none: '未配置' };

async function viewSettings() {
  if (!S.settings.loaded) {
    const d = await api('/api/settings');
    S.settings.presets = d.presets || [];
    for (const kind of ['vision', 'text']) {
      const c = d.config[kind];
      S.settings.form[kind] = { baseUrl: c.baseUrl || '', apiKey: '', model: c.model || '' };
    }
    S.settings.loaded = true;
  }

  const m = S.meta;
  const s = S.settings;

  return `
    <div class="hint info">
      配置存在本机数据库里，<b>填完立刻生效，不用重启</b>。优先级：界面 &gt; .env &gt; 默认。
      不绑定任何一家服务商，任何兼容 OpenAI 接口的服务都能接。
    </div>

    ${s.note ? `<div class="hint ${s.note.kind}">${esc(s.note.text)}</div>` : ''}

    ${settingBlock('vision', '识题模型（必须支持图片）', '把错题本照片变成结构化题目。没有视觉能力的模型接在这里会一直失败。')}
    ${settingBlock('text', '写文模型（纯文本即可）', '出变式题、写周报月报、深挖错因。留空则自动复用识题模型那套配置。')}

    <div class="card">
      <div class="row">
        <button class="btn primary" data-act="save-settings" ${s.busy ? 'disabled' : ''}>
          ${s.busy === 'save' ? '<span class="spin"></span> 保存中' : '保存配置'}
        </button>
        <button class="btn" data-act="ai-test" data-kind="vision" ${s.busy ? 'disabled' : ''}>测试识题</button>
        <button class="btn" data-act="ai-test" data-kind="text" ${s.busy ? 'disabled' : ''}>测试写文</button>
      </div>
      <p class="muted" style="margin:9px 0 0;font-size:12px">
        「获取模型列表」会去请求 <code>{Base URL}/models</code>。有的服务商不开放这个接口，那就直接手填模型名。
      </p>
    </div>

    <div class="card">
      <h2><span class="dot"></span>规则</h2>
      <div class="row between" style="padding:4px 0"><span class="small">归档门槛</span><span class="badge">${m.rules.ARCHIVE_AFTER_DAYS} 天没再错</span></div>
      <div class="row between" style="padding:4px 0"><span class="small">复习单每天上限</span><span class="badge">${m.rules.SHEET_PER_DAY} 题</span></div>
      <div class="row between" style="padding:4px 0"><span class="small">错题总数</span><span class="badge">${m.counts.total}</span></div>
      <div class="row" style="margin-top:12px">
        <button class="btn" data-act="maintenance">立即执行归档与重排</button>
      </div>
    </div>

    <div class="card">
      <h2><span class="dot"></span>当前周期</h2>
      <div class="row between" style="padding:4px 0"><span class="small">今天</span><span class="badge">${m.today}</span></div>
      <div class="row between" style="padding:4px 0"><span class="small">本周</span><span class="badge">${m.week}</span></div>
      <div class="row between" style="padding:4px 0"><span class="small">复习单周次</span><span class="badge">${m.sheetWeek}</span></div>
    </div>
  `;
}

function settingBlock(kind, label, hint) {
  const s = S.settings;
  const f = s.form[kind];
  const c = S.meta.config[kind];
  const models = s.models[kind] || [];
  const note = s.presets.find((p) => p.id === s.presetOf[kind])?.note;

  return `
    <div class="card">
      <h2><span class="dot"></span>${label}</h2>
      <p class="muted" style="margin:0 0 12px">${hint}</p>

      <label class="field">
        <span>服务商（只用来快速填表，不是白名单）</span>
        <select data-act="preset" data-kind="${kind}">
          <option value="">— 选一个自动填 Base URL 和模型名 —</option>
          ${s.presets.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
        </select>
      </label>
      ${note ? `<div class="hint info" style="margin-top:-2px">${esc(note)}</div>` : ''}

      <label class="field">
        <span>Base URL</span>
        <input type="text" inputmode="url" autocomplete="off" spellcheck="false"
               data-set="${kind}.baseUrl" value="${esc(f.baseUrl)}"
               placeholder="https://api.deepseek.com">
      </label>

      <label class="field">
        <span>
          API Key
          <span class="badge ${c.ready ? 'archived' : 'key'}">${c.ready ? `已保存 ····${esc(c.keyTail)}` : '未配置'}</span>
        </span>
        <input type="password" autocomplete="new-password" spellcheck="false"
               data-set="${kind}.apiKey" value=""
               placeholder="${c.ready ? '已保存，留空表示不修改' : 'sk-...'}">
      </label>

      <label class="field">
        <span>模型名</span>
        <div class="row" style="gap:8px">
          <input type="text" autocomplete="off" spellcheck="false"
                 data-set="${kind}.model" value="${esc(f.model)}"
                 placeholder="deepseek-flash" style="flex:1;min-width:0">
          <button class="btn sm" data-act="fetch-models" data-kind="${kind}" ${s.busy ? 'disabled' : ''}>
            ${s.busy === `models:${kind}` ? '<span class="spin dark"></span>' : '获取模型列表'}
          </button>
        </div>
      </label>

      ${
        models.length
          ? `<label class="field">
              <span>从列表里选（共 ${models.length} 个）</span>
              <select data-set="${kind}.model">
                <option value="">—</option>
                ${models
                  .map(
                    (mm) =>
                      `<option value="${esc(mm)}" ${mm === f.model ? 'selected' : ''}>${esc(mm)}</option>`
                  )
                  .join('')}
              </select>
            </label>`
          : ''
      }

      <p class="muted" style="margin:8px 0 0;font-size:12px;word-break:break-all">
        当前生效：<b>${esc(c.model)}</b> @ ${esc(c.baseUrl)}<br>
        来源：模型 ${SRC_LABEL[c.source.model] || c.source.model} ·
        地址 ${SRC_LABEL[c.source.baseUrl] || c.source.baseUrl} ·
        Key ${SRC_LABEL[c.source.apiKey] || c.source.apiKey}
        ${c.ready ? '' : ' · <span style="color:var(--bad)">没 key，AI 功能不可用</span>'}
      </p>

      ${
        c.ready
          ? `<button class="btn sm ghost" data-act="clear-key" data-kind="${kind}" style="margin-top:8px">清除这个 key</button>`
          : ''
      }
    </div>
  `;
}

// ---------------------------------------------------------------- 渲染
async function render() {
  const main = $('#main');
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, arg] = raw.split('/');
  renderTabbar(name === 'q' ? 'bank' : name);

  try {
    if (!S.meta) S.meta = await api('/api/meta');
    $('#weekLabel').textContent = `${S.meta.today} · ${S.meta.week}`;
    $('#netState').textContent = S.meta.config.vision.ready ? '' : '未配置模型';

    let html = '';
    if (name === 'capture') html = await viewCapture();
    else if (name === 'bank') html = await viewBank();
    else if (name === 'q') html = await viewQuestion(Number(arg));
    else if (name === 'sheet') html = await viewSheet();
    else if (name === 'report') html = await viewReport();
    else if (name === 'settings') html = await viewSettings();
    else html = await viewHome();

    main.innerHTML = html;
    // 供自动化检查与调试用：当前实际渲染的是哪个视图
    main.dataset.view = name;

    if (name === 'capture' && S.cap.drafts.length) {
      const box = $('#drafts');
      if (box) { box.innerHTML = S.cap.drafts.map(draftCard).join(''); typeset(box); mountDraftPreview(box); }
    }

    typeset(main);
  } catch (e) {
    main.dataset.view = `${name}:error`;
    main.innerHTML = `<div class="hint err">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------- 交互
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  try {
    if (act === 'nav') return go(el.dataset.to);

    // 拍照/相册改用 <label> 直接包住 input，浏览器认这是真实用户手势，
    // 才不会忽略 capture="environment" 直接弹相册。

    if (act === 'discard-drafts') {
      S.cap.drafts = [];
      S.cap.page = null;
      return render();
    }

    if (act === 'save-drafts') {
      const kept = S.cap.drafts.filter((d) => d.keep && d.stem?.trim());
      if (!kept.length) return toast('没有勾选任何题目', 'warn');
      el.disabled = true;
      el.innerHTML = '<span class="spin"></span> 存入中';
      const r = await api('/api/questions/bulk', {
        method: 'POST',
        body: { questions: kept.map(({ keep, confidence, kp_alt, ...rest }) => rest) },
      });
      S.cap.drafts = [];
      S.cap.page = null;
      S.meta = null;
      toast(`已存入 ${r.created} 道错题`, 'ok');
      return go('bank');
    }

    if (act === 'bank-filter') {
      S.bank.status = el.dataset.status;
      return render();
    }

    if (act === 'bank-subject') {
      S.bank.subject = el.dataset.subject;
      return render();
    }

    if (act === 'q-open') return go(`q/${el.dataset.id}`);

    if (act === 'mark') {
      el.disabled = true;
      const r = await api(`/api/questions/${el.dataset.id}/attempt`, {
        method: 'POST',
        body: { result: el.dataset.r },
      });
      S.meta = null;
      const q = r.question;
      toast(
        q.status === 'archived'
          ? '已归档为已掌握'
          : `已记录 · 下次复习 ${fmtDay(q.next_review_at)}`,
        'ok'
      );
      return render();
    }

    if (act === 'cap-manual') {
      S.cap.manual = true;
      return render();
    }

    if (act === 'cap-manual-cancel') {
      S.cap.manual = false;
      return render();
    }

    if (act === 'cap-save-manual') {
      const stem = $('#mStem')?.value.trim();
      if (!stem) return toast('题干不能为空', 'warn');
      el.disabled = true;
      try {
        await api('/api/questions/bulk', {
          method: 'POST',
          body: {
            questions: [{
              subject_id: S.cap.subject,
              stem,
              my_answer: $('#mMine')?.value.trim() || null,
              correct_answer: $('#mRight')?.value.trim() || null,
              error_cause: $('#mCause')?.value.trim() || null,
              kp_name: $('#mKp')?.value || null,
              difficulty: Number($('#mDiff')?.value) || 3,
            }],
          },
        });
        S.cap.manual = false;
        S.meta = null;
        toast('已存入错题库', 'ok');
      } catch (e) {
        toast(e.message, 'err');
        el.disabled = false;
      }
      return render();
    }

    if (act === 'solution') {
      el.disabled = true;
      el.innerHTML = '<span class="spin dark"></span> 生成中（约 20 秒）';
      try {
        await api(`/api/questions/${el.dataset.id}/solution`, { method: 'POST' });
        toast('解析已生成', 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
      return render();
    }

    if (act === 'edit-q') {
      const id = Number(el.dataset.id);
      S.editQ = S.editQ === id ? null : id;
      return render();
    }

    if (act === 'save-q') {
      const id = Number(el.dataset.id);
      const body = {};
      for (const f of document.querySelectorAll('[data-qf]')) {
        const k = f.dataset.qf;
        body[k] = k === 'difficulty' ? Number(f.value) : f.value;
      }
      el.disabled = true;
      try {
        await api(`/api/questions/${id}`, { method: 'PATCH', body });
        S.editQ = null;
        toast('已保存', 'ok');
      } catch (e) {
        toast(e.message, 'err');
        el.disabled = false;
      }
      return render();
    }

    if (act === 'diagnose') {
      el.disabled = true;
      el.innerHTML = '<span class="spin dark"></span> 分析中';
      await api(`/api/questions/${el.dataset.id}/diagnose`, { method: 'POST' });
      toast('归因已补全', 'ok');
      return render();
    }

    if (act === 'variants') {
      el.disabled = true;
      el.innerHTML = '<span class="spin dark"></span> 出题中';
      const r = await api(`/api/questions/${el.dataset.id}/variants`, {
        method: 'POST',
        body: { kinds: ['same', 'trap', 'layered'] },
      });
      toast(`生成了 ${r.created.length} 道变式`, 'ok');
      return render();
    }

    if (act === 'sheet-build') {
      S.sheet.busy = true;
      await render();
      const r = await api('/api/sheet', {
        method: 'POST',
        body: { force: el.dataset.force === '1', perDay: S.meta?.rules?.SHEET_PER_DAY },
      });
      S.sheet.busy = false;
      S.sheet.results = {};
      toast(`复习单已生成，共 ${r.total} 题`, 'ok');
      return render();
    }

    if (act === 'sheet-mark') {
      const qid = el.dataset.q;
      const r = el.dataset.r;
      S.sheet.results[qid] = S.sheet.results[qid] === r ? undefined : r;
      if (!S.sheet.results[qid]) delete S.sheet.results[qid];
      return render();
    }

    if (act === 'sheet-submit') {
      const n = Object.keys(S.sheet.results).length;
      if (!n) return toast('还没勾任何题', 'warn');
      el.disabled = true;
      const r = await api(`/api/sheet/${el.dataset.id}/fill`, {
        method: 'POST',
        body: { results: S.sheet.results },
      });
      S.sheet.results = {};
      S.meta = null;
      toast(`已回收 ${r.updated} 题，复习曲线已重排`, 'ok');
      return go('bank');
    }

    if (act === 'sheet-print') {
      return window.open(`/print.html?id=${el.dataset.id}`, '_blank');
    }

    if (act === 'report-mode') {
      S.report.mode = el.dataset.mode;
      return render();
    }

    if (act === 'report-gen') {
      const monthMode = (S.report.mode || 'week') === 'month';
      S.report.busy = true;
      await render();
      await api(monthMode ? '/api/report/monthly' : '/api/report', { method: 'POST', body: {} });
      S.report.busy = false;
      toast(monthMode ? '月报已生成' : '周报已生成', 'ok');
      return render();
    }

    if (act === 'ai-test') {
      el.disabled = true;
      el.innerHTML = '<span class="spin dark"></span> 测试中';
      try {
        const r = await api('/api/ai/test', { method: 'POST', body: { kind: el.dataset.kind } });
        toast(`连通正常 · ${r.model} · ${r.text}`, 'ok');
      } catch (err) {
        toast(`测试失败：${err.message}`, 'err');
      }
      return render();
    }

    if (act === 'save-settings') {
      const f = S.settings.form;
      const body = {};
      for (const kind of ['vision', 'text']) {
        const blk = { baseUrl: f[kind].baseUrl.trim(), model: f[kind].model.trim() };
        const key = f[kind].apiKey.trim();
        if (key) blk.apiKey = key;   // 留空 = 不改动已保存的 key
        body[kind] = blk;
      }
      S.settings.busy = 'save';
      await render();
      try {
        await api('/api/settings', { method: 'PUT', body });
        S.settings.form.vision.apiKey = '';
        S.settings.form.text.apiKey = '';
        S.settings.note = {
          kind: 'ok',
          text: '配置已保存并立即生效。可以点「测试识题」验证连通性。',
        };
        S.meta = null;
        S.settings.loaded = false;
        toast('配置已保存', 'ok');
      } catch (err) {
        S.settings.note = { kind: 'err', text: `保存失败：${err.message}` };
        toast(err.message, 'err');
      }
      S.settings.busy = null;
      return render();
    }

    if (act === 'fetch-models') {
      const kind = el.dataset.kind;
      S.settings.busy = `models:${kind}`;
      await render();
      try {
        const r = await api('/api/settings/models', {
          method: 'POST',
          body: {
            kind,
            baseUrl: S.settings.form[kind].baseUrl.trim(),
            apiKey: S.settings.form[kind].apiKey.trim(),
          },
        });
        S.settings.models[kind] = r.models || [];
        S.settings.note = {
          kind: 'ok',
          text: `拿到 ${r.models.length} 个模型，从下面的下拉列表里选一个，再点保存。`,
        };
        toast(`拿到 ${r.models.length} 个模型`, 'ok');
      } catch (err) {
        S.settings.models[kind] = [];
        S.settings.note = { kind: 'err', text: `拉取模型列表失败：${err.message}` };
        toast('拉取失败', 'err');
      }
      S.settings.busy = null;
      return render();
    }

    if (act === 'clear-key') {
      const kind = el.dataset.kind;
      el.disabled = true;
      try {
        await api('/api/settings/clear-key', { method: 'POST', body: { kind } });
        S.meta = null;
        S.settings.loaded = false;
        S.settings.note = { kind: 'warn', text: 'key 已清除。AI 功能暂时不可用。' };
        toast('已清除', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
      return render();
    }

    if (act === 'maintenance') {
      const r = await api('/api/maintenance/run', { method: 'POST', body: {} });
      S.meta = null;
      toast(`归档 ${r.archived} 道，重排 ${r.rescheduled} 道`, 'ok');
      return render();
    }
  } catch (err) {
    toast(err.message, 'err');
    el.disabled = false;
    el.textContent = '重试';
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;

  if (t.id === 'capSubject') {
    S.cap.subject = t.value;
    return;
  }

  if (t.id === 'capFile' || t.id === 'capCam') {
    const file = t.files?.[0];
    if (!file) return;
    // 注意：必须等图片读完再清空 input。
    // 有些手机浏览器（iOS Safari 尤其）一旦清空 input，之前拿到的 File 就读不出来了。
    try {
      return await pickPhoto(file);
    } finally {
      t.value = '';
    }
  }

  if (t.dataset?.dk === 'keep') {
    S.cap.drafts[Number(t.dataset.i)].keep = t.checked;
    return;
  }

  if (t.dataset?.dk) {
    const i = Number(t.dataset.i);
    const k = t.dataset.dk;
    const v = k === 'difficulty' ? Number(t.value) : t.value;
    S.cap.drafts[i][k] = v;
    return;
  }

  if (t.dataset?.act === 'setKp') {
    const id = t.dataset.id;
    try {
      await api(`/api/questions/${id}`, { method: 'PATCH', body: { kp_name: t.value } });
      toast(t.value ? `考点已改为「${t.value}」` : '已清空考点', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    return render();
  }

  if (t.dataset?.act === 'preset') {
    const kind = t.dataset.kind;
    const p = S.settings.presets.find((x) => x.id === t.value);
    if (!p) return;
    S.settings.presetOf[kind] = p.id;
    if (p.baseUrl) S.settings.form[kind].baseUrl = p.baseUrl;
    const suggested = kind === 'vision' ? p.vision : p.text;
    if (suggested) S.settings.form[kind].model = suggested;
    return render();
  }

  if (t.dataset?.set && t.tagName === 'SELECT') {
    const [kind, field] = t.dataset.set.split('.');
    S.settings.form[kind][field] = t.value;
    return render();
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset?.dk && t.tagName === 'TEXTAREA') {
    S.cap.drafts[Number(t.dataset.i)][t.dataset.dk] = t.value;
    return;
  }
  // 设置页：边打字边存到草稿，点保存才真正落库，重渲染不会丢
  if (t.dataset?.set && t.tagName !== 'SELECT') {
    const [kind, field] = t.dataset.set.split('.');
    S.settings.form[kind][field] = t.value;
  }
});

// ---------------------------------------------------------------- 拍照流程

/** 旋转后的图片尺寸。90/270 度时宽高互换。 */
function rotatedSize(w, h, rot) {
  const r = ((rot % 360) + 360) % 360;
  return r === 90 || r === 270 ? { w: h, h: w } : { w, h };
}

/** 把裁切框限制在图片内，并保证最小尺寸（拖动越界会裁出空白） */
function clampRect(rect, W, H, min = 24) {
  const w = Math.min(Math.max(rect.w, min), W);
  const h = Math.min(Math.max(rect.h, min), H);
  const x = Math.min(Math.max(rect.x, 0), W - w);
  const y = Math.min(Math.max(rect.y, 0), H - h);
  return { x, y, w, h };
}

/**
 * 裁切 + 旋转编辑器。
 * 返回处理后的 Blob；用户取消返回 null。
 * 用 Promise 包一层，调用方 await 着等结果，不跟 render() 搅在一起。
 */
function openImageEditor(file) {
  return new Promise(async (resolve) => {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return resolve(null);   // 打不开就让调用方用原图
    }

    const wrap = document.createElement('div');
    wrap.className = 'ed';
    wrap.innerHTML = `
      <div class="ed-panel">
        <div class="ed-bar">
          <button class="btn sm" data-ed="rotL" type="button">↺ 左转</button>
          <button class="btn sm" data-ed="rotR" type="button">↻ 右转</button>
          <button class="btn sm" data-ed="reset" type="button">全图</button>
          <span class="spacer"></span>
          <span class="ed-size"></span>
        </div>
        <div class="ed-stage">
          <canvas class="ed-view"></canvas>
          <div class="ed-crop"><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i></div>
        </div>
        <div class="ed-foot">
          <span class="ed-hint">拖框移动，拖四角改大小；空白处拖一下重新框</span>
          <button class="btn" data-ed="cancel" type="button">取消</button>
          <button class="btn primary" data-ed="ok" type="button">确定</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const stage = wrap.querySelector('.ed-stage');
    const view = wrap.querySelector('.ed-view');
    const cropEl = wrap.querySelector('.ed-crop');
    const sizeEl = wrap.querySelector('.ed-size');

    const work = document.createElement('canvas');   // 已旋转的整图
    let rot = 0;
    let crop = { x: 0, y: 0, w: 0, h: 0 };
    let scale = 1;
    let drag = null;
    let done = false;

    const finish = (blob) => {
      if (done) return;
      done = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      bitmap.close?.();
      wrap.remove();
      resolve(blob);
    };

    /** 从原图重新画一张旋转后的整图，并把裁切框重置为全图 */
    function apply() {
      const rs = rotatedSize(bitmap.width, bitmap.height, rot);
      work.width = rs.w;
      work.height = rs.h;
      const c = work.getContext('2d');
      c.fillStyle = '#fff';
      c.fillRect(0, 0, rs.w, rs.h);
      c.save();
      c.translate(rs.w / 2, rs.h / 2);
      c.rotate((rot * Math.PI) / 180);
      c.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      c.restore();
      crop = { x: 0, y: 0, w: rs.w, h: rs.h };
      layout();
    }

    /** 按容器大小算缩放，画到可见 canvas 上 */
    function layout() {
      const maxW = Math.max(160, stage.clientWidth - 40);   // 两侧留 16px 手指空间
      const maxH = Math.max(160, Math.min(window.innerHeight * 0.58, 520));
      scale = Math.min(maxW / work.width, maxH / work.height, 1);
      const dw = Math.max(1, Math.round(work.width * scale));
      const dh = Math.max(1, Math.round(work.height * scale));
      view.width = dw;
      view.height = dh;
      view.style.width = `${dw}px`;
      view.style.height = `${dh}px`;
      const c = view.getContext('2d');
      c.clearRect(0, 0, dw, dh);
      c.drawImage(work, 0, 0, dw, dh);
      drawCrop();
    }

    function drawCrop() {
      // 关键：以图片实际显示的位置为准，而不是按 scale 硬算。
      // 舞台是 flex 居中、还可能被 CSS max-width 缩过，用 scale 算会整体偏移。
      const r = view.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const sx = r.width / work.width;
      const sy = r.height / work.height;
      cropEl.style.left = `${Math.round(r.left - s.left + crop.x * sx)}px`;
      cropEl.style.top = `${Math.round(r.top - s.top + crop.y * sy)}px`;
      cropEl.style.width = `${Math.round(crop.w * sx)}px`;
      cropEl.style.height = `${Math.round(crop.h * sy)}px`;
      sizeEl.textContent = `裁切 ${Math.round(crop.w)}×${Math.round(crop.h)}（原图 ${bitmap.width}×${bitmap.height}）`;
    }

    /** 屏幕坐标 → 原图（已旋转）坐标 */
    const toWork = (ev) => {
      const r = view.getBoundingClientRect();
      return {
        x: ((ev.clientX - r.left) / r.width) * work.width,
        y: ((ev.clientY - r.top) / r.height) * work.height,
      };
    };

    /** 裁切框最小尺寸：按屏幕像素算，保证手指还抓得住 */
    function minWorkSize() {
      const r = view.getBoundingClientRect();
      return Math.max(32, (72 / Math.max(1, r.width)) * work.width);
    }

    function onMove(ev) {
      if (!drag) return;
      ev.preventDefault();
      const p = toWork(ev);
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      const b = drag.base;
      if (drag.mode === 'move') {
        crop = clampRect({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, work.width, work.height);
      } else if (drag.mode === 'new') {
        crop = clampRect({
          x: Math.min(drag.start.x, p.x),
          y: Math.min(drag.start.y, p.y),
          w: Math.abs(dx),
          h: Math.abs(dy),
        }, work.width, work.height);
      } else {
        let x1 = b.x; let y1 = b.y; let x2 = b.x + b.w; let y2 = b.y + b.h;
        if (drag.h.includes('w')) x1 = b.x + dx;
        if (drag.h.includes('e')) x2 = b.x + b.w + dx;
        if (drag.h.includes('n')) y1 = b.y + dy;
        if (drag.h.includes('s')) y2 = b.y + b.h + dy;
        crop = clampRect({
          x: Math.min(x1, x2), y: Math.min(y1, y2),
          w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
        }, work.width, work.height, minWorkSize());
      }
      drawCrop();
    }

    function onUp() {
      if (!drag) return;
      drag = null;
      crop = clampRect(crop, work.width, work.height, minWorkSize());
      drawCrop();
    }

    cropEl.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const h = ev.target?.dataset?.h;
      drag = h
        ? { mode: 'resize', h, start: toWork(ev), base: { ...crop } }
        : { mode: 'move', start: toWork(ev), base: { ...crop } };
      try { cropEl.setPointerCapture?.(ev.pointerId); } catch { /* 合成事件没有真实指针，忽略 */ }
    });

    // 图片四周留出的空白也算数：手指从框外按下去就开始画新框，
    // 不用非得精确戳在图片上（手机屏幕小、手指粗，差几像素很正常）。
    stage.addEventListener('pointerdown', (ev) => {
      if (cropEl.contains(ev.target)) return;   // 点在裁切框上交给上面处理
      ev.preventDefault();
      const p = toWork(ev);
      drag = { mode: 'new', start: p };
      crop = { x: p.x, y: p.y, w: 0, h: 0 };
    });

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);

    wrap.addEventListener('click', (ev) => {
      const act = ev.target?.closest?.('[data-ed]')?.dataset.ed;
      if (!act) return;
      if (act === 'rotL') { rot = (rot + 270) % 360; apply(); }
      else if (act === 'rotR') { rot = (rot + 90) % 360; apply(); }
      else if (act === 'reset') apply();
      else if (act === 'cancel') finish(null);
      else if (act === 'ok') {
        crop = clampRect(crop, work.width, work.height);
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(crop.w));
        out.height = Math.max(1, Math.round(crop.h));
        out.getContext('2d').drawImage(
          work,
          Math.round(crop.x), Math.round(crop.y), Math.round(crop.w), Math.round(crop.h),
          0, 0, out.width, out.height
        );
        out.toBlob((b) => finish(b), 'image/jpeg', 0.92);
      }
    });

    apply();
    // 小屏上第一次布局时 stage 宽度可能还没算出来，下一帧再对一次
    requestAnimationFrame(() => layout());
  });
}

async function compressImage(file, maxSide = 1400, quality = 0.86) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** 选完照片先过一遍裁切/旋转，取消就什么都不做 */
async function pickPhoto(file) {
  let blob = file;
  try {
    const edited = await openImageEditor(file);
    if (edited === null) return;   // 取消了
    if (edited) blob = edited;
  } catch {
    toast('图片编辑器打不开，直接用原图', 'warn');
  }
  return handlePhoto(blob);
}

async function handlePhoto(file) {
  S.cap.error = null;
  S.cap.drafts = [];
  try {
    S.cap.busy = 'compress';
    await render();
    const blob = await compressImage(file);

    S.cap.busy = 'upload';
    await render();
    const fd = new FormData();
    fd.append('photo', blob, 'page.jpg');
    fd.append('subject_id', S.cap.subject);
    const up = await api('/api/pages', { method: 'POST', form: fd });
    S.cap.page = up.page;

    S.cap.busy = 'extract';
    await render();
    const ex = await api(`/api/pages/${up.id}/extract`, { method: 'POST' });
    S.cap.drafts = (ex.drafts || []).map((d) => ({ ...d, keep: true }));
    S.cap.busy = null;
    if (!S.cap.drafts.length) toast('这一页没识别出题目，试试重拍或调亮光线', 'warn');
    else toast(`识别出 ${S.cap.drafts.length} 道题，请逐条核对`, 'ok');
  } catch (e) {
    S.cap.busy = null;
    S.cap.error = e.message;
    toast(e.message, 'err');
  }
  await render();
}

// ---------------------------------------------------------------- 启动
window.addEventListener('hashchange', render);

(async function boot() {
  try {
    S.meta = await api('/api/meta');
  } catch { /* render 里还会再试 */ }
  await render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
