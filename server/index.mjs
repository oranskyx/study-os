// HTTP 服务：静态页面 + JSON API
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { mkdirSync, unlinkSync } from 'node:fs';
import crypto from 'node:crypto';

import {
  db, all, get, run, insert, update, nowISO,
  DATA_DIR, UPLOAD_DIR,
} from './db.mjs';
import { chat, imageToDataUrl, parseLooseJson } from './ai.mjs';
import {
  configStatus, applySettings, clearKey, listModels,
  PROVIDER_PRESETS,
} from './settings.mjs';
import {
  extractMessages, diagnoseMessages, variantMessages, weeklyMessages, monthlyMessages, solutionMessages,
} from './prompts.mjs';
import { examsRouter } from './exams.mjs';
import {
  isoWeek, isoDate, weekRange, weeklyStats, weekDigest,
  buildSheet, sheetDetail, fillSheet, recordAttempt,
  applyStatusRules, refreshSchedules, defaultSheetWeek, CONFIG,
  currentMonth, monthStats, monthDigest, monthRange,
} from './logic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.HOST || '0.0.0.0';

mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '8mb' }));

// ---------------------------------------------------------------- 上传
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().slice(0, 5);
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype);
    cb(ok ? null : new Error('只接受 JPEG / PNG / WebP / GIF 图片'), ok);
  },
});

// ---------------------------------------------------------------- 小工具
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function kpList(subjectId = 'math') {
  return all('SELECT id, chapter, name FROM kps WHERE subject_id=? ORDER BY id', subjectId);
}

function resolveKp(subjectId, rawName) {
  if (!rawName) return { kp_id: null, kp_name: null };
  const name = String(rawName).trim();
  if (!name) return { kp_id: null, kp_name: null };
  const exact = get('SELECT id, name FROM kps WHERE subject_id=? AND name=?', subjectId, name);
  if (exact) return { kp_id: exact.id, kp_name: exact.name };
  const kps = kpList(subjectId);
  const hit = kps.find((k) => k.name.includes(name) || name.includes(k.name));
  if (hit) return { kp_id: hit.id, kp_name: hit.name };
  return { kp_id: null, kp_name: name }; // 保留原词，学生可后续补建
}

const S = (v) => (v === undefined || v === null ? null : String(v).trim() || null);

// ---------------------------------------------------------------- meta
app.get('/api/meta', wrap(async (_req, res) => {
  const counts = get(
    `SELECT
       SUM(CASE WHEN status='first'    AND deleted_at IS NULL THEN 1 ELSE 0 END) AS first_n,
       SUM(CASE WHEN status='key'      AND deleted_at IS NULL THEN 1 ELSE 0 END) AS key_n,
       SUM(CASE WHEN status='archived' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS archived_n,
       COUNT(*) AS total
     FROM questions WHERE deleted_at IS NULL`
  ) || {};

  const today = new Date();
  const w = isoWeek(today);
  const sw = defaultSheetWeek(today);
  const { start, end } = weekRange(w);
  const swRange = weekRange(sw);

  res.json({
    today: isoDate(today),
    week: w,
    weekRange: { start: isoDate(start), end: isoDate(end) },
    sheetWeek: sw,
    sheetWeekRange: { start: isoDate(swRange.start), end: isoDate(swRange.end) },
    subjects: all('SELECT * FROM subjects ORDER BY sort'),
    // 全部科目的考点（带 subject_id）。以前只给数学，导致选标注时只有数学章节。
    kps: all('SELECT id, subject_id, chapter, name FROM kps ORDER BY subject_id, id'),
    config: configStatus(),
    rules: CONFIG,
    counts: {
      first: Number(counts.first_n || 0),
      key: Number(counts.key_n || 0),
      archived: Number(counts.archived_n || 0),
      total: Number(counts.total || 0),
    },
    dueNow: Number(
      get(
        `SELECT COUNT(*) AS v FROM questions
          WHERE status!='archived' AND deleted_at IS NULL AND next_review_at <= ?`,
        nowISO()
      )?.v || 0
    ),
    // 逾期但一次都没复习过：这类题最容易被系统"假装处理掉了"
    staleNever: Number(
      get(
        `SELECT COUNT(*) AS v FROM questions
          WHERE status!='archived' AND deleted_at IS NULL
            AND review_count=0 AND next_review_at <= ?`,
        nowISO()
      )?.v || 0
    ),
  });
}));

