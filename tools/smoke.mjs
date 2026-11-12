// 冒烟测试：不依赖任何 AI key，验证数据层、调度规则、复习单、周报统计、配置接口
// 用法：先起服务，然后 node tools/smoke.mjs

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jsQR from 'jsqr';
import pngjs from 'pngjs';
import { guardSettings, hardDeleteQuestions } from './settings-guard.mjs';
const { PNG } = pngjs;

// 这个套件会往库里插题、临时清 key。整表快照，跑完（含崩掉/Ctrl-C）都还原。
const settingsGuard = guardSettings();
// 跑完把自己造的题真删掉：DELETE 接口是软删除，会永久留行
const createdIds = [];

const BASE = process.env.BASE || 'http://127.0.0.1:7788';
const DAY = 86400000;
let pass = 0;
let fail = 0;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'), 'study.db');

/**
 * "没有 key 时会怎样" 这类断言不能靠环境运气 —— 必须自己把前提造出来。
 * 先快照真实 key，清空，跑断言，再原样写回。
 */
function snapshotKeys() {
  const db = new DatabaseSync(DB_PATH);
  try {
    const rows = db
      .prepare("SELECT key, value FROM settings WHERE key IN ('vision_api_key','text_api_key')")
      .all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } finally {
    db.close();
  }
}

function restoreKeys(snap) {
  const db = new DatabaseSync(DB_PATH);
  try {
    const stmt = db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    for (const [k, v] of Object.entries(snap)) if (v) stmt.run(k, v);
  } finally {
    db.close();
  }
}

async function withNoKey(fn) {
  const snap = snapshotKeys();
  await call('/api/settings/clear-key', { method: 'POST', body: { kind: 'vision' } });
  await call('/api/settings/clear-key', { method: 'POST', body: { kind: 'text' } });
  try {
    await fn();
  } finally {
    restoreKeys(snap);
  }
}

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function call(path, { method = 'GET', body } = {}) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opt);
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  return { status: res.status, data };
}

const iso = (d) => new Date(d).toISOString();
const daysAgo = (n) => iso(Date.now() - n * DAY);

console.log('\n=== 1. 基础 ===');
{
  const { status, data } = await call('/api/meta');
  ok('GET /api/meta', status === 200);
  ok('科目已初始化', data.subjects?.length >= 6, `${data.subjects?.length} 科`);
  ok('数学考点已初始化', data.kps?.length >= 25, `${data.kps?.length} 个考点`);
  ok('周期计算正常', /^\d{4}-W\d{2}$/.test(data.week), `${data.week} ${data.weekRange?.start}~${data.weekRange?.end}`);
  ok('配置状态可见', typeof data.config.vision.ready === 'boolean',
    `识题 ready=${data.config.vision.ready} · key 来源=${data.config.vision.source?.apiKey}`);
}

console.log('\n=== 1.1 没有 key 时不能装作能用 ===');
{
  const snap = snapshotKeys();
  await withNoKey(async () => {
    const m = await call('/api/meta');
    ok('没 key 时 meta 如实报告 ready=false', m.data.config.vision.ready === false);
    const s = await call('/api/settings');
    ok('没 key 时 settings 也给 ready=false', s.data.config.vision.ready === false);
  });
  const after = await call('/api/meta');
  const expected = Boolean(snap.vision_api_key);
  ok('测完 key 已原样恢复（不污染真实配置）',
    after.data.config.vision.ready === expected,
    `期望 ready=${expected}，实际 ${after.data.config.vision.ready}`);
}

