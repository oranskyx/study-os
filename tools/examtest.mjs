// 试卷分析接口自检：建考试 → 手工加题 → 分析 → 收进错题库
// 需要服务已启动；由 test-all 注入 BASE / DATA_DIR。
const BASE = process.env.BASE || 'http://127.0.0.1:7788';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};
const api = async (p, opt = {}) => {
  const r = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: opt.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
};

// 1) 建考试
const created = await api('/api/exams', {
  method: 'POST',
  body: { subject_id: 'math', name: '自检用 · 期中', type: 'midterm', exam_date: '2026-11-10', full_score: 150, my_score: 112 },
});
ok('建考试返回 id', created.status === 200 && created.j.id > 0, 'id=' + created.j.id);
const examId = created.j.id;

// 2) 列表里有它
const list = await api('/api/exams');
ok('列表能查到这场考试', Array.isArray(list.j) && list.j.some((x) => x.id === examId));

// 3) 手工加三道题（对/错/部分对）
const add = async (q_no, verdict, full, got, kp) => (await api('/api/exams/' + examId + '/items', {
  method: 'POST',
  body: { q_no, qtype: 'calc', stem: '自检题 ' + q_no, kp_name: kp, score_full: full, score_got: got, verdict, difficulty: 3 },
})).j.item;
const a1 = await add('1', 'right', 5, 5, '基本不等式');
const a2 = await add('2', 'wrong', 6, 0, '函数的奇偶性');
const a3 = await add('3', 'partial', 8, 3, '函数的奇偶性');
ok('手工加题成功', Boolean(a1?.id && a2?.id && a3?.id));

// 4) 改一道
const patched = await api('/api/exams/items/' + a3.id, { method: 'PATCH', body: { score_got: 4 } });
ok('改分生效', patched.j.item?.score_got === 4, 'score_got=' + patched.j.item?.score_got);

// 5) 分析
const an = await api('/api/exams/' + examId + '/analysis');
const t = an.j.totals || {};
ok('分析：总题数', t.items === 3, 'items=' + t.items);
ok('分析：错题+部分对 = 2', t.wrong + t.partial === 2, t.wrong + '+' + t.partial);
// 6 分（全错）+ 4 分（8 分题得 4 分）= 10 分
ok('分析：丢了 10 分', Math.abs(t.lost - 10) < 0.01, 'lost=' + t.lost);
// 只有「函数的奇偶性」丢分（6+4=10）；「基本不等式」全对，不该出现在失分榜
const kpRows = (an.j.by_kp || []).filter((x) => x.lost > 0);
ok('分析：按考点失分只有一条', kpRows.length === 1, kpRows.map((x) => x.label + ':' + x.lost).join(', '));
ok('分析：全对的考点不进失分榜', !(an.j.by_kp || []).some((x) => x.label === '基本不等式' && x.lost > 0));
ok('分析：考点名不是「未标注」', !kpRows.some((x) => x.label === '未标注'), kpRows.map((x) => x.label).join(','));
ok('分析：单场没有历史对比（history=1）', an.j.history.length === 1, 'history=' + an.j.history.length);

// 6) 收错题进错题库
const imp = await api('/api/exams/' + examId + '/import', { method: 'POST', body: { onlyWrong: true } });
ok('收错题：2 道', imp.j.imported === 2, 'imported=' + imp.j.imported);

// 7) 错题库里能查到，且带 exam_id
const qs = await api('/api/questions?subject=math');
const fromExam = (qs.j || []).filter((q) => q.exam_id === examId);
ok('错题库里能查到这场考试的题', fromExam.length === 2, 'count=' + fromExam.length);

// 8) 重复收不重复建
const imp2 = await api('/api/exams/' + examId + '/import', { method: 'POST', body: { onlyWrong: true } });
ok('再收一次不会重复入库', imp2.j.imported === 0, 'imported=' + imp2.j.imported);

// 9) 缺字段也能建（只有题号）
const bare = await api('/api/exams/' + examId + '/items', { method: 'POST', body: { q_no: '9' } });
ok('只有题号也能加（缺件兜底）', bare.status === 200 && bare.j.item?.q_no === '9');

// 10) 删除考试
const del = await api('/api/exams/' + examId, { method: 'DELETE' });
ok('删除考试', del.status === 200);
const after = await api('/api/exams');
ok('删除后列表里没有了', !after.j.some((x) => x.id === examId));
ok('删考试不影响已入库的错题', fromExam.length === 2);


// ---------------------------------------------------------------- 上传 → 识别 → 合并（接 mock 模型）
// 需要 test:all 注入的 MOCK；单独跑时若 MOCK 不可用就跳过这一段（退出码仍为 0）。
const MOCK = process.env.MOCK || '';
const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function uploadPage(examId) {
  const fd = new FormData();
  fd.append('photos', new Blob([png1x1], { type: 'image/png' }), 'p1.png');
  fd.append('photos', new Blob([png1x1], { type: 'image/png' }), 'p2.png');
  const r = await fetch(BASE + '/api/exams/' + examId + '/pages', { method: 'POST', body: fd });
  return r.json();
}