// ---------------------------------------------------------------- 页面/拍照
app.get('/api/pages', wrap(async (_req, res) => {
  res.json(all(
    `SELECT * FROM pages ORDER BY id DESC LIMIT 60`
  ));
}));

app.post('/api/pages', upload.single('photo'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到图片' });
  const id = insert('pages', {
    subject_id: S(req.body.subject_id) || 'math',
    image_path: path.basename(req.file.path),
    bytes: req.file.size,
    uploaded_at: nowISO(),
    status: 'pending',
    note: S(req.body.note),
  });
  res.json({ id, page: get('SELECT * FROM pages WHERE id=?', id) });
}));

app.delete('/api/pages/:id', wrap(async (req, res) => {
  const p = get('SELECT * FROM pages WHERE id=?', Number(req.params.id));
  if (!p) return res.status(404).json({ error: '页面不存在' });
  try { unlinkSync(path.join(UPLOAD_DIR, p.image_path)); } catch { /* 文件可能已删 */ }
  run('DELETE FROM pages WHERE id=?', p.id);
  res.json({ ok: true });
}));

/** 识题：把一页照片转成待确认的题目草稿 */
app.post('/api/pages/:id/extract', wrap(async (req, res) => {
  const page = get('SELECT * FROM pages WHERE id=?', Number(req.params.id));
  if (!page) return res.status(404).json({ error: '页面不存在' });

  run("UPDATE pages SET status='running', error=NULL WHERE id=?", page.id);
  try {
    const dataUrl = await imageToDataUrl(path.join(UPLOAD_DIR, page.image_path));
    const out = await chat({
      kind: 'vision',
      messages: extractMessages({
        imageDataUrl: dataUrl,
        subjectId: page.subject_id,
        kpList: kpList(page.subject_id),
        extraNote: page.note || '',
      }),
      json: true,
      maxTokens: 8000,
      thinking: process.env.VISION_THINKING === 'on',
    });

    const parsed = parseLooseJson(out.content, 'object');
    const drafts = (parsed.questions || []).map((q) => {
      const kps = Array.isArray(q.kp) ? q.kp : q.kp ? [q.kp] : [];
      const resolved = resolveKp(page.subject_id, kps[0]);
      return {
        subject_id: page.subject_id,
        page_id: page.id,
        stem: S(q.stem) || '（识别失败，请手动填写）',
        my_answer: S(q.my_answer),
        correct_answer: S(q.correct_answer),
        solution: S(q.solution),
        error_cause: S(q.error_cause),
        error_type: S(q.error_type),
        difficulty: Number(q.difficulty) || 3,
        kp_id: resolved.kp_id,
        kp_name: resolved.kp_name,
        kp_alt: kps.slice(1),
        confidence: typeof q.confidence === 'number' ? q.confidence : null,
      };
    });

    run(
      "UPDATE pages SET status='done', raw_json=?, note=? WHERE id=?",
      JSON.stringify(parsed), parsed.page_note || page.note, page.id
    );
    res.json({ page: get('SELECT * FROM pages WHERE id=?', page.id), drafts, usage: out.usage });
  } catch (e) {
    run("UPDATE pages SET status='failed', error=? WHERE id=?", String(e.message).slice(0, 800), page.id);
    throw e;
  }
}));