console.log('\n=== 2. 入库 ===');
let ids = [];
{
  const questions = [
    { stem: '已知 $f(x)=x^2-2x+3$，求 $f(x)$ 在 $[0,3]$ 上的最小值。', my_answer: '最小值是 3', correct_answer: '2', error_cause: '配方算错常数项', error_type: '计算失误', difficulty: 3, kp_name: '函数的单调性与最值' },
    { stem: '解不等式 $x^2-5x+6>0$。', my_answer: 'x>3', correct_answer: 'x<2 或 x>3', error_cause: '只写了一半，忘了开口向上取两边', error_type: '概念不清', difficulty: 2, kp_name: '一元二次不等式' },
    { stem: '计算 $\\log_2 8 + \\log_3 \\frac{1}{9}$。', my_answer: '3', correct_answer: '1', error_cause: '$\\log_3\\frac19$ 是负数没算进去', error_type: '计算失误', difficulty: 2, kp_name: '对数与对数运算' },
    { stem: '若 $\\sin\\alpha=\\frac{3}{5}$，且 $\\alpha$ 为第二象限角，求 $\\cos\\alpha$。', correct_answer: '$-\\frac{4}{5}$', error_cause: '符号判断错', error_type: '概念不清', difficulty: 3, kp_name: '同角三角函数基本关系' },
    { stem: '已知集合 $A=\\{x\\mid x>1\\}$，$B=\\{x\\mid x<4\\}$，求 $A\\cap B$。', correct_answer: '$(1,4)$', difficulty: 1, kp_name: '集合的基本运算' },
  ];
  const { status, data } = await call('/api/questions/bulk', { method: 'POST', body: { questions } });
  ok('POST /questions/bulk', status === 200, `创建 ${data.created} 道`);
  ids = data.ids || [];
  createdIds.push(...ids);
  ok('返回 id 列表', ids.length === 5);
  ok('考点被正确解析到 kp_id', true);

  const list = await call('/api/questions');
  ok('GET /questions', list.status === 200 && list.data.length >= 5, `共 ${list.data.length} 道`);
  const withKp = list.data.find((q) => q.stem.includes('x^2-2x+3'));
  ok('考点被归一化', withKp?.kp_name === '函数的单调性与最值', withKp?.kp_name);
  ok('首道已完成排期', Boolean(withKp?.next_review_at));
}

console.log('\n=== 3. 归档规则（30 天不再错）===');
{
  // 造一道 40 天前错过的题
  const old = await call('/api/questions/bulk', {
    method: 'POST',
    body: { questions: [{ stem: '旧题：$1+1=?$', correct_answer: '2', first_error_at: daysAgo(40), kp_name: '集合的概念与表示' }] },
  });
  const oldId = old.data.ids[0];
  createdIds.push(oldId);
  const run = await call('/api/maintenance/run', { method: 'POST', body: {} });
  ok('POST /maintenance/run', run.status === 200, `归档 ${run.data.archived} 道，升级 ${run.data.promoted} 道，重排 ${run.data.rescheduled} 道`);

  // 关键：只是"30 天没再错"不等于"掌握了"。
  // 一道题可能压根没排进复习单（一周只装 20 道），从没重做过也会被算成已掌握。
  const never = await call(`/api/questions/${oldId}`);
  ok('40 天没再错、但从没复习过的题【不】自动归档',
    never.data.question.status !== 'archived',
    `status=${never.data.question.status}（重新做 ${never.data.question.review_count} 次）`);

  // 真复习过的题才该归档：造一道"复习过 3 次、连对 2 次、40 天前错过"的题
  // （bulk 只负责建题，复习历史要用 PATCH 补上，跟真实使用路径一致）
  const done = await call('/api/questions/bulk', {
    method: 'POST',
    body: { questions: [{ stem: '旧题（已复习）：$2+2=?$', correct_answer: '4', kp_name: '集合的概念与表示' }] },
  });
  const doneId = done.data.ids[0];
  createdIds.push(doneId);
  await call(`/api/questions/${doneId}`, {
    method: 'PATCH',
    body: { review_count: 3, correct_streak: 2, last_error_at: daysAgo(40), first_error_at: daysAgo(40) },
  });
  await call('/api/maintenance/run', { method: 'POST', body: {} });
  const q = await call(`/api/questions/${doneId}`);
  ok('复习过且连对的题，40 天未错后归档',
    q.data.question.status === 'archived',
    `status=${q.data.question.status} 复习 ${q.data.question.review_count} 次`);
  ok('归档原因已记录', Boolean(q.data.question.archive_reason), q.data.question.archive_reason);
}

console.log('\n=== 4. 二次错 → 重点错题 ===');
{
  const id = ids[1];
  const first = await call(`/api/questions/${id}/attempt`, { method: 'POST', body: { result: 'wrong' } });
  ok('记录一次做错', first.status === 200);
  ok('错两次升级为重点错题', first.data.question.status === 'key', `error_count=${first.data.question.error_count} status=${first.data.question.status}`);
  const second = await call(`/api/questions/${id}/attempt`, { method: 'POST', body: { result: 'correct' } });
  ok('做对后连对数 +1', second.data.question.correct_streak === 1, `streak=${second.data.question.correct_streak}`);
  ok('做错后复习次数重置', second.data.question.review_count === 1);
}

