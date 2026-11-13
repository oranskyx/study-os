// 试卷分析前端：考试列表 / 新建 / 详情（上传·识别·人工处理·分析）
// 只暴露 window.__exams；依赖 app.js 通过 window.__app 提供的工具函数。
// 路由：
//   #/exams            列表
//   #/exams/new        新建
//   #/exams/:id        详情（内部用 S2.tab 切 上传/核对/分析）

const ROLE_OPTS = [
  ['paper', '原卷（只有题）'],
  ['answer_sheet', '答题卡'],
  ['answer_key', '答案 / 评分标准'],
  ['graded', '批改过的整卷'],
  ['mixed', '题目 + 作答混合'],
  ['unknown', '不确定'],
];

const ROLE_LABEL = Object.fromEntries(ROLE_OPTS.map(([k, v]) => [k, v]));

const TYPES = [
  ['midterm', '期中'],
  ['final', '期末'],
  ['monthly', '月考'],
  ['custom', '自定义'],
];

const QTYPES = [
  ['choice', '选择'],
  ['fill', '填空'],
  ['short', '简答'],
  ['essay', '作文'],
  ['calc', '计算/证明'],
];

const VERDICTS = [
  ['right', '做对'],
  ['wrong', '做错'],
  ['partial', '部分对'],
  ['unknown', '未判'],
];

const A = () => window.__app;

const S2 = {
  tab: 'stage',
  list: null,
  detail: null,
  analysis: null,
  busy: null,
  msg: null,
};

const fmtScore = (v) => (v == null || v === '' ? '—' : String(Math.round(Number(v) * 10) / 10));

export function resetState() {
  S2.detail = null;
  S2.analysis = null;
  S2.tab = 'stage';
}

// ---------------------------------------------------------------- 列表
export async function viewList() {
  const { api, esc } = A();
  const rows = await api('/api/exams');
  S2.list = rows;
  const h = [];

  h.push(`
    <div class="row between" style="margin-bottom:12px">
      <div>
        <h2 style="margin:0;font-size:16px">考试与试卷分析</h2>
        <p class="muted" style="margin:4px 0 0">传原卷 / 答题卡 / 答案，识别后先暂存，你核对完再决定哪些进错题库。</p>
      </div>
      <button class="btn primary" data-act="exam-new">+ 新建考试</button>
    </div>
  `);

  if (!rows.length) {
    h.push(`<div class="card"><div class="empty">
      还没有考试记录。<br>建一场，把这次期中的卷子传上来——原卷、答题卡、答案，有几张传几张。
    </div></div>`);
    return h.join('');
  }

  h.push('<div class="exam-list">');
  for (const x of rows) {
    const rate = x.sum_full > 0 ? Math.round((x.sum_got / x.sum_full) * 100) : null;
    const scoreLine = x.my_score != null && x.full_score != null
      ? fmtScore(x.my_score) + ' / ' + fmtScore(x.full_score)
      : (x.sum_full > 0 ? fmtScore(x.sum_got) + ' / ' + fmtScore(x.sum_full) : '未录入分数');
    h.push(`
      <div class="exam-card" data-act="exam-open" data-id="${x.id}">
        <div class="ec-head">
          <span class="badge d">${esc(x.type_label || x.type)}</span>
          <strong>${esc(x.name)}</strong>
          <span class="spacer" style="flex:1"></span>
          <span class="muted">${esc(x.exam_date)}</span>
        </div>
        <div class="ec-score">
          <b>${scoreLine}</b>
          ${rate != null ? '<span class="ec-rate">得分率 ' + rate + '%</span>' : ''}
        </div>
        <div class="ec-meta">
          <span>${x.page_count} 张图</span>
          <span>${x.item_count} 道题</span>
          <span class="${x.wrong_count ? 'warn' : ''}">${x.wrong_count} 道要收</span>
          <span class="spacer" style="flex:1"></span>
          <button class="btn sm ghost" data-act="exam-del" data-id="${x.id}">删除</button>
        </div>
      </div>`);
  }
  h.push('</div>');
  return h.join('');
}