// ---------------------------------------------------------------- 错题
app.get('/api/questions', wrap(async (req, res) => {
  const { status, kp, q, subject, stale, limit = 200 } = req.query;
  const where = ['deleted_at IS NULL'];
  const p = [];
  if (status && status !== 'all') { where.push('status=?'); p.push(status); }
  if (subject && subject !== 'all') { where.push('subject_id=?'); p.push(subject); }
  if (kp) { where.push('kp_name LIKE ?'); p.push(`%${kp}%`); }
  if (q) { where.push('(stem LIKE ? OR error_cause LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  if (stale === '1') {
    where.push("review_count=0 AND next_review_at <= ?");
    p.push(nowISO());
  }
  p.push(Math.min(500, Number(limit) || 200));
  res.json(all(
    `SELECT * FROM questions WHERE ${where.join(' AND ')}
      ORDER BY CASE status WHEN 'key' THEN 0 WHEN 'first' THEN 1 ELSE 2 END,
               COALESCE(next_review_at,'9999') ASC, id DESC
      LIMIT ?`, ...p
  ));
}));

/** 按考点聚合：一眼看到哪几个考点堆了最多题 */
app.get('/api/questions/group', wrap(async (req, res) => {
  const by = S(req.query.by) || 'kp';
  const subject = S(req.query.subject);
  const where = ['deleted_at IS NULL', "status!='archived'"];
  const p = [];
  if (subject && subject !== 'all') { where.push('subject_id=?'); p.push(subject); }
  const cols = by === 'subject'
    ? { key: 'subject_id', label: 'subject_id' }
    : by === 'type'
      ? { key: "COALESCE(error_type,'未分类')", label: "COALESCE(error_type,'未分类')" }
      : { key: "COALESCE(kp_name,'未标注')", label: "COALESCE(kp_name,'未标注')" };
  res.json(all(
    `SELECT ${cols.label} AS grp, COUNT(*) AS n,
            SUM(CASE WHEN status='key' THEN 1 ELSE 0 END) AS key_n,
            SUM(error_count) AS errors,
            MAX(last_error_at) AS last_at
       FROM questions WHERE ${where.join(' AND ')}
      GROUP BY grp ORDER BY n DESC, errors DESC`,
    ...p
  ));
}));

app.get('/api/questions/:id', wrap(async (req, res) => {
  const q = get('SELECT * FROM questions WHERE id=? AND deleted_at IS NULL', Number(req.params.id));
  if (!q) return res.status(404).json({ error: '错题不存在' });
  const page = q.page_id ? get('SELECT * FROM pages WHERE id=?', q.page_id) : null;
  res.json({
    question: q,
    page,
    attempts: all('SELECT * FROM attempts WHERE question_id=? ORDER BY at DESC', q.id),
    variants: all('SELECT * FROM variants WHERE question_id=? ORDER BY id', q.id),
  });
}));

/** 归档题重新激活：只有手动点才算，自动归档仍然是单向的 */
app.post('/api/questions/:id/reactivate', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const q = get('SELECT * FROM questions WHERE id=? AND deleted_at IS NULL', id);
  if (!q) return res.status(404).json({ error: '错题不存在' });
  run(
    `UPDATE questions SET status='first', archived_at=NULL, archive_reason=NULL,
            correct_streak=0, next_review_at=?, updated_at=? WHERE id=?`,
    nowISO(), nowISO(), id
  );
  res.json({ ok: true, question: get('SELECT * FROM questions WHERE id=?', id) });
}));

app.post('/api/questions/bulk', wrap(async (req, res) => {
  const list = Array.isArray(req.body?.questions) ? req.body.questions : [];
  if (!list.length) return res.status(400).json({ error: '没有要入库的题目' });
  const now = nowISO();
  const ids = [];
  for (const d of list) {
    if (!S(d.stem)) continue;
    const resolved = d.kp_name
      ? resolveKp(d.subject_id || 'math', d.kp_name)
      : { kp_id: d.kp_id ?? null, kp_name: null };
    const id = insert('questions', {
      subject_id: d.subject_id || 'math',
      page_id: d.page_id ?? null,
      kp_id: resolved.kp_id,
      kp_name: resolved.kp_name,
      stem: S(d.stem),
      my_answer: S(d.my_answer),
      correct_answer: S(d.correct_answer),
      solution: S(d.solution),
      error_cause: S(d.error_cause),
      error_type: S(d.error_type),
      difficulty: Number(d.difficulty) || 3,
      status: 'first',
      error_count: 1,
      correct_streak: 0,
      review_count: 0,
      variant_mode: d.variant_mode === 'textbook' ? 'textbook' : 'ai',
      first_error_at: d.first_error_at || now,
      last_error_at: d.first_error_at || now,
      created_at: now,
      updated_at: now,
      notes: S(d.notes),
    });
    run('UPDATE questions SET next_review_at=? WHERE id=?',
      new Date(Date.now() + 86400000).toISOString(), id);
    ids.push(id);
  }
  applyStatusRules();
  res.json({ created: ids.length, ids });
}));