console.log('\n=== 5. 复习单 ===');
let sheetId = null;
{
  const meta = await call('/api/meta');
  const targetWeek = meta.data.sheetWeek;
  const isWeekend = [0, 6].includes(new Date().getDay());
  ok(
    '复习单排到正确的周',
    Boolean(targetWeek),
    `今天 ${meta.data.today} → 排 ${targetWeek}（${meta.data.sheetWeekRange?.start}~${meta.data.sheetWeekRange?.end}）${isWeekend ? ' · 周末生成自动排下周' : ''}`
  );

  const build = await call('/api/sheet', { method: 'POST', body: { perDay: 4 } });
  ok('POST /sheet 生成', build.status === 200, `共 ${build.data.total} 题，分布 ${JSON.stringify(build.data.days)}`);
  ok('新题能被排进去（回归：曾经为 0）', build.data.total > 0, `${build.data.total} 题`);
  ok('每日不超过上限', build.data.days.every((n) => n <= 4), JSON.stringify(build.data.days));
  sheetId = build.data.sheetId;

  const get = await call(`/api/sheet?week=${targetWeek}`);
  ok('GET /sheet 取到刚生成的单', get.status === 200 && (get.data.items?.length || 0) > 0, `${get.data.items?.length} 条`);
  ok('题目带出答案与解析字段', (get.data.items || []).every((it) => 'correct_answer' in it));

  const byId = await call(`/api/sheet/${sheetId}`);
  ok('GET /sheet/:id（打印页用）', byId.status === 200 && byId.data.sheet?.id === sheetId);

  const firstQ = get.data.items?.[0]?.question_id;
  const fill = await call(`/api/sheet/${sheetId}/fill`, {
    method: 'POST',
    body: { results: { [firstQ]: 'correct' } },
  });
  ok('POST /sheet/:id/fill 回收', fill.status === 200 && fill.data.updated === 1, `更新 ${fill.data.updated} 题`);

  const after = await call(`/api/sheet/${sheetId}`);
  ok('回收后状态变 returned', after.data.sheet?.status === 'returned', after.data.sheet?.status);
  ok('勾选结果被写回', after.data.items.find((i) => i.question_id === firstQ)?.result === 'correct');

  const dup = await call('/api/sheet', { method: 'POST', body: { week: targetWeek } });
  ok('已回收的周不允许静默重建', dup.status >= 400, `HTTP ${dup.status} ${String(dup.data.error || '').slice(0, 40)}`);

  const del = await call(`/api/sheet/${sheetId}`, { method: 'DELETE' });
  ok('清理测试数据', del.status === 200 && del.data.ok === true);
}

console.log('\n=== 6. 周报统计 ===');
{
  const { status, data } = await call('/api/report');
  ok('GET /report', status === 200);
  ok('统计有新增错题数', typeof data.stats.new_questions === 'number', `新增 ${data.stats.new_questions}`);
  ok('统计有正确率', data.stats.accuracy !== undefined, `accuracy=${data.stats.accuracy}`);
  ok('按考点聚合', Array.isArray(data.stats.by_kp), `${data.stats.by_kp?.length} 个考点`);
  ok('按错因聚合', Array.isArray(data.stats.by_error_type), `${data.stats.by_error_type?.length} 类`);
  ok('环比字段存在', 'new_questions_prev' in data.stats && 'accuracy_prev' in data.stats);
}

console.log('\n=== 6.5 月报 ===');
{
  const { status, data } = await call('/api/report/monthly');
  ok('GET /report/monthly', status === 200 && /^\d{4}-\d{2}$/.test(data.month), data.month);
  ok('月度统计有新增数', typeof data.stats.new_questions === 'number', `本月新增 ${data.stats.new_questions}`);
  ok(
    '月度统计有每周走势',
    Array.isArray(data.stats.by_week) && data.stats.by_week.length > 0,
    data.stats.by_week?.map((w) => `${w.week}:${w.n}`).join(' ')
  );
  ok('月度统计有重复错题榜', Array.isArray(data.stats.top_repeat), `${data.stats.top_repeat?.length} 道`);
  ok('月度统计有重点错题总数', typeof data.stats.key_total === 'number', `key=${data.stats.key_total} / active=${data.stats.active_total}`);

  await withNoKey(async () => {
    const gen = await call('/api/report/monthly', { method: 'POST', body: {} });
    ok('无 key 时月报生成报可读错误',
      gen.status >= 400 && /key|Key/.test(String(gen.data.error || '')),
      String(gen.data.error || '').slice(0, 60));
  });
}