// ---------------------------------------------------------------- 新建
export async function viewNew() {
  const { api, esc, kpOptions } = A();
  const meta = await api('/api/meta');
  const exams = await api('/api/exams');
  const subjects = meta.subjects || [];
  const today = meta.today;

  return `
    <div class="row" style="margin-bottom:12px">
      <button class="btn sm ghost" data-act="exam-list">← 考试列表</button>
    </div>

    <div class="card">
      <h2><span class="dot"></span>新建一场考试</h2>
      <div class="field-row">
        <label class="field"><span>科目</span>
          <select id="exSubject">${subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
        </label>
        <label class="field"><span>考试类型</span>
          <select id="exType">${TYPES.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        </label>
      </div>
      <label class="field"><span>名称（例如：高一上期中 · 数学）</span>
        <input id="exName" placeholder="高一上期中 · 数学">
      </label>
      <div class="field-row">
        <label class="field"><span>考试日期</span><input id="exDate" type="date" value="${today}"></label>
        <label class="field"><span>满分</span><input id="exFull" type="number" step="0.5" placeholder="150"></label>
        <label class="field"><span>我的得分</span><input id="exMine" type="number" step="0.5" placeholder="112"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>排名（可选）</span><input id="exRank" type="number" placeholder=""></label>
        <label class="field"><span>参考人数（可选）</span><input id="exTotal" type="number" placeholder=""></label>
      </div>
      <label class="field"><span>备注（可选）</span><input id="exNote" placeholder="例如：这次解析几何没做"></label>
      <button class="btn primary block" data-act="exam-create">创建并去传图</button>
    </div>

    <div class="card">
      <h2><span class="dot"></span>或者：把图传到已有考试</h2>
      <p class="muted" style="margin:0 0 10px">
        一次考试可能分几次拍照（先传原卷，回家再补答案），直接选那场考试继续传就行。
      </p>
      ${exams.length ? `
        <label class="field"><span>选择考试</span>
          <select id="exExisting">${exams.map((x) => `<option value="${x.id}">${esc(x.exam_date)} · ${esc(x.name)}</option>`).join('')}</select>
        </label>
        <button class="btn" data-act="exam-open-selected">进入这场考试</button>
      ` : '<p class="muted">还没有考试记录，先建一场。</p>'}
    </div>

    <div class="card">
      <h2><span class="dot"></span>上传前的情报</h2>
      <ul class="small" style="line-height:1.9;margin:0;padding-left:20px">
        <li>手上有几张传几张：只有原卷也能建，只是没有得分；只有答案也能建，题干要手补。</li>
        <li>系统会自动判断每张是原卷 / 答题卡 / 答案 / 批改卷，判错了你可以改。</li>
        <li>答题卡优先传涂卡和手写都清楚的那张——选项识别不了会让你人工确认。</li>
      </ul>
    </div>
  `;
}

// ---------------------------------------------------------------- 详情
export async function viewDetail(id) {
  const { api, esc } = A();
  const d = await api('/api/exams/' + id);
  S2.detail = d;
  const exam = d.exam;
  const tab = S2.tab;

  const head = `
    <div class="row between" style="margin-bottom:10px">
      <button class="btn sm ghost" data-act="exam-list">← 考试列表</button>
      <span class="muted">${esc(exam.exam_date)}</span>
    </div>
    <div class="card">
      <div class="row between" style="align-items:flex-start;gap:10px">
        <div>
          <h2 style="margin:0 0 4px"><span class="dot"></span>${esc(exam.name)}</h2>
          <p class="muted" style="margin:0">
            ${esc(exam.type_label)} · ${d.pages.length} 张图 · ${d.items.length} 道题
            ${exam.my_score != null ? ' · 得分 ' + fmtScore(exam.my_score) + (exam.full_score != null ? ' / ' + fmtScore(exam.full_score) : '') : ''}
          </p>
        </div>
      </div>
      <div class="exam-tabs">
        <button class="seg-btn ${tab === 'stage' ? 'on' : ''}" data-act="exam-tab" data-tab="stage">① 上传与识别</button>
        <button class="seg-btn ${tab === 'review' ? 'on' : ''}" data-act="exam-tab" data-tab="review">② 人工核对</button>
        <button class="seg-btn ${tab === 'analysis' ? 'on' : ''}" data-act="exam-tab" data-tab="analysis">③ 分析</button>
      </div>
    </div>
  `;

  if (tab === 'stage') return head + stageView(d);
  if (tab === 'review') return head + await reviewView(d);
  return head + await analysisView(id);
}

