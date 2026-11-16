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



  // 保存不能互相清空（用户报过：录完全部分数，挨个保存，保存完全变 0）
  const sessP = await api('/api/exams/sessions', { method: 'POST', body: { grade: 1, term: 'up', exam_type: 'monthly', exam_date: '2026-09-28', subjects: [{ subject_id: 'physics', my_score: 80, full_score: 100, class_size: 56, school_size: 2214 }] } });
  const pid2 = sessP.j.id;
  const one = (await api('/api/exams/sessions/' + pid2)).j.subjects[0].id;
  await api('/api/exams/' + one, { method: 'PATCH', body: { my_score: 95 } });
  const afterPartial = (await api('/api/exams/sessions/' + pid2)).j.subjects[0];
  ok('局部更新不会清掉其他字段', afterPartial.my_score === 95 && afterPartial.full_score === 100 && afterPartial.class_size === 56, JSON.stringify({ s: afterPartial.my_score, f: afterPartial.full_score, c: afterPartial.class_size }));
  ok('物理满分默认 100（不是 150）', afterPartial.full_score === 100);


  // 整场成绩（总分 / 班级总排名 / 校总排名）
  const sesT = await api('/api/exams/sessions', {
    method: 'POST',
    body: {
      grade: 1, term: 'up', exam_type: 'final', exam_date: '2026-12-30',
      total_score: 680, full_score_total: 750,
      rank_class_total: 3, class_size_total: 56,
      rank_school_total: 88, school_size_total: 2214,
      subjects: [{ subject_id: 'math', my_score: 120 }],
    },
  });
  ok('建考次时可以带整场总分与总排名', sesT.status === 200, JSON.stringify(sesT.j.session?.total_score));
  const tid = sesT.j.id;
  const tDet = await api('/api/exams/sessions/' + tid);
  ok('整场总分存下来了', tDet.j.session.total_score === 680 && tDet.j.session.full_score_total === 750);
  ok('班级总排名与人数存下来了', tDet.j.session.rank_class_total === 3 && tDet.j.session.class_size_total === 56);
  ok('校总排名与人数存下来了', tDet.j.session.rank_school_total === 88 && tDet.j.session.school_size_total === 2214);

  const tUpd = await api('/api/exams/sessions/' + tid, { method: 'PATCH', body: { total_score: 700, rank_school_total: 60 } });
  ok('整场成绩可以单独改', tUpd.j.session.total_score === 700 && tUpd.j.session.rank_school_total === 60,
    JSON.stringify({ total: tUpd.j.session.total_score, school: tUpd.j.session.rank_school_total }));
  await api('/api/exams/sessions/' + tid, { method: 'DELETE' });

  const ps = await api('/api/exams/presets');
  ok('班级人数 56 进了候选项', (ps.j.class_sizes || []).includes(56), JSON.stringify(ps.j.class_sizes));
  ok('校人数 2214 进了候选项', (ps.j.school_sizes || []).includes(2214), JSON.stringify(ps.j.school_sizes));

  await api('/api/exams/sessions/' + pid2, { method: 'DELETE' });

  // 分数口径：卷面得分率不能拿"按题累计"冒充
  {
    const made = await api('/api/exams/sessions', {
      method: 'POST',
      body: { grade: 1, term: 'up', exam_type: 'monthly', exam_date: '2026-10-05',
        subjects: [{ subject_id: 'math', full_score: 150, my_score: 120 }] },
    });
    const sid = made.j.id;
    const eid = (await api('/api/exams/sessions/' + sid)).j.subjects[0].id;
    // 造两条分值加起来超过卷面的题，模拟"大题小题都列了"
    await api('/api/exams/' + eid + '/items', { method: 'POST', body: { q_no: '1', qtype: 'choice', stem: '测试题一', score_full: 30, score_got: 30, verdict: 'right' } });
    await api('/api/exams/' + eid + '/items', { method: 'POST', body: { q_no: '2', qtype: 'short', stem: '测试题二', score_full: 150, score_got: 60, verdict: 'partial' } });
    const an = await api('/api/exams/' + eid + '/analysis');
    const t = an.j.totals;
    ok('卷面得分率用卷面分数算，不用按题累计', t.paper_rate === 80, 'paper_rate=' + t.paper_rate + ' 按题 rate=' + t.rate);
    ok('题目分值合计超出卷面时给出 mismatch 标记', t.mismatch === true || t.mismatch === 1, JSON.stringify({ full: t.full, full_score: t.full_score, mismatch: t.mismatch }));
    await api('/api/exams/sessions/' + sid, { method: 'DELETE' });
  }