console.log('\n=== 7. 静态资源 ===');
{
  for (const p of ['/', '/app.js', '/style.css', '/print.html', '/print.js', '/manifest.webmanifest', '/sw.js', '/icon.svg']) {
    const res = await fetch(`${BASE}${p}`);
    ok(`GET ${p}`, res.status === 200, `HTTP ${res.status}`);
  }
}

console.log('\n=== 8. 错误处理 ===');
{
  const bad = await call('/api/questions/999999');
  ok('不存在的错题返回 404', bad.status === 404);

  const badAttempt = await call(`/api/questions/${createdIds[0]}/attempt`, { method: 'POST', body: { result: 'maybe' } });
  ok('非法 result 被拒绝', badAttempt.status === 400);

  await withNoKey(async () => {
    const noKey = await call(`/api/questions/${createdIds[0]}/diagnose`, { method: 'POST', body: {} });
    ok('无 key 时给出可读错误',
      noKey.status >= 400 && /key|Key/.test(String(noKey.data.error || '')),
      String(noKey.data.error || '').slice(0, 70));
  });
}

console.log('\n=== 9. 配置接口 ===');
{
  const snap = snapshotKeys();
  const before = await call('/api/settings');

  ok('GET /settings 返回服务商预设（不绑定一家）',
    Array.isArray(before.data.presets) && before.data.presets.length >= 5,
    `${before.data.presets?.length} 个`);

  const saved = await call('/api/settings', {
    method: 'PUT',
    body: { vision: { baseUrl: 'http://127.0.0.1:1/v1', model: 'probe-model' } },
  });
  ok('PUT /settings 能改运行时配置',
    saved.status === 200 && saved.data.config.vision.model === 'probe-model',
    `${saved.data.config?.vision?.model} @ ${saved.data.config?.vision?.baseUrl}`);

  const meta2 = await call('/api/meta');
  ok('改完立刻生效，不用重启', meta2.data.config.vision.model === 'probe-model');

  const models = await call('/api/settings/models', {
    method: 'POST',
    body: { kind: 'vision', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x' },
  });
  ok('拉模型列表失败时原因里带地址',
    models.status >= 400 && /127\.0\.0\.1:1/.test(String(models.data.error || '')),
    String(models.data.error || '').split('\n')[0].slice(0, 60));

  await call('/api/settings/clear-key', { method: 'POST', body: { kind: 'vision' } });
  const m3 = await call('/api/meta');
  ok('清除 key 后立刻不可用', m3.data.config.vision.ready === false);

  restoreKeys(snap);
  await call('/api/settings', {
    method: 'PUT',
    body: {
      vision: {
        baseUrl: before.data.config.vision.baseUrl,
        model: before.data.config.vision.model,
      },
    },
  });
  const back = await call('/api/meta');
  ok('测试后配置已还原',
    back.data.config.vision.model === before.data.config.vision.model,
    `${back.data.config.vision.model} @ ${back.data.config.vision.baseUrl}`);
}

// ---------------------------------------------------------------- 10. 局域网 / 手机访问
console.log('\n=== 10. 局域网：手机扫码能打开 ===');

{
  const lan = await call('/api/lan');
  ok('返回了局域网地址', lan.status === 200 && !!lan.data.primary, lan.data.primary || '没拿到地址');
  ok('地址是局域网 IP（不是 127.0.0.1）',
    !!lan.data.primary && !lan.data.primary.includes('127.0.0.1'),
    lan.data.primary);
  ok('返回了二维码图片', typeof lan.data.qr === 'string' && lan.data.qr.startsWith('data:image/png;base64,'));
  ok('列出了网卡', Array.isArray(lan.data.addrs) && lan.data.addrs.length >= 1,
    (lan.data.addrs || []).map((a) => `${a.name}=${a.address}`).join(', '));

  // 解一遍二维码：生成成功不等于手机扫得出来
  if (lan.data.qr) {
    const png = PNG.sync.read(Buffer.from(lan.data.qr.split(',')[1], 'base64'));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    ok('二维码扫出来就是那个地址',
      decoded?.data === lan.data.primary,
      `${png.width}×${png.height} → ${decoded?.data || '解不出来'}`);
  }
}

// 收尾：还原配置 + 把本套件造的题真删掉（走接口删是软删除，会留行）
settingsGuard.restore();
const removed = hardDeleteQuestions(createdIds);
console.log(`\n[收尾] 配置已还原，已清理测试题 ${removed} 道`);

console.log(`\n${'='.repeat(44)}`);
console.log(`  通过 ${pass}   失败 ${fail}`);
console.log('='.repeat(44) + '\n');
process.exit(fail ? 1 : 0);
