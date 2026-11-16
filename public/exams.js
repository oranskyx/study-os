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

/** 读一个数字输入框，空字符串当 null（选填字段） */
function numOrNull(id) {
  const el = document.getElementById(id);
  if (!el || el.value === '') return null;
  const n = Number(el.value);
  return Number.isNaN(n) ? null : n;
}

// 模块级快捷方式：uploadExamPages / refreshPages 这类辅助函数在 view/handle 之外，
// 没有局部解构可用。之前它们直接调 api()/toast()/render()，运行时报
// ReferenceError 被 async 监听器吞掉，表现就是「点拍照毫无反应」。
const api = (...a) => window.__app.api(...a);
const toast = (...a) => window.__app.toast(...a);
const render = (...a) => window.__app.render(...a);

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

// ---------------------------------------------------------------- 共用常量
const GRADES = [['1', '高一'], ['2', '高二'], ['3', '高三']];
const TERMS = [['up', '上学期'], ['down', '下学期']];
const SUBJECTS = [
  ['chinese', '语文'], ['math', '数学'], ['english', '英语'],
  ['physics', '物理'], ['chemistry', '化学'], ['biology', '生物'],
];
const FULL_DEFAULT = { chinese: 150, math: 150, english: 150, physics: 100, chemistry: 100, biology: 100 };
const subjName = (id) => (SUBJECTS.find((x) => x[0] === id) || ['', id])[1];

/** 列表筛选条件（跨渲染保留） */
const F = { grade: null, term: '', subject: 'all', type: '' };

// ---------------------------------------------------------------- 列表
export async function viewList() {
  const { api, esc } = A();
  const data = await api('/api/exams/sessions');
  const types = await api('/api/exams/types');
  const grade = F.grade || String(data.default_grade || 1);

  const qs = ['grade=' + encodeURIComponent(grade)];
  if (F.term) qs.push('term=' + encodeURIComponent(F.term));
  if (F.subject && F.subject !== 'all') qs.push('subject=' + encodeURIComponent(F.subject));
  if (F.type) qs.push('type=' + encodeURIComponent(F.type));
  const list = await api('/api/exams/sessions?' + qs.join('&'));

  const h = [];
  h.push('<div class="row between" style="margin-bottom:10px">'
    + '<div><h2 style="margin:0;font-size:16px">考试与试卷分析</h2>'
    + '<p class="muted" style="margin:4px 0 0">一场考试下挂六科，点进去补分数和排名。</p></div>'
    + '<button class="btn primary" data-act="exam-new">+ 新建考试</button>'
    + '</div>');

  // 筛选条
  h.push('<div class="bank-toolbar">');
  h.push('<div class="seg">' + GRADES.map(([v, label]) =>
    '<button class="seg-btn ' + (grade === v ? 'on' : '') + '" data-act="exam-filter" data-k="grade" data-v="' + v + '">'
    + label + '</button>').join('') + '</div>');
  h.push('<div class="seg">' + TERMS.map(([v, label]) =>
    '<button class="seg-btn ' + (F.term === v ? 'on' : '') + '" data-act="exam-filter" data-k="term" data-v="' + v + '">'
    + label + '</button>').join('')
    + (F.term ? '<button class="seg-btn" data-act="exam-filter" data-k="term" data-v="">全部学期</button>' : '')
    + '</div>');
  h.push('<div class="seg">'
    + '<button class="seg-btn ' + (F.subject === 'all' ? 'on' : '') + '" data-act="exam-filter" data-k="subject" data-v="all">全部科目</button>'
    + SUBJECTS.map(([v, label]) => '<button class="seg-btn ' + (F.subject === v ? 'on' : '') + '" data-act="exam-filter" data-k="subject" data-v="' + v + '">' + label + '</button>').join('')
    + '</div>');
  h.push('<div class="seg">'
    + '<button class="seg-btn ' + (F.type === '' ? 'on' : '') + '" data-act="exam-filter" data-k="type" data-v="">全部类型</button>'
    + types.map((t) => '<button class="seg-btn ' + (F.type === t.key ? 'on' : '') + '" data-act="exam-filter" data-k="type" data-v="' + t.key + '">' + esc(t.label) + '</button>').join('')
    + '<button class="seg-btn" data-act="exam-type-manage">类型管理</button>'
    + '</div>');
  h.push('</div>');

  if (!list.sessions.length) {
    h.push('<div class="card"><div class="empty">这个筛选下还没有考试。<br>点右上角「新建考试」，大考选多科，小考选一科。</div></div>');
    return h.join('');
  }

  h.push('<div class="exam-list">');
  for (const s of list.sessions) {
    const rate = s.sum_full > 0 ? Math.round((s.sum_score / s.sum_full) * 100) : null;
    const chips = s.subjects.map((e) => {
      const got = e.my_score == null ? '—' : Math.round(e.my_score * 10) / 10;
      return '<span class="badge d">' + esc(subjName(e.subject_id)) + ' ' + got + '/' + (e.full_score ?? '—') + '</span>';
    }).join(' ');
    h.push('<div class="exam-card" data-act="exam-session-open" data-id="' + s.id + '">'
      + '<div class="ec-head"><span class="badge d">' + esc(s.type_label) + '</span>'
      + '<strong>' + esc(s.title) + '</strong>'
      + '<span class="spacer" style="flex:1"></span>'
      + '<span class="muted">' + esc(s.exam_date || '') + '</span></div>'
      + '<div class="ec-score"><b>' + (s.sum_full ? Math.round(s.sum_score * 10) / 10 + ' / ' + s.sum_full : '未录分数') + '</b>'
      + (rate != null ? '<span class="ec-rate">总分率 ' + rate + '%</span>' : '')
      + '</div>'
      + '<div class="ec-meta"><span>' + s.subject_count + ' 科</span><span class="spacer" style="flex:1"></span>'
      + '<button class="btn sm ghost" data-act="exam-session-del" data-id="' + s.id + '">删除</button></div>'
      + '<div class="ec-chips">' + chips + '</div>'
      + '</div>');
  }
  h.push('</div>');
  return h.join('');
}