const EDITABLE = [
  'stem', 'my_answer', 'correct_answer', 'solution', 'error_cause', 'error_cause_ai',
  'error_type', 'difficulty', 'kp_id', 'kp_name', 'variant_mode', 'notes', 'subject_id',
  'status', 'error_count', 'correct_streak', 'review_count', 'last_error_at', 'first_error_at',
];

app.patch('/api/questions/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const q = get('SELECT * FROM questions WHERE id=? AND deleted_at IS NULL', id);
  if (!q) return res.status(404).json({ error: '错题不存在' });
  const patch = { updated_at: nowISO() };
  for (const k of EDITABLE) {
    if (k in req.body) patch[k] = req.body[k];
  }
  if ('kp_name' in patch && patch.kp_name) {
    const r = resolveKp(q.subject_id, patch.kp_name);
    patch.kp_id = r.kp_id;
    patch.kp_name = r.kp_name;
  }
  update('questions', id, patch);
  applyStatusRules();
  refreshSchedules();
  res.json({ question: get('SELECT * FROM questions WHERE id=?', id) });
}));

app.delete('/api/questions/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  run('UPDATE questions SET deleted_at=?, updated_at=? WHERE id=?', nowISO(), nowISO(), id);
  res.json({ ok: true });
}));

app.post('/api/questions/:id/attempt', wrap(async (req, res) => {
  const result = req.body?.result;
  if (result !== 'correct' && result !== 'wrong') {
    return res.status(400).json({ error: 'result 只能是 correct 或 wrong' });
  }
  const q = recordAttempt(Number(req.params.id), result, req.body?.via || 'app');
  applyStatusRules();
  refreshSchedules();
  res.json({ question: get('SELECT * FROM questions WHERE id=?', q.id) });
}));

/** 深度归因：AI 补全错因链 */
// 按需生成解析：识题阶段不生成，学生点了按钮才花钱
app.post('/api/questions/:id/solution', wrap(async (req, res) => {
  const q = get('SELECT * FROM questions WHERE id=? AND deleted_at IS NULL', Number(req.params.id));
  if (!q) return res.status(404).json({ error: '错题不存在' });
  const out = await chat({
    kind: 'text',
    messages: solutionMessages({ question: q }),
    maxTokens: 4000,
    effort: 'high',
  });
  const solution = String(out.content || '').trim();
  if (!solution) throw new Error('模型没有返回解析，重试一次或换更强的模型');
  update('questions', q.id, { solution, updated_at: nowISO() });
  res.json({ question: get('SELECT * FROM questions WHERE id=?', q.id), usage: out.usage });
}));