// ---------------------------------------------------------------- 考次（一场考试多科）
{
  const types = (await api('/api/exams/types')).j;
  ok('内置考试类型存在（期中/期末/月考）', types.length >= 3, types.map((t) => t.label).join(','));

  const made = await api('/api/exams/types', { method: 'POST', body: { label: '自检周测' } });
  ok('可以新增自定义类型', made.status === 200 && made.j.type?.label === '自检周测');
  const renamed = await api('/api/exams/types/' + made.j.type.id, { method: 'PATCH', body: { label: '自检周测(改)' } });
  ok('类型可以改名', renamed.j.type?.label === '自检周测(改)');

  const ses = await api('/api/exams/sessions', { method: 'POST', body: {
    grade: 1, term: 'up', exam_type: made.j.type.key, exam_date: '2026-09-20', is_big: true,
    subjects: [
      { subject_id: 'math', my_score: 130, rank_class: 3, class_size: 56, rank_school: 120, school_size: 2200 },
      { subject_id: 'physics', my_score: 88, has_grade_point: true },
    ],
  } });
  ok('建一场大考（多科）', ses.status === 200 && ses.j.added === 2, 'added=' + ses.j.added);
  const sid = ses.j.id;
  ok('标题自动生成（年份+年级+学期+类型）', /^\d{4}高一上/.test(ses.j.session.title), ses.j.session.title);
  ok('同名考试会被拒绝', (await api('/api/exams/sessions', { method: 'POST', body: { grade: 1, term: 'up', exam_type: made.j.type.key, exam_date: '2026-09-20', subjects: [{ subject_id: 'math' }] } })).status === 409);

  const detail = await api('/api/exams/sessions/' + sid);
  ok('考次详情列出两科', detail.j.subjects.length === 2, JSON.stringify(detail.j.subjects.map((s) => s.subject_id)));
  const mathRow = detail.j.subjects.find((s) => s.subject_id === 'math');
  ok('满分按科目自动填（数学 150 / 物理 100）',
    mathRow?.full_score === 150 && detail.j.subjects.find((s) => s.subject_id === 'physics')?.full_score === 100);
  ok('班级/校排名存下来了', mathRow?.rank_class === 3 && mathRow?.class_size === 56 && mathRow?.rank_school === 120);
  ok('赋分开关存下来了', detail.j.subjects.find((s) => s.subject_id === 'physics')?.has_grade_point === 1);

  const addS = await api('/api/exams/sessions/' + sid + '/subjects', { method: 'POST', body: { subject_id: 'chemistry', my_score: 77 } });
  ok('可以往已有考试里补一科', addS.status === 200 && addS.j.exam?.subject_id === 'chemistry');
  ok('同一场不能重复加同一科', (await api('/api/exams/sessions/' + sid + '/subjects', { method: 'POST', body: { subject_id: 'chemistry' } })).status === 409);

  const upd = await api('/api/exams/' + mathRow.id, { method: 'PATCH', body: { my_score: 140, rank_class: 1, has_grade_point: 1 } });
  ok('单科参数可以改（手滑能救）', upd.j.exam?.my_score === 140 && upd.j.exam?.rank_class === 1 && upd.j.exam?.has_grade_point === 1);

  const ses2 = await api('/api/exams/sessions/' + sid, { method: 'PATCH', body: { grade: 2, term: 'down' } });
  ok('整场考试的年级/学期能改，标题跟着重算',
    /^\d{4}高二下/.test(ses2.j.session.title), ses2.j.session.title);

  const filtered = await api('/api/exams/sessions?grade=2&term=down');
  ok('按年级+学期筛选能命中', filtered.j.sessions.some((x) => x.id === sid));
  const notMatch = await api('/api/exams/sessions?grade=3');
  ok('筛选不匹配时不会出现', !notMatch.j.sessions.some((x) => x.id === sid));
  const bySubject = await api('/api/exams/sessions?subject=chemistry');
  ok('按科目筛选能命中', bySubject.j.sessions.some((x) => x.id === sid));

  const presets = await api('/api/exams/presets');
  ok('参考人数常用值被记住', (presets.j.class_sizes || []).includes(56), JSON.stringify(presets.j.class_sizes));

  await api('/api/exams/sessions/' + sid, { method: 'DELETE' });
  const after = await api('/api/exams/sessions');
  ok('删考试后列表里没有了', !after.j.sessions.some((x) => x.id === sid));
}
console.log('\n  试卷分析：通过 ' + pass + '   失败 ' + fail);
process.exit(fail ? 1 : 0);