// ---------------------------------------------------------------- 新建
export async function viewNew() {
  const { api, esc } = A();
  const [types, presets, meta] = await Promise.all([
    api('/api/exams/types'), api('/api/exams/presets'), api('/api/meta'),
  ]);
  const today = meta.today;
  const grade = String(presets.default_grade || 1);

  const smallRow = '<div id="nSmallRow" style="display:none">'
    + '<div class="field-row">'
    + '<label class="field"><span>科目</span><select id="nSubjSingle">' + SUBJECTS.map(([id, l]) => '<option value="' + id + '">' + l + '</option>').join('') + '</select></label>'
    + '<label class="mini"><span>满分</span><input id="nSingleFull" type="number" step="0.5" value="150"></label>'
    + '<label class="mini"><span>得分</span><input id="nSingleScore" type="number" step="0.5" placeholder="—"></label>'
    + '</div></div>';
  const rows = SUBJECTS.map(([id, label]) => '<div class="subj-row" data-subj="' + id + '">'
    + '<label class="pick2"><input type="checkbox" data-sub="' + id + '"></label>'
    + '<span class="subj-name">' + label + '</span>'
    + '<label class="mini"><span>满分</span><input type="number" step="0.5" data-full="' + id + '" value="' + FULL_DEFAULT[id] + '"></label>'
    + '<label class="mini"><span>得分</span><input type="number" step="0.5" data-score="' + id + '" placeholder="—"></label>'
    + '</div>').join('');

  return '<div class="row" style="margin-bottom:12px"><button class="btn sm ghost" data-act="exam-list">← 考试列表</button></div>'
    + '<div class="card"><h2><span class="dot"></span>新建考试</h2>'
    + '<div class="field-row">'
    + '<label class="field"><span>年级</span><select id="nGrade">' + GRADES.map(([v, l]) => '<option value="' + v + '"' + (v === grade ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>'
    + '<label class="field"><span>学期</span><select id="nTerm">' + TERMS.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('') + '</select></label>'
    + '<label class="field"><span>类型</span><select id="nType">'
    + types.map((t) => '<option value="' + esc(t.key) + '">' + esc(t.label) + '</option>').join('')
    + '<option value="custom">自定义…</option></select></label>'
    + '</div>'
    + '<label class="field" id="nCustomWrap" style="display:none"><span>自定义类型名（填一次，以后永久出现在类型里）</span>'
    + '<input id="nCustom" placeholder="例如：周测 / 竞赛 / 摸底"></label>'
    + '<div class="field-row"><label class="field"><span>日期</span><input id="nDate" type="date" value="' + today + '"></label>'
    + '<label class="field"><span>规模</span><select id="nBig"><option value="1">大考（多科）</option><option value="0">小考（一科）</option></select></label>'
    + '</div>'
    + '<div class="field-row">'
    + '<label class="mini"><span>考试总分（选填）</span><input id="nTotal" type="number" step="0.5" placeholder="例如 750"></label>'
    + '<label class="mini"><span>总分满分（选填）</span><input id="nTotalFull" type="number" step="0.5" placeholder="例如 750"></label>'
    + '</div>'
    + '<div class="field-row">'
    + '<label class="mini"><span>班级总排名</span><input id="nRankClassAll" type="number" placeholder="—"></label>'
    + '<label class="mini"><span>班级人数</span><input id="nClassSizeAll" type="number" placeholder="56"></label>'
    + '<label class="mini"><span>校总排名</span><input id="nRankSchoolAll" type="number" placeholder="—"></label>'
    + '<label class="mini"><span>校总人数</span><input id="nSchoolSizeAll" type="number" placeholder="2200"></label>'
    + '</div>'
    + '<p class="muted" style="margin:0 0 8px;font-size:12px">名称不用填，自动生成（例如 2026高一上期中）。</p>'
    + smallRow
    + '<div id="nBigRows">' + rows + '</div>'
    + '<div class="field-row">'
    + '<label class="field"><span>班级人数（常用值可选）</span><input id="nClassSize" list="dlClass" placeholder="56"><datalist id="dlClass">'
    + [56, 2000, 2200].concat(presets.class_sizes || []).filter((v, i, a) => a.indexOf(v) === i).map((v) => '<option value="' + v + '">').join('')
    + '</datalist></label>'
    + '<label class="field"><span>校总人数（常用值可选）</span><input id="nSchoolSize" list="dlSchool" placeholder="2200"><datalist id="dlSchool">'
    + [2000, 2200].concat(presets.school_sizes || []).filter((v, i, a) => a.indexOf(v) === i).map((v) => '<option value="' + v + '">').join('')
    + '</datalist></label>'
    + '</div>'
    + '<button class="btn primary block" data-act="exam-create">创建</button>'
    + '</div>';
}

// ---------------------------------------------------------------- 一场考试（多科）
export async function viewSession(id) {
  const { api, esc } = A();
  const d = await api('/api/exams/sessions/' + id);
  const s = d.session;
  const subs = d.subjects;
  const h = [];

  h.push('<div class="row between" style="margin-bottom:10px">'
    + '<button class="btn sm ghost" data-act="exam-list">← 考试列表</button>'
    + '<span class="muted">' + esc(s.exam_date || '') + '</span></div>');

  h.push('<div class="card"><div class="row between" style="align-items:flex-start;gap:10px">'
    + '<div><h2 style="margin:0 0 4px"><span class="dot"></span>' + esc(s.title) + '</h2>'
    + '<p class="muted" style="margin:0">' + esc(s.type_label) + ' · ' + (s.is_big ? '大考' : '小考') + ' · ' + subs.length + ' 科</p></div>'
    + '<div class="row" style="gap:6px">'
    + '<button class="btn sm primary" data-act="exam-save-all">一键保存全部</button>'
    + '<button class="btn sm" data-act="exam-session-edit" data-id="' + s.id + '">' + (S3.edit ? '收起' : '改这场考试') + '</button>'
    + '</div></div>');
  if (S3.edit) {
    h.push('<div class="edit-form" style="margin-top:12px">'
      + '<div class="field-row">'
      + '<label class="field"><span>年级</span><select id="eGrade">' + GRADES.map(([v, l]) => '<option value="' + v + '"' + (String(s.grade) === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>'
      + '<label class="field"><span>学期</span><select id="eTerm">' + TERMS.map(([v, l]) => '<option value="' + v + '"' + (s.term === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>'
      + '<label class="field"><span>类型</span><select id="eType">' + (await api('/api/exams/types')).map((t) => '<option value="' + esc(t.key) + '"' + (s.exam_type === t.key ? ' selected' : '') + '>' + esc(t.label) + '</option>').join('') + '</select></label>'
      + '<label class="field"><span>日期</span><input id="eDate" type="date" value="' + esc(s.exam_date || '') + '"></label>'
      + '</div>'
      + '<p class="muted" style="font-size:12px;margin:0 0 8px">改了年级/学期/类型，名称会自动重算。</p>'
      + '<button class="btn primary sm" data-act="exam-session-save" data-id="' + s.id + '">保存这场考试</button>'
      + '</div>');
  }

  // 整场成绩（各科之外）：总分与班级/校总排名
  const hasTotal = s.total_score != null || s.rank_class_total != null || s.rank_school_total != null;
  h.push('<div class="card">'
    + '<div class="row between" style="margin-bottom:8px">'
    + '<h2 style="margin:0"><span class="dot"></span>整场成绩</h2>'
    + '<button class="btn sm ghost" data-act="exam-total-edit">' + (S3.total ? '收起' : '编辑') + '</button>'
    + '</div>'
    + (hasTotal
      ? '<div class="stats">'
        + '<div class="s"><div class="n">' + (s.total_score != null ? fmtScore(s.total_score) : '—') + '</div><div class="l">总分' + (s.full_score_total ? ' / ' + fmtScore(s.full_score_total) : '') + '</div></div>'
        + '<div class="s"><div class="n">' + (s.rank_class_total != null ? s.rank_class_total : '—') + '</div><div class="l">班级排名' + (s.class_size_total ? ' / ' + s.class_size_total : '') + '</div></div>'
        + '<div class="s"><div class="n">' + (s.rank_school_total != null ? s.rank_school_total : '—') + '</div><div class="l">校排名' + (s.school_size_total ? ' / ' + s.school_size_total : '') + '</div></div>'
        + '</div>'
      : '<p class="muted" style="margin:0">还没填整场总分和总排名。点「编辑」补上，列表里就能看到总分率。</p>')
    + (S3.total
      ? '<div class="edit-form" style="margin-top:10px">'
        + '<div class="field-row">'
        + '<label class="mini"><span>考试总分</span><input id="tTotal" type="number" step="0.5" value="' + (s.total_score ?? '') + '" placeholder="750"></label>'
        + '<label class="mini"><span>总分满分</span><input id="tTotalFull" type="number" step="0.5" value="' + (s.full_score_total ?? '') + '" placeholder="750"></label>'
        + '</div>'
        + '<div class="field-row">'
        + '<label class="mini"><span>班级总排名</span><input id="tRankClass" type="number" value="' + (s.rank_class_total ?? '') + '"></label>'
        + '<label class="mini"><span>班级人数</span><input id="tClassSize" type="number" value="' + (s.class_size_total ?? '') + '"></label>'
        + '<label class="mini"><span>校总排名</span><input id="tRankSchool" type="number" value="' + (s.rank_school_total ?? '') + '"></label>'
        + '<label class="mini"><span>校总人数</span><input id="tSchoolSize" type="number" value="' + (s.school_size_total ?? '') + '"></label>'
        + '</div>'
        + '<button class="btn primary sm" data-act="exam-total-save" data-id="' + s.id + '">保存整场成绩</button>'
        + '</div>'
      : '')
    + '</div>');

// 科目行：全部字段可改
  for (const e of subs) {
    h.push('<div class="card subj-card" data-eid="' + e.id + '">'
      + '<div class="row between" style="margin-bottom:8px">'
      + '<strong>' + esc(subjName(e.subject_id)) + '</strong>'
      + '<div class="row" style="gap:6px">'
      + '<button class="btn sm" data-act="exam-open" data-id="' + e.id + '">传图与分析 →</button>'
      + '<button class="btn sm ghost" data-act="exam-subject-del" data-id="' + e.id + '">移除</button>'
      + '</div></div>'
      + '<div class="field-row">'
      + '<label class="mini"><span>满分</span><input type="number" step="0.5" data-f="full_score" value="' + (e.full_score ?? '') + '"></label>'
      + '<label class="mini"><span>得分</span><input type="number" step="0.5" data-f="my_score" value="' + (e.my_score ?? '') + '"></label>'
      + '<label class="mini"><span>赋分</span><select data-f="has_grade_point"><option value="0"' + (e.has_grade_point ? '' : ' selected') + '>不计</option><option value="1"' + (e.has_grade_point ? ' selected' : '') + '>计赋分</option></select></label>'
      + '</div>'
      + '<div class="field-row">'
      + '<label class="mini"><span>班级排名</span><input type="number" data-f="rank_class" value="' + (e.rank_class ?? '') + '"></label>'
      + '<label class="mini"><span>班级人数</span><input type="number" data-f="class_size" value="' + (e.class_size ?? '') + '"></label>'
      + '<label class="mini"><span>校排名</span><input type="number" data-f="rank_school" value="' + (e.rank_school ?? '') + '"></label>'
      + '<label class="mini"><span>校总人数</span><input type="number" data-f="school_size" value="' + (e.school_size ?? '') + '"></label>'
      + '</div>'
      + '<button class="btn sm" data-act="exam-subject-save" data-id="' + e.id + '">保存这一科</button>'
      + '</div>');
  }

  // 补一科：勾选式（可以一次加多科），比下拉好点，也符合「打勾选择」的习惯
  const missing = SUBJECTS.filter(([id]) => !subs.some((e) => e.subject_id === id));
  if (missing.length) {
    h.push('<div class="card"><h2><span class="dot"></span>加科目</h2>'
      + '<p class="muted" style="margin:0 0 10px">勾选要补的科目，可以多选。</p>'
      + '<div class="subj-pick-row">'
      + missing.map(([id, label]) => '<label class="subj-pick"><input type="checkbox" data-addsub="' + id + '"><span>' + label + '</span></label>').join('')
      + '</div>'
      + '<div class="field-row" style="margin-top:10px">'
      + '<label class="mini"><span>满分（留空按默认）</span><input id="addFull2" type="number" step="0.5" placeholder="150 / 100"></label>'
      + '</div>'
      + '<button class="btn sm primary" data-act="exam-add-subjects" data-id="' + s.id + '">加入这场考试</button>'
      + '</div>');
  }
  return h.join('');
}

async function uploadExamPages(input) {
  const files = [...(input.files || [])];
  input.value = '';
  if (!files.length) return;
  const examId = S2.detail?.exam?.id || S2.id;
  if (!examId) return toast('先打开一场考试', 'err');
  const fd = new FormData();
  let kept = 0;
  for (const f of files) {
    let blob = f;
    try {
      const edited = await window.__app?.editImage?.(f);
      if (edited === null) continue;
      if (edited) blob = edited;
    } catch { /* 编辑器打不开就用原图 */ }
    fd.append('photos', blob, 'page.jpg');
    kept++;
  }
  if (!kept) return;
  toast('上传中（' + kept + ' 张）…', 'ok');
  try {
    await api('/api/exams/' + examId + '/pages', { method: 'POST', form: fd });
    toast('已上传 ' + kept + ' 张，可以接着拍下一张', 'ok');
  } catch (err) {
    toast('上传失败：' + err.message, 'err');
    return false;
  }
  // 不整页重渲染：重渲染会把滚动位置弹回顶部，用户以为流程结束、要重新找按钮。
  // 只用接口数据把新增的图补到列表里，视觉焦点留在传图区。
  await refreshPages();
  const card = document.querySelector('#main .card');
  if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start' });
  return true;
}

async function refreshPages() {
  await render();
  const card = document.querySelector('#main .card');
  if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start' });
}

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
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <label class="btn primary" style="margin:0">
          ${pages.length ? '再拍一张' : '拍照'}
          <input type="file" id="exCam" accept="image/*" capture="environment" hidden>
        </label>
        <label class="btn" style="margin:0">
          从相册选
          <input type="file" id="exFiles" accept="image/*" multiple hidden>
        </label>
        <button class="btn" data-act="exam-extract-all" ${done === pages.length ? 'disabled' : ''}>
          识别全部未识别（${pages.length - done}）
        </button>
        <button class="btn" data-act="exam-merge" ${done ? '' : 'disabled'}>合并到题目列表</button>
      </div>
      ${pages.length ? '<p class="small" style="margin:8px 0 0">已传 ' + pages.length + ' 张。拍完一张可以直接接着点「再拍一张」，不用退出去。</p>' : ''}
      <p class="muted" style="margin:8px 0 0;font-size:12px">识别会自动判断这张是原卷 / 答题卡 / 答案，判断理由写在卡片上。</p>
    </div>
  `);

  if (!pages.length) {
    h.push('<div class="card"><div class="empty">还没有图片。点「拍照」或「从相册选」开始。</div></div>');
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
const S3 = { edit: false, total: false };
const idxOf = () => Number((String(location.hash).split('/')[2] || '').replace(/\D.*$/, ''));

/** 新建页：把勾选与填写的科目收成数组 */
/** 读一张科目卡片上的全部字段（空 = null，表示清空这一项） */
function readCard(card) {
  const body = {};
  for (const inp of card.querySelectorAll('[data-f]')) {
    const k = inp.dataset.f;
    body[k] = inp.value === '' ? null : Number(inp.value);
  }
  return body;
}

function collectNewSubjects() {
  const big = document.getElementById('nBig')?.value !== '0';
  const common = {
    rank_class: Number(document.getElementById('nRankClass')?.value) || null,
    class_size: Number(document.getElementById('nClassSize')?.value) || null,
    rank_school: Number(document.getElementById('nRankSchool')?.value) || null,
    school_size: Number(document.getElementById('nSchoolSize')?.value) || null,
  };
  if (!big) {
    const id = document.getElementById('nSubjSingle')?.value;
    if (!id) return [];
    const full = Number(document.getElementById('nSingleFull')?.value) || FULL_DEFAULT[id] || 100;
    const raw = document.getElementById('nSingleScore')?.value;
    return [{ subject_id: id, full_score: full, my_score: raw === '' || raw == null ? null : Number(raw), ...common }];
  }
  const out = [];
  for (const [id] of SUBJECTS) {
    const cb = document.querySelector('[data-sub="' + id + '"]');
    if (!cb || !cb.checked) continue;
    const full = Number(document.querySelector('[data-full="' + id + '"]')?.value) || FULL_DEFAULT[id];
    const raw = document.querySelector('[data-score="' + id + '"]')?.value;
    out.push({ subject_id: id, full_score: full, my_score: raw === '' || raw == null ? null : Number(raw), ...common });
  }
  return out;
}


/** 科目一换，满分跟着换（语数英 150，物化生 100） */
function setFullFor(select, fullId) {
  if (!select) return;
  const input = document.getElementById(fullId);
  if (input) input.value = FULL_DEFAULT[select.value] ?? 100;
}

export async function handle(act, el) {
  const { api, toast, render } = A();
  const id = Number((location.hash.split('/')[2] || '').replace(/\D.*$/, ''));

  // ---------------------------------------------------------------- 新：筛选与考次
  if (act === 'exam-filter') {
    F[el.dataset.k] = el.dataset.v;
    if (el.dataset.k === 'grade') F.grade = el.dataset.v;
    return render();
  }

  if (act === 'exam-session-open') return A().go('session/' + el.dataset.id);

  if (act === 'exam-total-edit') {
    S3.total = !S3.total;
    return render();
  }

  if (act === 'exam-total-save') {
    el.disabled = true;
    try {
      await api('/api/exams/sessions/' + el.dataset.id, {
        method: 'PATCH',
        body: {
          total_score: numOrNull('tTotal'),
          full_score_total: numOrNull('tTotalFull'),
          rank_class_total: numOrNull('tRankClass'),
          class_size_total: numOrNull('tClassSize'),
          rank_school_total: numOrNull('tRankSchool'),
          school_size_total: numOrNull('tSchoolSize'),
        },
      });
      toast('整场成绩已保存', 'ok');
      S3.total = false;
    } catch (err) {
      toast(err.message, 'err');
      el.disabled = false;
      return true;
    }
    return render();
  }
  if (act === 'exam-session-edit') {
    S3.edit = !S3.edit;
    return render();
  }

  if (act === 'exam-create') {
    const typeSel = document.getElementById('nType')?.value;
    const custom = document.getElementById('nCustom')?.value.trim();
    el.disabled = true;
    try {
      let typeKey = typeSel;
      if (typeSel === 'custom') {
        if (!custom) { el.disabled = false; return toast('选了自定义就把类型名填上', 'warn'); }
        const made = await api('/api/exams/types', { method: 'POST', body: { label: custom } });
        typeKey = made.type.key;
      }
      const subjects = collectNewSubjects();
      if (!subjects.length) { el.disabled = false; return toast('至少选一科', 'warn'); }
      const r = await api('/api/exams/sessions', {
        method: 'POST',
        body: {
          grade: document.getElementById('nGrade')?.value,
          term: document.getElementById('nTerm')?.value,
          exam_type: typeKey,
          exam_date: document.getElementById('nDate')?.value,
          is_big: document.getElementById('nBig')?.value !== '0',
          total_score: numOrNull('nTotal'),
          full_score_total: numOrNull('nTotalFull'),
          rank_class_total: numOrNull('nRankClassAll'),
          class_size_total: numOrNull('nClassSizeAll'),
          rank_school_total: numOrNull('nRankSchoolAll'),
          school_size_total: numOrNull('nSchoolSizeAll'),
          subjects,
        },
      });
      toast('已创建：' + r.session.title, 'ok');
      A().go('session/' + r.id);
    } catch (e) {
      el.disabled = false;
      toast(e.message, 'err');
      return true;
    }
    return true;
  }

  if (act === 'exam-session-save') {
    const id = el.dataset.id;
    el.disabled = true;
    try {
      await api('/api/exams/sessions/' + id, {
        method: 'PATCH',
        body: {
          grade: document.getElementById('eGrade')?.value,
          term: document.getElementById('eTerm')?.value,
          exam_type: document.getElementById('eType')?.value,
          exam_date: document.getElementById('eDate')?.value,
        },
      });
      S3.edit = false;
      toast('已保存', 'ok');
    } catch (e) { toast(e.message, 'err'); el.disabled = false; return true; }
    return render();
  }

  if (act === 'exam-session-del') {
    if (!confirm('删掉这场考试？下面的科目记录一起删，已收进错题库的题不受影响。')) return true;
    await api('/api/exams/sessions/' + el.dataset.id, { method: 'DELETE' });
    toast('已删除', 'ok');
    return A().go('exams');
  }

  if (act === 'exam-subject-save') {
    const card = el.closest('.subj-card');
    el.disabled = true;
    try {
      await api('/api/exams/' + el.dataset.id, { method: 'PATCH', body: readCard(card) });
    } catch (err) {
      el.disabled = false;
      toast(err.message, 'err');
      return true;
    }
    // 关键：保存单科**不重渲染**，否则其他科目里还没保存的输入会被清空
    el.disabled = false;
    el.textContent = '✓ 已保存';
    setTimeout(() => { el.textContent = '保存这一科'; }, 1600);
    return true;
  }

  if (act === 'exam-save-all') {
    const cards = [...document.querySelectorAll('.subj-card')];
    if (!cards.length) return true;
    el.disabled = true;
    el.textContent = '保存中…';
    let ok = 0, fail = 0;
    for (const card of cards) {
      try {
        await api('/api/exams/' + card.dataset.eid, { method: 'PATCH', body: readCard(card) });
        ok++;
      } catch { fail++; }
    }
    toast(fail ? ('保存 ' + ok + ' 科，失败 ' + fail + ' 科') : ('已保存 ' + ok + ' 科'), fail ? 'err' : 'ok');
    return render();
  }

  if (act === 'exam-subject-del') {
    if (!confirm('把这一科从这场考试里移除？（已传的图和题也会一起删）')) return true;
    await api('/api/exams/' + el.dataset.id, { method: 'DELETE' });
    toast('已移除', 'ok');
    return render();
  }

  if (act === 'exam-add-subjects') {
    const picked = [...document.querySelectorAll('[data-addsub]:checked')].map((i) => i.dataset.addsub);
    if (!picked.length) return toast('先勾选要加的科目', 'warn');
    const fullEl = document.getElementById('addFull2');
    const full = fullEl && fullEl.value !== '' ? Number(fullEl.value) : null;
    el.disabled = true;
    let ok = 0;
    for (const subject_id of picked) {
      try {
        const body = full ? { subject_id, full_score: full } : { subject_id };
        await api('/api/exams/sessions/' + el.dataset.id + '/subjects', { method: 'POST', body });
        ok++;
      } catch (err) {
        toast(err.message, 'err');
      }
    }
    if (ok) toast('已加入 ' + ok + ' 科', 'ok');
    return render();
  }
  if (act === 'exam-add-subject') {
    const subject_id = document.getElementById('addSubj')?.value;
    if (!subject_id) return toast('没有可加的科目了', 'warn');
    const body = {
      subject_id,
      full_score: Number(document.getElementById('addFull')?.value) || FULL_DEFAULT[subject_id],
      my_score: document.getElementById('addScore')?.value === '' ? null : Number(document.getElementById('addScore')?.value),
    };
    el.disabled = true;
    try {
      await api('/api/exams/sessions/' + el.dataset.id + '/subjects', { method: 'POST', body });
      toast('已加入', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    return render();
  }

  if (act === 'exam-type-manage') {
    const types = await api('/api/exams/types');
    const cur = types.map((t) => t.label + (t.builtin ? '（内置）' : '')).join('\n');
    const pick = prompt('现有类型：\n' + cur + '\n\n输入要改名/新增的类型名（留空取消）', '');
    if (!pick) return true;
    const target = types.find((t) => t.label === pick);
    if (target) {
      const next = prompt('把「' + target.label + '」改成：', target.label);
      if (next && next !== target.label) {
        await api('/api/exams/types/' + target.id, { method: 'PATCH', body: { label: next } });
        toast('已改名', 'ok');
      }
    } else {
      await api('/api/exams/types', { method: 'POST', body: { label: pick } });
      toast('已新增类型', 'ok');
    }
    return render();
  }


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

  if (act === 'exam-pick-legacy') {
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
    const pid = Number(el.dataset.pid);
    el.disabled = true;
    el.textContent = '识别中…';
    extractOne(pid, id);            // 不 await：可以立刻切走
    return true;
  }

  if (act === 'exam-extract-all') {
    const todo = (S2.detail?.pages || []).filter((p) => p.status !== 'done' && !JOBS.has(p.id));
    if (!todo.length) return toast('没有待识别的图了', 'warn');
    el.disabled = true;
    el.textContent = '已开始 ' + todo.length + ' 张';
    extractQueue(todo.map((p) => p.id), id);   // 后台排队跑
    toast('已开始识别 ' + todo.length + ' 张，可以先去录别的科目', 'ok');
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
    document.querySelector('.zoom-layer')?.remove();
    const layer = document.createElement('div');
    layer.className = 'zoom-layer';
    layer.innerHTML = '<img src="' + url + '" alt="原图">'
      + '<button class="btn sm zoom-close" type="button">关闭</button>';
    layer.addEventListener('click', (ev) => {
      if (ev.target === layer || ev.target.classList.contains('zoom-close')) layer.remove();
    });
    document.body.appendChild(layer);
    return true;
  }

  return false;
}


/** 正在后台识别的图片：pageId → examId。用它在任何页面都能显示进度、也不误刷新别的页 */
const JOBS = new Map();

const hashIsExam = (examId) => String(location.hash || '').startsWith('#/exams/' + examId);

/** 角落里的小提示：告诉你后台还有几张在识别 */
function paintJobsBadge() {
  let el = document.getElementById('jobsBadge');
  if (!JOBS.size) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'jobsBadge';
    el.className = 'jobs-badge';
    el.addEventListener('click', () => { el.remove(); });
    document.body.appendChild(el);
  }
  el.textContent = '后台识别中 ' + JOBS.size + ' 张（可以先去别的科目）';
}

/**
 * 识别一张图：故意不 await，让用户可以立刻切到别的科目。
 * 完成后只有当人还停在这场考试上才重渲染——否则会把别处正在填的内容冲掉。
 */
async function extractOne(pid, examId) {
  if (JOBS.has(pid)) return;
  JOBS.set(pid, examId);
  paintJobsBadge();
  try {
    const r = await api('/api/exams/pages/' + pid + '/extract', { method: 'POST', body: {} });
    toast('识别到 ' + r.staged + ' 道题', 'ok');
  } catch (e) {
    toast('识别失败：' + e.message, 'err');
  } finally {
    JOBS.delete(pid);
    paintJobsBadge();
    if (hashIsExam(examId)) render();
  }
}

/** 一次识别多张：排队跑，避免同时打太多请求把模型限流 */
async function extractQueue(pids, examId) {
  for (const pid of pids) {
    if (!JOBS.has(pid)) await extractOne(pid, examId);
  }
  if (hashIsExam(examId)) toast('这一科的图都识别完了', 'ok');
}

export function bindEvents() {

  // select 的 change 用事件委托，避免每次渲染重建监听
  document.addEventListener('change', async (e) => {
    // 考试传图：拍照 / 相册选，都先过一遍裁切旋转再上传
    if (e.target.id === 'exCam' || e.target.id === 'exFiles') { await uploadExamPages(e.target); return; }
    // 新建页：大考/小考切换（DOM 每次渲染都会重建，只能委托）
    if (e.target.id === 'nBig') {
      const big = e.target.value !== '0';
      const bigBox = document.getElementById('nBigRows');
      const smallBox = document.getElementById('nSmallRow');
      if (bigBox) bigBox.style.display = big ? '' : 'none';
      if (smallBox) smallBox.style.display = big ? 'none' : '';
      if (!big) setFullFor(e.target.parentElement.querySelector('#nSubjSingle'), 'nSingleFull');
      return;
    }
    // 科目换满分：语数英 150，物化生 100
    if (e.target.id === 'nSubjSingle') { setFullFor(e.target, 'nSingleFull'); return; }
    if (e.target.id === 'addSubj') { setFullFor(e.target, 'addFull'); return; }
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

window.__exams = { viewList, viewNew, viewSession, viewDetail, handle, bindEvents, resetState };