app.post('/api/questions/:id/diagnose', wrap(async (req, res) => {
  const q = get('SELECT * FROM questions WHERE id=? AND deleted_at IS NULL', Number(req.params.id));
  if (!q) return res.status(404).json({ error: '错题不存在' });
  const out = await chat({
    kind: 'text',
    messages: diagnoseMessages({ question: q }),
    json: true,
    maxTokens: 3000,
  });
  const d = parseLooseJson(out.content, 'object');
  const patch = {
    error_cause_ai: [
      d.root_cause ? `根因：${d.root_cause}` : '',
      Array.isArray(d.chain) && d.chain.length ? `错在哪：\n${d.chain.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
      d.trap ? `陷阱：${d.trap}` : '',
      d.fix ? `纠正：${d.fix}` : '',
    ].filter(Boolean).join('\n\n'),
    updated_at: nowISO(),
  };
  if (d.error_type && !q.error_type) patch.error_type = d.error_type;
  update('questions', q.id, patch);
  res.json({ question: get('SELECT * FROM questions WHERE id=?', q.id), diagnose: d });
}));

// ---------------------------------------------------------------- 变式
app.post('/api/questions/:id/variants', wrap(async (req, res) => {
  const q = get('SELECT * FROM questions WHERE id=? AND deleted_at IS NULL', Number(req.params.id));
  if (!q) return res.status(404).json({ error: '错题不存在' });

  const kinds = Array.isArray(req.body?.kinds) && req.body.kinds.length
    ? req.body.kinds.filter((k) => ['same', 'trap', 'layered', 'cross'].includes(k))
    : ['same', 'trap', 'layered'];

  const kpNames = [q.kp_name].filter(Boolean);
  const out = await chat({
    kind: 'text',
    messages: variantMessages({ question: q, kpNames, kinds }),
    json: true,
    maxTokens: 6000,
  });
  const parsed = parseLooseJson(out.content, 'object');
  const created = [];
  for (const v of parsed.variants || []) {
    if (!S(v.stem)) continue;
    const id = insert('variants', {
      question_id: q.id,
      kind: S(v.kind) || 'same',
      tier: S(v.tier),
      stem: S(v.stem),
      answer: S(v.answer),
      solution: S(v.solution),
      source: 'ai',
      ref: S(v.why),
      created_at: nowISO(),
    });
    created.push(get('SELECT * FROM variants WHERE id=?', id));
  }
  res.json({ created, usage: out.usage });
}));

/** 手工挂教辅题：大模块让学生去教辅找，这里只登记 */
app.post('/api/questions/:id/variants/manual', wrap(async (req, res) => {
  const q = get('SELECT * FROM questions WHERE id=? AND deleted_at IS NULL', Number(req.params.id));
  if (!q) return res.status(404).json({ error: '错题不存在' });
  const id = insert('variants', {
    question_id: q.id,
    kind: S(req.body?.kind) || 'same',
    tier: S(req.body?.tier),
    stem: S(req.body?.stem) || '（教辅题，待补题面）',
    answer: S(req.body?.answer),
    solution: S(req.body?.solution),
    source: 'textbook',
    ref: S(req.body?.ref),
    created_at: nowISO(),
  });
  res.json({ variant: get('SELECT * FROM variants WHERE id=?', id) });
}));

app.patch('/api/variants/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const v = get('SELECT * FROM variants WHERE id=?', id);
  if (!v) return res.status(404).json({ error: '变式题不存在' });
  const patch = {};
  for (const k of ['stem', 'answer', 'solution', 'verdict', 'ref', 'tier']) {
    if (k in req.body) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length) update('variants', id, patch);
  res.json({ variant: get('SELECT * FROM variants WHERE id=?', id) });
}));

// ---------------------------------------------------------------- 复习单
app.get('/api/sheet', wrap(async (req, res) => {
  const week = S(req.query.week) || defaultSheetWeek();
  const sheet = get('SELECT * FROM sheets WHERE week=?', week);
  if (!sheet) return res.json({ week, sheet: null, items: [] });
  res.json({ week, ...sheetDetail(sheet.id) });
}));

app.post('/api/sheet', wrap(async (req, res) => {
  const week = S(req.body?.week) || defaultSheetWeek();
  const result = buildSheet(week, {
    perDay: Number(req.body?.perDay) || CONFIG.SHEET_PER_DAY,
    force: Boolean(req.body?.force),
  });
  res.json(result);
}));

/** 打印页按 id 取具体某张单 */
app.get('/api/sheet/:id', wrap(async (req, res) => {
  const d = sheetDetail(Number(req.params.id));
  if (!d) return res.status(404).json({ error: '复习单不存在' });
  res.json(d);
}));

app.post('/api/sheet/:id/fill', wrap(async (req, res) => {
  const body = req.body || {};
  const results = { ...(body.results || {}) };
  // 批量：给一个默认值，没单独勾的题全按它算（复习单 20 题点 40 次的优化）
  if (['correct', 'wrong', 'missed'].includes(body.default)) {
    const d = sheetDetail(Number(req.params.id));
    for (const it of d?.items || []) {
      if (!(it.question_id in results)) results[it.question_id] = body.default;
    }
  }
  res.json(fillSheet(Number(req.params.id), results));
}));

app.delete('/api/sheet/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  run('DELETE FROM sheets WHERE id=?', id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- 周报
app.get('/api/report', wrap(async (req, res) => {
  const week = S(req.query.week) || isoWeek();
  res.json({
    week,
    stats: weeklyStats(week),
    report: get("SELECT * FROM reports WHERE kind='weekly' AND period=?", week) || null,
  });
}));

app.post('/api/report', wrap(async (req, res) => {
  const week = S(req.body?.week) || isoWeek();
  const stats = weeklyStats(week);
  const digest = weekDigest(week);
  const { start, end } = weekRange(week);

  const out = await chat({
    kind: 'text',
    messages: weeklyMessages({
      stats,
      digest,
      weekLabel: `${week}（${isoDate(start)} ~ ${isoDate(end)}）`,
    }),
    json: true,
    maxTokens: 5000,
  });
  const parsed = parseLooseJson(out.content, 'object');
  const body = String(parsed.summary_md || '').trim();
  if (!body) throw new Error('模型没有返回周报正文');

  run(
    `INSERT INTO reports (kind, period, body_md, data_json, created_at)
     VALUES ('weekly',?,?,?,?)
     ON CONFLICT(kind, period) DO UPDATE SET
       body_md=excluded.body_md, data_json=excluded.data_json, created_at=excluded.created_at`,
    week, body, JSON.stringify({ stats, extras: parsed }), nowISO()
  );

  // 方法论条目自动落库
  const methods = Array.isArray(parsed.method_updates) ? parsed.method_updates : [];
  for (const m of methods) {
    if (!S(m?.title) || !S(m?.body)) continue;
    const exists = get('SELECT id FROM methods WHERE title=?', S(m.title));
    if (exists) {
      run('UPDATE methods SET body=?, version=version+1, updated_at=? WHERE id=?',
        S(m.body), nowISO(), exists.id);
    } else {
      insert('methods', {
        subject_id: 'math',
        title: S(m.title),
        body: S(m.body),
        created_at: nowISO(),
        updated_at: nowISO(),
      });
    }
  }

  res.json({
    week,
    stats,
    report: get("SELECT * FROM reports WHERE kind='weekly' AND period=?", week),
    extras: parsed.extras,
    methodUpdates: methods.length,
    usage: out.usage,
  });
}));

// ---------------------------------------------------------------- 月报
app.get('/api/report/monthly', wrap(async (req, res) => {
  const month = S(req.query.month) || currentMonth();
  res.json({
    month,
    stats: monthStats(month),
    report: get("SELECT * FROM reports WHERE kind='monthly' AND period=?", month) || null,
  });
}));

app.post('/api/report/monthly', wrap(async (req, res) => {
  const month = S(req.body?.month) || currentMonth();
  const stats = monthStats(month);
  const digest = monthDigest(month);
  const { start, end } = monthRange(month);
  const lastDay = new Date(end.getTime() - 86400000);

  const out = await chat({
    kind: 'text',
    messages: monthlyMessages({
      stats,
      digest,
      monthLabel: `${month}（${isoDate(start)} ~ ${isoDate(lastDay)}）`,
    }),
    json: true,
    maxTokens: 6000,
  });
  const parsed = parseLooseJson(out.content, 'object');
  const body = String(parsed.summary_md || '').trim();
  if (!body) throw new Error('模型没有返回月报正文');

  run(
    `INSERT INTO reports (kind, period, body_md, data_json, created_at)
     VALUES ('monthly',?,?,?,?)
     ON CONFLICT(kind, period) DO UPDATE SET
       body_md=excluded.body_md, data_json=excluded.data_json, created_at=excluded.created_at`,
    month, body, JSON.stringify({ stats, extras: parsed }), nowISO()
  );

  const methods = Array.isArray(parsed.method_updates) ? parsed.method_updates : [];
  let upserted = 0;
  for (const m of methods) {
    if (!S(m?.title) || !S(m?.body)) continue;
    const exists = get('SELECT id FROM methods WHERE title=?', S(m.title));
    if (exists) {
      run('UPDATE methods SET body=?, version=version+1, updated_at=? WHERE id=?',
        S(m.body), nowISO(), exists.id);
    } else {
      insert('methods', {
        subject_id: 'math', title: S(m.title), body: S(m.body),
        created_at: nowISO(), updated_at: nowISO(),
      });
    }
    upserted++;
  }

  res.json({
    month,
    stats,
    report: get("SELECT * FROM reports WHERE kind='monthly' AND period=?", month),
    extras: parsed.extras,
    methodUpdates: upserted,
    usage: out.usage,
  });
}));

// ---------------------------------------------------------------- 导出（备份 / 换机）
app.get('/api/export', wrap(async (_req, res) => {
  const dump = {
    exported_at: nowISO(),
    version: 1,
    subjects: all('SELECT * FROM subjects ORDER BY sort'),
    kps: all('SELECT * FROM kps'),
    questions: all('SELECT * FROM questions WHERE deleted_at IS NULL ORDER BY id'),
    attempts: all('SELECT * FROM attempts ORDER BY id'),
    variants: all('SELECT * FROM variants ORDER BY id'),
    sheets: all('SELECT * FROM sheets ORDER BY id'),
    sheet_items: all('SELECT * FROM sheet_items ORDER BY id'),
    methods: all('SELECT * FROM methods ORDER BY id'),
    exams: all('SELECT * FROM exams WHERE deleted_at IS NULL ORDER BY id'),
    exam_items: all('SELECT * FROM exam_items ORDER BY id'),
  };
  res.setHeader('Content-Disposition', 'attachment; filename="study-os-export.json"');
  res.json(dump);
}));

// ---------------------------------------------------------------- 方法论
app.get('/api/methods', wrap(async (_req, res) => {  res.json(all("SELECT * FROM methods WHERE status='active' ORDER BY updated_at DESC"));
}));

app.post('/api/methods', wrap(async (req, res) => {
  const b = req.body || {};
  if (!S(b.title) || !S(b.body)) return res.status(400).json({ error: '标题和正文都要填' });
  const id = insert('methods', {
    subject_id: S(b.subject_id),
    kp_name: S(b.kp_name),
    title: S(b.title),
    body: S(b.body),
    version: 1,
    status: 'active',
    created_at: nowISO(),
    updated_at: nowISO(),
  });
  res.json({ id, method: get('SELECT * FROM methods WHERE id=?', id) });
}));

app.patch('/api/methods/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const m = get('SELECT * FROM methods WHERE id=?', id);
  if (!m) return res.status(404).json({ error: '条目不存在' });
  const patch = {};
  for (const k of ['title', 'body', 'status']) if (k in req.body) patch[k] = req.body[k];
  if (Object.keys(patch).length) {
    patch.updated_at = nowISO();
    patch.version = (m.version || 1) + 1;
    update('methods', id, patch);
  }
  res.json({ method: get('SELECT * FROM methods WHERE id=?', id) });
}));

// ---------------------------------------------------------------- 维护
app.post('/api/maintenance/run', wrap(async (_req, res) => {
  const r = applyStatusRules();
  const n = refreshSchedules();
  res.json({ ...r, rescheduled: n });
}));

app.get('/api/settings', wrap(async (_req, res) => {
  res.json({
    config: configStatus(),
    presets: PROVIDER_PRESETS,
    rules: CONFIG,
  });
}));

/** 保存界面里填的 Base URL / Key / 模型（优先级高于 .env） */
app.put('/api/settings', wrap(async (req, res) => {
  applySettings(req.body || {});
  res.json({ ok: true, config: configStatus() });
}));

/** 显式清除某一类的 key */
app.post('/api/settings/clear-key', wrap(async (req, res) => {
  const kind = req.body?.kind === 'vision' ? 'vision' : 'text';
  clearKey(kind);
  res.json({ ok: true, config: configStatus() });
}));

/** 从服务商拉取可用模型列表（OpenAI 兼容的 /models） */
app.post('/api/settings/models', wrap(async (req, res) => {
  const kind = req.body?.kind === 'vision' ? 'vision' : 'text';
  const out = await listModels({
    kind,
    baseUrl: req.body?.baseUrl,
    apiKey: req.body?.apiKey,
  });
  res.json(out);
}));

app.post('/api/ai/test', wrap(async (req, res) => {
  const kind = req.body?.kind === 'vision' ? 'vision' : 'text';
  try {
    const out = await chat({
      kind,
      messages: [{ role: 'user', content: kind === 'vision' ? '回复两个字：可用' : '回复两个字：可用' }],
      maxTokens: 20,
      timeoutMs: 45_000,
    });
    res.json({ ok: true, model: out.model, text: out.content.slice(0, 100), usage: out.usage });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message).slice(0, 500), code: e.code });
  }
}));

// ---------------------------------------------------------------- 静态
// KaTeX 本地提供：国内访问 jsdelivr 常被墙，CDN 一挂公式就全退化成原始 $...$
app.use(
  '/vendor/katex',
  express.static(path.join(ROOT, 'node_modules', 'katex', 'dist'), { maxAge: '7d' })
);
// 试卷分析：独立路由，避免 index.mjs 继续膨胀
app.use('/api/exams', examsRouter());

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use('/', express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.use((err, _req, res, _next) => {
  console.error('[error]', err?.message || err);
  res.status(err?.status || 500).json({
    error: String(err?.message || err).slice(0, 800),
    ...(err?.code ? { code: err.code } : {}),
  });
});

// ---------------------------------------------------------------- 局域网
/** 本机所有非回环 IPv4，家用网段排前面 */
function lanAddrs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  const rank = (ip) =>
    /^192\.168\./.test(ip) ? 0
      : /^10\./.test(ip) ? 1
        : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2
          : 3;
  return out.sort((a, b) => rank(a.address) - rank(b.address));
}

app.get('/api/lan', wrap(async (_req, res) => {
  const addrs = lanAddrs();
  const primary = addrs[0] ? `http://${addrs[0].address}:${PORT}` : null;
  let qr = null;
  if (primary) {
    try {
      qr = await QRCode.toDataURL(primary, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
    } catch { /* 二维码生成失败不影响地址信息 */ }
  }
  res.json({ port: PORT, primary, qr, addrs });
}));

app.listen(PORT, HOST, () => {
  const cfg = configStatus();
  const addrs = lanAddrs();
  console.log(`\n  学习闭环 · 错题中枢`);
  console.log(`  本机     http://127.0.0.1:${PORT}`);
  if (addrs.length) {
    for (const a of addrs) {
      console.log(`  局域网   http://${a.address}:${PORT}   （${a.name}，手机用这个）`);
    }
    console.log(`  手机上打开：首页有二维码，手机扫一下就行（要和电脑连同一个 WiFi）`);
  } else {
    console.log(`  局域网   没检测到可用网卡，手机暂时连不上`);
  }
  console.log(`  数据目录 ${DATA_DIR}`);
  console.log(`  识题模型 ${cfg.vision.model} ${cfg.vision.ready ? '✓ 已配置' : '✗ 未配置 key'}`);
  console.log(`  文本模型 ${cfg.text.model} ${cfg.text.ready ? '✓ 已配置' : '✗ 未配置 key'}\n`);
});