// ---------------------------------------------------------------- ① 上传与识别
function stageView(d) {
  const { esc } = A();
  const pages = d.pages;
  const done = pages.filter((p) => p.status === 'done').length;
  const h = [];

  h.push(`
    <div class="card">
      <h2><span class="dot"></span>传图</h2>
      <p class="muted" style="margin:0 0 10px">
        可以一次选多张。传完先看系统判的类型对不对，判错直接在下面改，再点识别。
      </p>
      <input type="file" id="exFiles" accept="image/*" multiple style="display:none">
      <div class="row">
        <button class="btn primary" data-act="exam-pick">选择图片</button>
        <button class="btn" data-act="exam-extract-all" ${done === pages.length ? 'disabled' : ''}>
          识别全部未识别（${pages.length - done}）
        </button>
        <button class="btn" data-act="exam-merge" ${done ? '' : 'disabled'}>合并到题目列表</button>
      </div>
      <p class="muted" style="margin:8px 0 0;font-size:12px">识别会自动判断这张是原卷 / 答题卡 / 答案，判断理由写在卡片上。</p>
    </div>
  `);

  if (!pages.length) {
    h.push('<div class="card"><div class="empty">还没有图片。点「选择图片」开始。</div></div>');
    return h.join('');
  }

  h.push('<div class="page-grid">');
  for (const p of pages) {
    const st = p.status === 'done' ? '已识别' : p.status === 'running' ? '识别中' : p.status === 'failed' ? '失败' : '待识别';
    let count = 0;
    if (p.raw_json) { try { count = (JSON.parse(p.raw_json).questions || []).length; } catch { count = 0; } }
    const conf = p.role_conf == null ? null : Math.round(p.role_conf * 100);
    h.push(`
      <div class="page-card">
        <img src="/uploads/${esc(p.image_path)}" alt="第 ${p.sort} 张" loading="lazy" data-act="exam-zoom" data-src="/uploads/${esc(p.image_path)}">
        <div class="pc-body">
          <select data-act="exam-role" data-pid="${p.id}">
            ${ROLE_OPTS.map(([k, v]) => `<option value="${k}" ${p.role === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
          <div class="pc-meta">
            <span class="badge ${p.status === 'done' ? 'archived' : p.status === 'failed' ? 'key' : 'd'}">${st}</span>
            ${count ? `<span class="badge d">${count} 道</span>` : ''}
            ${conf != null ? `<span class="badge d">判定 ${conf}%</span>` : ''}
          </div>
          ${p.role_note ? `<p class="pc-note">${esc(p.role_note)}</p>` : ''}
          ${p.error ? `<p class="pc-note" style="color:var(--bad)">${esc(p.error)}</p>` : ''}
          <div class="row" style="gap:6px;margin-top:8px">
            <button class="btn sm" data-act="exam-extract" data-pid="${p.id}">${p.status === 'done' ? '重新识别' : '识别这张'}</button>
            <button class="btn sm ghost" data-act="exam-page-del" data-pid="${p.id}">删</button>
          </div>
        </div>
      </div>`);
  }
  h.push('</div>');
  return h.join('');
}

// ---------------------------------------------------------------- ② 人工核对
/** 答题卡可视化：每个选项三种状态（未涂/黑笔/红笔）+ 老师批改标记 */
function marksEditor(it) {
  let m = {};
  try { m = it.marks_json ? JSON.parse(it.marks_json) : {}; } catch { m = {}; }
  const has = m.visible || m.filled || m.black || m.red;
  if (!has && it.qtype !== 'choice') return '';

  const stateOf = (L) => {
    if ((m.black || []).includes(L)) return 'black';
    if ((m.red || []).includes(L)) return 'red';
    if ((m.visible || []).includes(L)) return 'clear';
    if ((m.filled || []).includes(L)) return 'filled';
    return 'none';
  };
  const LABEL = { black: '黑涂', red: '红改', clear: '可见', filled: '已涂', none: '未涂' };
  const chips = ['A', 'B', 'C', 'D'].map((L) => {
    const st = stateOf(L);
    return '<button type=\"button\" class=\"opt-chip ' + st + '\" data-act=\"mark-cycle\" data-iid=\"' + it.id + '\" data-l=\"' + L + '\">' +
      '<b>' + L + '</b><span>' + LABEL[st] + '</span></button>';
  }).join('');

  return '<div class=\"marks-box\">' +
    '<div class=\"marks-head\">' +
      '<span class=\"small\">答题卡（点字母切换：未涂 → 黑笔 → 红笔）</span>' +
      '<span class=\"spacer\" style=\"flex:1\"></span>' +
      '<select data-act=\"mark-teacher\" data-iid=\"' + it.id + '\">' +
        '<option value=\"\"' + (!m.teacher ? ' selected' : '') + '>无批改</option>' +
        '<option value=\"tick\"' + (m.teacher === 'tick' ? ' selected' : '') + '>红勾</option>' +
        '<option value=\"cross\"' + (m.teacher === 'cross' ? ' selected' : '') + '>红叉/红框</option>' +
      '</select>' +
    '</div>' +
    '<div class=\"opt-chips\">' + chips + '</div>' +
    '<div class=\"marks-note\">涂了的字母 = 全集减去「可见」；黑笔是你写的，红笔是老师补的。' +
      '保存后按「黑红都有=错、只有红=没写、标准答案优先」判定。</div>' +
  '</div>';
}

async function reviewView(d) {
  const { esc } = A();
  const items = d.items;
  const h = [];

  if (!items.length) {
    return `<div class="card"><div class="empty">
      还没有题目。<br>先回到「① 上传与识别」，识别完成后点「合并到题目列表」。
    </div></div>`;
  }

  const need = items.filter((x) => x.verdict === 'wrong' || x.verdict === 'partial').length;
  h.push(`
    <div class="card">
      <h2><span class="dot"></span>核对与修正</h2>
      <p class="muted" style="margin:0 0 10px">
        识别出来的东西一定有错，改完再收。改完点「保存全部修改」，再决定收哪些进错题库。
      </p>
      <div class="row">
        <button class="btn primary" data-act="exam-save-items">保存全部修改</button>
        <button class="btn" data-act="exam-import" data-only="1" ${need ? '' : 'disabled'}>收错题进错题库（${need}）</button>
        <button class="btn ghost" data-act="exam-import" data-only="0">全部收进去</button>
      </div>
    </div>
  `);

  for (const it of items) {
    const v = it.verdict || 'unknown';
    let opts = null;
    if (it.options_json) { try { opts = JSON.parse(it.options_json); } catch { opts = null; } }
    h.push(`
      <div class="item-card" data-item="${it.id}">
        <div class="row between" style="margin-bottom:8px;gap:8px">
          <div class="row" style="gap:6px">
            <span class="badge d">第 ${esc(it.q_no)} 题</span>
            <span class="badge ${v === 'wrong' ? 'key' : v === 'partial' ? 'd' : v === 'right' ? 'archived' : 'd'}">
              ${(VERDICTS.find(([k]) => k === v) || ['', '未判'])[1]}
            </span>
            ${it.imported_qid ? '<span class="badge archived">已入库</span>' : ''}
            ${it.handwriting === 'handwritten' ? '<span class="badge d">手写</span>' : ''}
          </div>
          <button class="btn sm ghost" data-act="exam-item-del" data-iid="${it.id}">删</button>
        </div>

        <div class="field-row">
          <label class="field" style="max-width:120px"><span>题号</span>
            <input data-f="q_no" data-iid="${it.id}" value="${esc(it.q_no)}"></label>
          <label class="field" style="max-width:140px"><span>题型</span>
            <select data-f="qtype" data-iid="${it.id}">
              <option value="">—</option>
              ${QTYPES.map(([k, n]) => `<option value="${k}" ${it.qtype === k ? 'selected' : ''}>${n}</option>`).join('')}
            </select></label>
          <label class="field" style="max-width:130px"><span>判定</span>
            <select data-f="verdict" data-iid="${it.id}">
              ${VERDICTS.map(([k, n]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${n}</option>`).join('')}
            </select></label>
          <label class="field" style="max-width:110px"><span>满分</span>
            <input data-f="score_full" data-iid="${it.id}" type="number" step="0.5" value="${it.score_full ?? ''}"></label>
          <label class="field" style="max-width:110px"><span>得分</span>
            <input data-f="score_got" data-iid="${it.id}" type="number" step="0.5" value="${it.score_got ?? ''}"></label>
        </div>

        <label class="field"><span>题干</span>
          <textarea data-f="stem" data-iid="${it.id}" rows="3">${esc(it.stem || '')}</textarea></label>

        ${marksEditor(it)}

        ${opts ? `<div class="opts">${Object.entries(opts).map(([k, vv]) =>
          `<div class="opt"><b>${esc(k)}</b> ${esc(vv)}</div>`).join('')}</div>` : ''}

        <div class="field-row">
          <label class="field"><span>我的答案</span>
            <textarea data-f="my_answer" data-iid="${it.id}" rows="2">${esc(it.my_answer || '')}</textarea></label>
          <label class="field"><span>标准答案</span>
            <textarea data-f="correct_answer" data-iid="${it.id}" rows="2">${esc(it.correct_answer || '')}</textarea></label>
        </div>

        <div class="field-row">
          <label class="field"><span>考点</span>
            <input data-f="kp_name" data-iid="${it.id}" value="${esc(it.kp_name || '')}"></label>
          <label class="field" style="max-width:120px"><span>难度</span>
            <input data-f="difficulty" data-iid="${it.id}" type="number" min="1" max="5" value="${it.difficulty ?? ''}"></label>
        </div>

        ${it.grading_note ? `<p class="pc-note">批改痕迹：${esc(it.grading_note)}</p>` : ''}
        ${it.solution ? `<details class="orig"><summary>解析原文</summary><div class="md">${window.__app.richBlock(it.solution)}</div></details>` : ''}
      </div>`);
  }
  return h.join('');
}

// ---------------------------------------------------------------- ③ 分析
async function analysisView(id) {
  const { api, esc } = A();
  const a = await api('/api/exams/' + id + '/analysis');
  S2.analysis = a;
  const t = a.totals;
  const h = [];

  h.push(`
    <div class="card">
      <h2><span class="dot"></span>这场考试的账面</h2>
      <div class="stats">
        <div class="s"><div class="n">${fmtScore(t.my_score != null ? t.my_score : t.got)}</div><div class="l">得分${t.full_score ? ' / ' + fmtScore(t.full_score) : ''}</div></div>
        <div class="s done"><div class="n">${t.rate == null ? '—' : t.rate + '%'}</div><div class="l">得分率（已识别题）</div></div>
        <div class="s key"><div class="n">${t.wrong + t.partial}</div><div class="l">错题 + 部分对</div></div>
        <div class="s due"><div class="n">${t.lost}</div><div class="l">丢了 ${t.lost} 分</div></div>
      </div>
      <p class="muted" style="margin:10px 0 0;font-size:12.5px">
        识别到 ${t.items} 道题：做对 ${t.right}、做错 ${t.wrong}、部分对 ${t.partial}、未判 ${t.unknown}。
        ${t.unknown ? '「未判」是因为页面上没有批改痕迹，你在核对页手动标一下更准。' : ''}
      </p>
    </div>
  `);

  // 失分榜只列真的丢分的项；全对的考点单独说明，不混杂在榜单里
  const bars = (title, listAll, unit) => {
    const list = (listAll || []).filter((x) => x.lost > 0);
    if (!list.length) return '';
    const max = Math.max(1, ...list.map((x) => x.lost || x.n));
    return `<div class="card"><h2><span class="dot"></span>${title}</h2><div class="bars">
      ${list.map((x) => `<div class="bar"><span class="bl">${esc(x.label)}</span>
        <span class="bt"><i style="width:${Math.max(3, Math.round(((x.lost || x.n) / max) * 100))}%"></i></span>
        <span class="bv">-${fmtScore(x.lost)} 分</span></div>`).join('')}
    </div></div>`;
  };

  h.push(bars('失分最多的考点', a.by_kp, '道'));
  h.push(bars('按题型的失分', a.by_type, '道'));
  h.push(bars('按难度的失分', a.by_difficulty, '道'));

  if (a.lost_top.length) {
    h.push(`<div class="card"><h2><span class="dot"></span>丢分最多的题</h2>
      ${a.lost_top.map((x) => `
        <div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line);gap:8px">
          <span class="small" style="flex:1;min-width:0">第 ${esc(x.q_no)} 题 · ${esc(x.kp_name || '未标注')}</span>
          <span class="badge key">-${fmtScore(x.lost)} 分</span>
        </div>`).join('')}
    </div>`);
  }

  if (a.history.length > 1) {
    h.push(`<div class="card"><h2><span class="dot"></span>同科目历次</h2>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>日期</th><th>考试</th><th>得分</th><th>满分</th><th>得分率</th></tr></thead>
        <tbody>${a.history.map((x) => {
          const r = x.full_score ? Math.round((x.my_score / x.full_score) * 100) : null;
          return `<tr><td>${esc(x.exam_date)}</td><td>${esc(x.name)}</td><td>${fmtScore(x.my_score)}</td><td>${fmtScore(x.full_score)}</td><td>${r == null ? '—' : r + '%'}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>`);
  }

  h.push(`<div class="card"><h2><span class="dot"></span>下一步</h2>
    <p class="small" style="margin:0 0 10px;line-height:1.9">
      把「做错 / 部分对」的题收进错题库，它们会按遗忘曲线进复习单。
      收的时候会把这次的分数、批改痕迹一起带过去，复习时能看到当时怎么错的。
    </p>
    <button class="btn primary" data-act="exam-import" data-only="1">收错题进错题库</button>
  </div>`);

  return h.join('');
}

// ---------------------------------------------------------------- 交互
export async function handle(act, el) {
  const { api, toast, render } = A();
  const id = Number((location.hash.split('/')[2] || '').replace(/\D.*$/, ''));

  if (act === 'exam-list') return A().go('exams');
  if (act === 'exam-new') return A().go('exams/new');
  if (act === 'exam-open') return A().go('exams/' + el.dataset.id);
  if (act === 'exam-open-selected') {
    const v = document.getElementById('exExisting')?.value;
    if (v) return A().go('exams/' + v);
    return;
  }

  if (act === 'exam-create') {
    const name = document.getElementById('exName')?.value.trim();
    if (!name) return toast('先填考试名称', 'warn');
    el.disabled = true;
    try {
      const r = await api('/api/exams', {
        method: 'POST',
        body: {
          subject_id: document.getElementById('exSubject')?.value,
          type: document.getElementById('exType')?.value,
          name,
          exam_date: document.getElementById('exDate')?.value,
          full_score: document.getElementById('exFull')?.value || null,
          my_score: document.getElementById('exMine')?.value || null,
          rank: document.getElementById('exRank')?.value || null,
          total_students: document.getElementById('exTotal')?.value || null,
          note: document.getElementById('exNote')?.value || null,
        },
      });
      toast('已创建，去传图', 'ok');
      A().go('exams/' + r.id);
    } finally { el.disabled = false; }
    return true;
  }

  if (act === 'exam-del') {
    if (!confirm('删除这场考试？图片和暂存题目都会删掉，已收进错题库的题不受影响。')) return true;
    await api('/api/exams/' + el.dataset.id, { method: 'DELETE' });
    toast('已删除', 'ok');
    S2.detail = null;
    return render();
  }

  if (act === 'exam-tab') {
    S2.tab = el.dataset.tab;
    return render();
  }

  if (act === 'exam-pick') {
    const input = document.getElementById('exFiles');
    input.onchange = async () => {
      if (!input.files || !input.files.length) return;
      const fd = new FormData();
      for (const f of input.files) fd.append('photos', f);
      toast('上传中…', 'ok');
      await fetch('/api/exams/' + id + '/pages', { method: 'POST', body: fd });
      input.value = '';
      toast('上传完成', 'ok');
      render();
    };
    input.click();
    return true;
  }

  if (act === 'exam-role') {
    // select 的 change 事件走 input 委托，这里只兜底
    return true;
  }

  if (act === 'exam-extract') {
    el.disabled = true;
    el.textContent = '识别中…';
    try {
      const r = await api('/api/exams/pages/' + el.dataset.pid + '/extract', { method: 'POST', body: {} });
      toast('识别到 ' + r.staged + ' 道题', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    return render();
  }

  if (act === 'exam-extract-all') {
    el.disabled = true;
    const d = S2.detail;
    const todo = (d?.pages || []).filter((p) => p.status !== 'done');
    for (let i = 0; i < todo.length; i++) {
      el.textContent = '识别中 ' + (i + 1) + '/' + todo.length;
      try { await api('/api/exams/pages/' + todo[i].id + '/extract', { method: 'POST', body: {} }); }
      catch (e) { toast('第 ' + (i + 1) + ' 张失败：' + e.message, 'err'); }
    }
    toast('识别完成，点「合并到题目列表」', 'ok');
    return render();
  }

  if (act === 'exam-merge') {
    el.disabled = true;
    try {
      const r = await api('/api/exams/' + id + '/merge', { method: 'POST', body: {} });
      toast('合并完成：新增 ' + r.added + ' 道，补充 ' + r.filled + ' 道', 'ok');
      S2.tab = 'review';
    } catch (e) { toast(e.message, 'err'); }
    return render();
  }

  if (act === 'exam-page-del') {
    if (!confirm('删掉这张图？')) return true;
    await api('/api/exams/pages/' + el.dataset.pid, { method: 'DELETE' });
    return render();
  }

  if (act === 'exam-item-del') {
    await api('/api/exams/items/' + el.dataset.iid, { method: 'DELETE' });
    return render();
  }

  if (act === 'mark-teacher') return true;
  if (act === 'mark-cycle') {
    const iid = String(el.dataset.iid);
    const L = el.dataset.l;
    const item = (S2.detail?.items || []).find((x) => String(x.id) === iid);
    let m = {};
    try { m = item?.marks_json ? JSON.parse(item.marks_json) : {}; } catch { m = {}; }
    const black = new Set(m.black || []);
    const red = new Set(m.red || []);
    const visible = new Set(m.visible || []);
    const cur = black.has(L) ? 'black' : red.has(L) ? 'red' : 'none';
    // 循环：未涂 → 黑笔 → 红笔 → 未涂
    black.delete(L); red.delete(L); visible.delete(L);
    if (cur === 'none') black.add(L);
    else if (cur === 'black') red.add(L);
    m.black = [...black]; m.red = [...red]; m.visible = [...visible];
    if (item) item.marks_json = JSON.stringify(m);
    return render();
  }
  if (act === 'exam-save-items') {
    el.disabled = true;
    const cards = [...document.querySelectorAll('[data-iid]')];
    const byId = new Map();
    for (const inp of cards) {
      const iid = inp.dataset.iid;
      if (!iid) continue;
      const f = inp.dataset.f;
      if (!f) continue;
      if (!byId.has(iid)) byId.set(iid, {});
      byId.get(iid)[f] = inp.value;
    }
    let n = 0;
    // 答题卡：把 marks 一起提交，服务端按「可见/黑/红/批改/标准答案」重算对错
    for (const it of S2.detail?.items || []) {
      if (!it.marks_json) continue;
      const cab = byId.get(String(it.id)) || {};
      byId.set(String(it.id), { ...cab, marks: JSON.parse(it.marks_json) });
    }
    for (const [iid, patch] of byId) {
      await api('/api/exams/items/' + iid, { method: 'PATCH', body: patch });
      n++;
    }
    toast('已保存 ' + n + ' 道', 'ok');
    return render();
  }

  if (act === 'exam-import') {
    const onlyWrong = el.dataset.only === '1';
    el.disabled = true;
    try {
      const r = await api('/api/exams/' + id + '/import', { method: 'POST', body: { onlyWrong } });
      toast(r.imported ? '已收 ' + r.imported + ' 道进错题库' : '没有需要收的题', r.imported ? 'ok' : 'warn');
    } catch (e) { toast(e.message, 'err'); }
    return render();
  }

  if (act === 'exam-zoom') {
    const url = el.dataset.src;
    const w = window.open('', '_blank');
    if (w) w.document.write('<img src="' + url + '" style="max-width:100%">');
    return true;
  }

  return false;
}

export function bindEvents() {
  // select 的 change 用事件委托，避免每次渲染重建监听
  document.addEventListener('change', async (e) => {
    const t = e.target.closest('[data-act="mark-teacher"]');
    if (t) {
      const iid = String(t.dataset.iid);
      const item = (S2.detail?.items || []).find((x) => String(x.id) === iid);
      if (item) {
        let m = {};
        try { m = item.marks_json ? JSON.parse(item.marks_json) : {}; } catch { m = {}; }
        m.teacher = t.value || null;
        item.marks_json = JSON.stringify(m);
      }
      return;
    }

    const sel = e.target.closest('[data-act="exam-role"]');
    if (!sel) return;
    await window.__app.api('/api/exams/pages/' + sel.dataset.pid, {
      method: 'PATCH',
      body: { role: sel.value },
    });
    window.__app.toast('类型已更新', 'ok');
  });
}

window.__exams = { viewList, viewNew, viewDetail, handle, bindEvents, resetState };