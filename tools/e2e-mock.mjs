// 端到端演练：用本地 mock 模型把「上传 → 识题 → 入库 → 深挖错因 → 变式 → 复习单 → 周报 → 月报」
// 整条链路跑一遍。不花钱，用来验证路由、字段、排版是否串得通。
//
// 前置：1) npm start   2) node tools/mock-ai.mjs
// 用法：node tools/e2e-mock.mjs [--clean]
// 注意：它会把配置改成 mock，跑完自动还原（含 apiKey）；--clean 表示跑完删掉演练数据。

import { guardSettings, hardDeleteQuestions } from './settings-guard.mjs';

const APP = process.env.APP || 'http://127.0.0.1:7788';
const MOCK = process.env.MOCK || 'http://127.0.0.1:7799/v1';

const args = process.argv.slice(2);
const CLEAN = args.includes('--clean');

const results = [];
const check = (name, ok, extra = '') => results.push({ name, ok: Boolean(ok), extra });

const json = (r) => r.json();
async function api(path, init) {
  const res = await fetch(`${APP}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${data.error || ''}`);
  return data;
}
const post = (path, body) =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

// 1x1 透明 PNG，仅用于走通上传路径
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// ---------------------------------------------------------------- 0. 指向 mock
console.log('\n[0] 把配置指向本地 mock 服务…');
// 一定会改库里的配置（包括把 key 改成 mock），所以先整表快照，
// 跑完原样还原。以前只还原 baseUrl/model，会把真实 key 永久覆盖掉。
const settingsGuard = guardSettings();
const before = await api('/api/settings');
await api('/api/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    vision: { baseUrl: MOCK, model: 'mock-vl-1', apiKey: 'mock' },
    text: { baseUrl: MOCK, model: 'mock-text-1', apiKey: 'mock' },
  }),
});
const cfg = await api('/api/meta');
check('识题模型已指向 mock', cfg.config.vision.ready && cfg.config.vision.baseUrl === MOCK,
  `${cfg.config.vision.model} @ ${cfg.config.vision.baseUrl}`);

// 再用 /models 验证一次"获取模型列表"真的能用
const models = await post('/api/settings/models', { kind: 'vision' });
check('获取模型列表可用', Array.isArray(models.models) && models.models.length > 0,
  models.models.join(', '));

// ---------------------------------------------------------------- 1. 上传
const meta = await api('/api/meta');
const mathId = (meta.subjects.find((s) => s.name === '数学') || meta.subjects[0]).id;

const fd = new FormData();
fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'mock-page.png');
fd.append('subject_id', String(mathId));
fd.append('note', 'e2e 演练用');
const page = await api('/api/pages', { method: 'POST', body: fd });
check('上传一页错题本', Number.isFinite(page.id), `page#${page.id}`);

// ---------------------------------------------------------------- 2. 识题
const ex = await post(`/api/pages/${page.id}/extract`);
const drafts = ex.drafts || [];
check('识题返回草稿', drafts.length > 0, `${drafts.length} 道`);
check('题干里保留了 LaTeX 公式',
  drafts.some((d) => /\$/.test(d.stem || '')),
  drafts[0] ? drafts[0].stem.slice(0, 40) : '');
check('考点已匹配到考点库',
  drafts.some((d) => d.kp_name),
  drafts.map((d) => d.kp_name || '未匹配').join(' / '));
check('低置信度的题被标出来（而不是假装准确）',
  drafts.some((d) => typeof d.confidence === 'number' && d.confidence < 0.8),
  drafts.map((d) => d.confidence ?? '—').join(' / '));

// ---------------------------------------------------------------- 3. 入库
const bulk = await post('/api/questions/bulk', { questions: drafts });
const ids = bulk.ids || [];
check('草稿批量入库', ids.length === drafts.length, `${ids.length} 道入库`);

const qid = ids[0];
const detail = await api(`/api/questions/${qid}`);
check('入库后被标记为「头次错」',
  detail.question.status === 'first',
  `status=${detail.question.status}`);
check('入库后自动排到下一次复习',
  Boolean(detail.question.next_review_at),
  `next_review_at=${String(detail.question.next_review_at).slice(0, 10)}`);

// ---------------------------------------------------------------- 4. 深挖错因
const dg = await post(`/api/questions/${qid}/diagnose`);
const diag = dg.diagnose || {};
check('深挖错因返回结构化结果',
  Boolean(diag.root_cause || diag.summary_md),
  (diag.root_cause || diag.summary_md || '').slice(0, 46));

// ---------------------------------------------------------------- 5. 变式题
const vr = await post(`/api/questions/${qid}/variants`, {
  kinds: ['same', 'trap', 'layered', 'cross'],
});
const variants = vr.variants || vr.created || [];
check('生成变式题', variants.length > 0, `${variants.length} 道：${[...new Set(variants.map((v) => v.kind))].join('/')}`);

// ---------------------------------------------------------------- 6. 复习单
const sheet = await post('/api/sheet', { perDay: 4 });
check('生成本周复习单', Number.isFinite(sheet.sheetId), `sheet#${sheet.sheetId} 共 ${sheet.total} 题`);
const sheetGet = await api('/api/sheet');
check('复习单能读回来', Array.isArray(sheetGet.items), `${sheetGet.items?.length ?? 0} 条`);

// ---------------------------------------------------------------- 7. 周报
const wk = await post('/api/report', { week: meta.week });
check('生成周报', Boolean(wk.report?.body_md),
  (wk.report?.body_md || '').replace(/\s+/g, ' ').slice(0, 46));

// ---------------------------------------------------------------- 8. 月报
const mo = await post('/api/report/monthly', {});
check('生成月报', Boolean(mo.report?.body_md),
  (mo.report?.body_md || '').replace(/\s+/g, ' ').slice(0, 46));

// ---------------------------------------------------------------- 收尾
// 配置一律还原（含 apiKey）。--restore-settings 保留只是为了兼容旧用法，
// 现在默认就会还原，不加也是安全的。
await (async () => {
  settingsGuard.restore();
  const after = await api('/api/settings');
  const same =
    after.config.vision.model === before.config.vision.model &&
    after.config.vision.baseUrl === before.config.vision.baseUrl;
  check('跑完把配置还原了（真实 key 没被 mock 覆盖）', same,
    `${after.config.vision.model} @ ${after.config.vision.baseUrl}`);
  if (!same) console.log('  [警告] 配置没还原成功，请到「设置」页检查 API Key');
})();

if (CLEAN) {
  // 走接口删是软删除，会永久留行；这里再真删一遍
  for (const id of ids) await api(`/api/questions/${id}`, { method: 'DELETE' });
  hardDeleteQuestions(ids);
  await api(`/api/pages/${page.id}`, { method: 'DELETE' });
  console.log('[收尾] 演练数据已删除');
} else {
  console.log('\n[收尾] 保留演练数据（加 --clean 可删除）');
}

// ---------------------------------------------------------------- 结果
console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.extra ? ` — ${r.extra}` : ''}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${'='.repeat(46)}`);
console.log(`  端到端：通过 ${results.length - failed}   失败 ${failed}`);
console.log('='.repeat(46) + '\n');
process.exit(failed ? 1 : 0);