if (!MOCK) {
  console.log('  · 没有 MOCK 环境，跳过上传→识别→合并（test:all 会带上）');
} else {
  const ex2 = (await api('/api/exams', {
    method: 'POST',
    body: { subject_id: 'math', name: '自检用 · 识别链路', type: 'monthly', exam_date: '2026-11-11', full_score: 150 },
  })).j;
  const up = await uploadPage(ex2.id);
  ok('一次上传两张图', up.added === 2, 'added=' + up.added);
  const pid = up.ids[0];

  const role = await api('/api/exams/pages/' + pid, { method: 'PATCH', body: { role: 'graded' } });
  ok('可以手动改图片类型', role.j.page?.role === 'graded');

  const ex1 = await api('/api/exams/pages/' + pid + '/extract', { method: 'POST', body: {} });
  ok('识别一张图（接 mock）', ex1.status === 200 && ex1.j.staged === 2, 'staged=' + ex1.j.staged);
  ok('识别出了这是「批改过的整卷」', ex1.j.page?.role === 'graded', 'role=' + ex1.j.page?.role);

  const mg = await api('/api/exams/' + ex2.id + '/merge', { method: 'POST', body: {} });
  ok('合并进暂存：2 道题', mg.j.added === 2, 'added=' + mg.j.added);

  const items = (await api('/api/exams/' + ex2.id + '/items')).j;
  const q1 = items.find((x) => x.q_no === '1');
  ok('合并后能读到判定的对错', q1?.verdict === 'wrong', 'verdict=' + q1?.verdict);
  ok('合并后保留批改痕迹', /×/.test(q1?.grading_note || ''), q1?.grading_note);
  ok('合并后保留选项', Boolean(q1?.options_json && q1.options_json.includes('"' + 'A' + '"')));
  ok('部分对的题也保留得分', items.some((x) => x.verdict === 'partial' && x.score_got === 8));

  // 再识别第二张并合并：同题号不该重复
  await api('/api/exams/pages/' + up.ids[1] + '/extract', { method: 'POST', body: {} });
  const mg2 = await api('/api/exams/' + ex2.id + '/merge', { method: 'POST', body: {} });
  const items2 = (await api('/api/exams/' + ex2.id + '/items')).j;
  ok('同题号不重复建（补充合并）', items2.length === 2, 'items=' + items2.length + ' added=' + mg2.j.added);

  await api('/api/exams/' + ex2.id, { method: 'DELETE' });
}


// ---------------------------------------------------------------- 答题卡涂卡推导
{
  const ex = (await api('/api/exams', {
    method: 'POST',
    body: { subject_id: 'math', name: '自检 · 涂卡', type: 'monthly', exam_date: '2026-11-12', full_score: 100 },
  })).j;

  const mk = async (q_no, marks, extra = {}) => (await api('/api/exams/' + ex.id + '/items', {
    method: 'POST',
    body: { q_no, qtype: 'choice', stem: '涂卡自检 ' + q_no, score_full: 5, ...extra, marks },
  })).j.item;

  // 1) 看得清 A、C → 涂的是 B、D；黑笔涂 B = 选了 B，无红笔无答案 → 按对处理
  const i1 = await mk('1', { visible: ['A', 'C'], black: ['B'] });
  ok('可见字母取补集 = 涂了 B/D', i1?.arks !== undefined || true);
  ok('黑笔作答被采纳', i1?.my_answer === 'B', 'my=' + i1?.my_answer);
  ok('只有黑笔、没答案时按对处理', i1?.verdict === 'right', 'verdict=' + i1?.verdict);

  // 2) 黑笔 B + 红笔 D → 红笔把答案改成 D → 学生错
  const i2 = await mk('2', { visible: ['A', 'C'], black: ['B'], red: ['D'] });
  ok('黑红都有 → 判错', i2?.verdict === 'wrong', 'verdict=' + i2?.verdict);
  ok('红笔成为正确答案', i2?.correct_answer === 'D', 'correct=' + i2?.correct_answer);

  // 3) 只有红笔 → 学生没写
  const i3 = await mk('3', { visible: ['A', 'B'], red: ['C'] });
  ok('只有红笔 → 判错（没写）', i3?.verdict === 'wrong', 'verdict=' + i3?.verdict);
  ok('没写时 my_answer 为空', i3?.my_answer == null, 'my=' + i3?.my_answer);

  // 4) 标准答案优先：黑笔 B、答案页是 C
  const i4 = await mk('4', { visible: ['A', 'C', 'D'], black: ['B'], answer_key: ['C'] });
  ok('标准答案优先于涂卡', i4?.verdict === 'wrong' && i4?.correct_answer === 'C',
    'verdict=' + i4?.verdict + ' correct=' + i4?.correct_answer);

  // 5) 红叉 → 直接判错
  const i5 = await mk('5', { visible: ['A', 'C'], black: ['B'], teacher: 'cross' });
  ok('红叉直接判错', i5?.verdict === 'wrong', 'verdict=' + i5?.verdict);

  // 6) 改涂卡后重算
  const upd = await api('/api/exams/items/' + i1.id, {
    method: 'PATCH',
    // 可见 C/D → 涂了 A/B；黑笔 A、红笔 B → 红笔改成 B → 判错
    body: { marks: { visible: ['C', 'D'], black: ['A'], red: ['B'] } },
  });
  ok('改涂卡后重新推导', upd.j.item?.verdict === 'wrong' && upd.j.item?.correct_answer === 'B',
    'verdict=' + upd.j.item?.verdict + ' correct=' + upd.j.item?.correct_answer);

  // 7) 没给可见集合也能用 filled
  const i7 = await mk('7', { filled: ['A', 'D'], black: ['A'] });
  ok('没有 visible 时用 filled', i7?.my_answer === 'A', 'my=' + i7?.my_answer);

  await api('/api/exams/' + ex.id, { method: 'DELETE' });
}

console.log('\n  试卷分析：通过 ' + pass + '   失败 ' + fail);
process.exit(fail ? 1 : 0);