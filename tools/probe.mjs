// 服务商连通性探针：判断"是服务挂了、key 错了，还是没钱了"。
//
//   npm run probe                  # 用当前配置的识题模型测
//   npm run probe -- --kind=text   # 测写文模型
//   npm run probe -- --base=https://sta1n.ai/v1 --model=deepseek-v4.1-flash --key=sk-xxx
//
// 只打印状态与结论，**绝不打印完整 key**（只显示前 5 位 + 后 4 位）。
// 三步走：列模型（验证网络+鉴权）→ 一次最小对话（验证额度+模型名）→ 读账单（new-api 系才有）。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith('--' + k + '='));
  return a ? a.slice(k.length + 3) : d;
};
const kind = arg('kind', 'vision') === 'text' ? 'text' : 'vision';
const mask = (k) => (k ? k.slice(0, 5) + '…' + k.slice(-4) + '（长度 ' + k.length + '）' : '（空）');

function fromDb() {
  const db = new DatabaseSync(path.join(ROOT, 'data', 'study.db'), { readOnly: true });
  const get = (k) => String(db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value || '');
  const out = {
    base: get(kind + '_base_url'), model: get(kind + '_model'), key: get(kind + '_api_key'),
  };
  if (kind === 'text' && (!out.base || !out.key)) {   // 写文留空 = 继承识题
    out.base = out.base || get('vision_base_url');
    out.key = out.key || get('vision_api_key');
    out.model = out.model || get('vision_model');
    out.inherited = true;
  }
  db.close();
  return out;
}

const db = process.env.PROBE_NO_DB ? {} : fromDb();
const base = (arg('base', '') || db.base || 'https://api.deepseek.com').replace(/\/$/, '');
const model = arg('model', '') || db.model || 'deepseek-flash';
const key = arg('key', '') || db.key || '';

console.log('');
console.log('  目标   ' + base);
console.log('  模型   ' + model + (db.inherited ? '（继承识题配置）' : ''));
console.log('  Key    ' + mask(key));
console.log('');

const json = async (res) => { try { return await res.json(); } catch { return null; } };
const brief = (o) => JSON.stringify(o).replace(/\s+/g, ' ').slice(0, 180);

// 1) 列模型：验证网络 + 鉴权
let modelsOk = false, modelCount = null;
try {
  const t0 = Date.now();
  const r = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key } });
  const j = await json(r);
  modelCount = Array.isArray(j?.data) ? j.data.length : null;
  modelsOk = r.ok;
  console.log('  1. 列模型   HTTP ' + r.status + ' · ' + (Date.now() - t0) + 'ms · ' + (modelCount ?? '—') + ' 个');
  if (!r.ok) console.log('     ' + brief(j));
  if (modelCount) {
    const has = (j.data || []).some((m) => m.id === model);
    console.log('     ' + (has ? '含目标模型 ' + model : '⚠ 列表里没有 ' + model));
    if (!has) console.log('     相近的：' + (j.data || []).map((m) => m.id).filter((x) => x.toLowerCase().includes(String(model).split('-')[0].toLowerCase())).slice(0, 6).join(', '));
  }
} catch (e) {
  console.log('  1. 列模型   网络错误：' + (e.cause?.code || e.message));
}

// 2) 最小对话：验证额度 + 模型可用
let chatVerdict = '未测';
try {
  const t0 = Date.now();
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: '回复两个字：可用' }], max_tokens: 16 }),
  });
  const j = await json(r);
  const ms = Date.now() - t0;
  console.log('  2. 最小对话 HTTP ' + r.status + ' · ' + ms + 'ms');
  if (r.ok) {
    chatVerdict = '可用';
    console.log('     回复：' + JSON.stringify(j?.choices?.[0]?.message?.content ?? '').slice(0, 60) + ' · 用量 ' + (j?.usage?.total_tokens ?? '?') + ' tokens');
  } else {
    const msg = j?.error?.message || brief(j);
    console.log('     ' + msg);
    chatVerdict = r.status === 402 ? '余额不足（402）'
      : r.status === 401 ? 'key 无效（401）'
      : r.status === 429 ? '限流/超额（429）'
      : r.status === 404 ? '模型名或路径不对（404）'
      : '失败 HTTP ' + r.status;
  }
} catch (e) {
  console.log('  2. 最小对话 网络错误：' + (e.cause?.code || e.message));
}

// 3) 账单（new-api / one-api 系）
try {
  const r = await fetch(base + '/dashboard/billing/subscription', { headers: { Authorization: 'Bearer ' + key } });
  if (r.ok) {
    const j = await json(r);
    console.log('  3. 账单     HTTP 200 · 额度上限 ' + (j?.hard_limit_usd ?? '?') + ' USD（这是网关展示值，不代表可用余额）');
  } else {
    console.log('  3. 账单     该服务商没有这个接口（' + r.status + '），跳过');
  }
} catch { /* 没有就没有 */ }

console.log('');
console.log('  结论：' + (chatVerdict === '可用'
  ? '服务正常，可以用于本项目'
  : '服务' + (modelsOk ? '在线（能列模型，说明网络与 key 都没问题）' : '连不上或鉴权失败') + '，但对话' + chatVerdict));
console.log('');
process.exit(chatVerdict === '可用' ? 0 : 1);
