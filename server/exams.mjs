// 试卷分析：建考试 → 传多张图 → 自动判类型 → 逐张识别 → 人工处理 → 收进错题库 → 分析
//
// 设计前提（来自用户）：
// - 上传的可能是原卷、答题卡、答案/评分标准、批改过的整卷，任意组合，可能缺；
// - 一张图可能同时有题干和手写作答，所以 role 有 mixed；
// - 识别结果先落 exam_items（暂存），人工确认后才进 questions（错题库）；
// - 一场考试只对应一个科目，但同一晚可以建多场。
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { unlinkSync } from 'node:fs';

import { all, get, run, insert, update, nowISO, UPLOAD_DIR } from './db.mjs';
import { chat, imageToDataUrl, parseLooseJson } from './ai.mjs';
import { examPageMessages } from './prompts.mjs';
import { deriveMarks } from './logic.mjs';
import { S, num, kpList, resolveKp } from './util.mjs';

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().slice(0, 5);
      cb(null, 'exam-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype);
    cb(ok ? null : new Error('只接受 JPEG / PNG / WebP / GIF 图片'), ok);
  },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const EXAM_TYPES = { midterm: '期中', final: '期末', monthly: '月考', custom: '自定义' };

/** 把一条识别结果规整成 exam_items 的行 */
function toItemRow(examId, pageId, qIn) {
  let q = qIn;
  const options = q.options && typeof q.options === 'object' ? JSON.stringify(q.options) : null;
  const full = num(q.score_full);
  const got = num(q.score_got);
  let verdict = S(q.verdict);
  if (!verdict || !['right', 'wrong', 'partial', 'unknown'].includes(verdict)) {
    if (got != null && full != null) verdict = got >= full ? 'right' : got <= 0 ? 'wrong' : 'partial';
    else verdict = 'unknown';
  }
  const marks = q.marks && typeof q.marks === 'object' ? q.marks : null;
  let derived = null;
  if (marks) {
    derived = deriveMarks(marks);
    q = {
      ...q,
      my_answer: q.my_answer || derived.my_answer,
      correct_answer: q.correct_answer || derived.correct_answer,
      verdict: q.verdict && q.verdict !== 'unknown' ? q.verdict : derived.verdict,
    };
    // 注意：下面 return 用的是上面那个局部 verdict，必须同步覆盖，否则推导白算
    verdict = q.verdict;
  }
  return {
    exam_id: examId,
    page_id: pageId,
    q_no: S(q.q_no) || '?',
    qtype: S(q.qtype),
    stem: S(q.stem),
    options_json: options,
    my_answer: S(q.my_answer),
    correct_answer: S(q.correct_answer),
    solution: S(q.solution),
    grading_note: S(q.grading_note),
    // 模型给 kp 数组；手工加题 / 改题直接给 kp_name
    kp_name: Array.isArray(q.kp) && q.kp.length ? S(q.kp[0]) : (S(q.kp) || S(q.kp_name)),
    difficulty: num(q.difficulty) || null,
    score_full: full,
    score_got: got,
    verdict,
    handwriting: S(q.handwriting),
    marks_json: marks ? JSON.stringify(marks) : null,
    source: 'ai',
    created_at: nowISO(),
    updated_at: nowISO(),
  };
}

export function examsRouter() {
  const r = express.Router();

  // ---------------------------------------------------------------- 列表
  r.get('/', wrap(async (req, res) => {
    const subject = S(req.query.subject);
    const where = ['e.deleted_at IS NULL'];
    const p = [];
    if (subject && subject !== 'all') { where.push('e.subject_id=?'); p.push(subject); }
    const rows = all(
      `SELECT e.*,
              (SELECT COUNT(*) FROM exam_pages p WHERE p.exam_id=e.id) AS page_count,
              (SELECT COUNT(*) FROM exam_items i WHERE i.exam_id=e.id) AS item_count,
              (SELECT COUNT(*) FROM exam_items i WHERE i.exam_id=e.id AND i.verdict IN ('wrong','partial')) AS wrong_count,
              (SELECT COALESCE(SUM(i.score_got),0) FROM exam_items i WHERE i.exam_id=e.id) AS sum_got,
              (SELECT COALESCE(SUM(i.score_full),0) FROM exam_items i WHERE i.exam_id=e.id) AS sum_full
         FROM exams e WHERE ${where.join(' AND ')}
        ORDER BY e.exam_date DESC, e.id DESC`,
      ...p
    );
    res.json(rows.map((x) => ({ ...x, type_label: EXAM_TYPES[x.type] || x.type })));
  }));

  // ---------------------------------------------------------------- 建考试
  r.post('/', wrap(async (req, res) => {
    const b = req.body || {};
    if (!S(b.name)) return res.status(400).json({ error: '考试名称不能为空' });
    const id = insert('exams', {
      subject_id: S(b.subject_id) || 'math',
      name: S(b.name),
      type: S(b.type) || 'custom',
      exam_date: S(b.exam_date) || nowISO().slice(0, 10),
      full_score: num(b.full_score),
      my_score: num(b.my_score),
      rank: num(b.rank),
      total_students: num(b.total_students),
      note: S(b.note),
      status: 'staging',
      created_at: nowISO(),
      updated_at: nowISO(),
    });
    res.json({ id, exam: get('SELECT * FROM exams WHERE id=?', id) });
  }));

  // ---------------------------------------------------------------- 单场详情
  // ================================================================ 考次（一场考试，下挂多科）
  const GRADES = ['高一', '高二', '高三'];
  const FULL_DEFAULT = { chinese: 150, math: 150, english: 150, physics: 100, chemistry: 100, biology: 100 };

  const academicYear = (dateStr) => {
    const d = new Date(String(dateStr || '') + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return new Date().getFullYear();
    return d.getMonth() + 1 >= 9 ? d.getFullYear() : d.getFullYear() - 1;
  };
  const typeOf = (key) => get('SELECT * FROM exam_types WHERE key=?', key) || { key, label: key };
  const buildTitle = (cohort, grade, term, label) =>
    String(cohort) + (GRADES[(Number(grade) || 1) - 1] || '高一') + (term === 'down' ? '下' : '上') + label;

  /** 默认年级：入学届固定的情况下，按当前学年推（2026 届 → 2026-2027 学年是高一） */
  function defaultGrade(now = new Date()) {
    const cohort = Number(get("SELECT value FROM settings WHERE key='exam_cohort'")?.value || 0);
    if (!cohort) return 1;
    const ay = now.getMonth() + 1 >= 9 ? now.getFullYear() : now.getFullYear() - 1;
    return Math.max(1, Math.min(3, ay - cohort + 1));
  }

  r.get('/types', wrap(async (_req, res) => {
    res.json(all('SELECT * FROM exam_types ORDER BY builtin DESC, sort, id'));
  }));

  r.post('/types', wrap(async (req, res) => {
    const label = S(req.body?.label);
    if (!label) return res.status(400).json({ error: '类型名不能为空' });
    const dup = get('SELECT * FROM exam_types WHERE label=?', label);
    if (dup) return res.json({ type: dup, existed: true });
    const key = 'custom-' + Date.now().toString(36);
    const id = insert('exam_types', { key, label, builtin: 0, sort: 200 });
    res.json({ id, type: get('SELECT * FROM exam_types WHERE id=?', id) });
  }));

  r.patch('/types/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = get('SELECT * FROM exam_types WHERE id=?', id);
    if (!t) return res.status(404).json({ error: '类型不存在' });
    const label = S(req.body?.label);
    if (!label) return res.status(400).json({ error: '类型名不能为空' });
    run('UPDATE exam_types SET label=? WHERE id=?', label, id);
    res.json({ ok: true, type: get('SELECT * FROM exam_types WHERE id=?', id) });
  }));

  /** 常用值：参考人数、满分等，用户填过就记住 */
  const PRESET_KEYS = ['class_sizes', 'school_sizes'];
  const getPresets = () => {
    const out = {};
    for (const k of PRESET_KEYS) {
      try { out[k] = JSON.parse(get('SELECT value FROM exam_presets WHERE key=?', k)?.value || '[]'); }
      catch { out[k] = []; }
    }
    return out;
  };
  const mergePreset = (key, value) => {
    const v = Number(value);
    if (!v || v <= 0) return;
    const list = new Set(getPresets()[key] || []);
    list.add(v);
    run('INSERT INTO exam_presets (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key, JSON.stringify([...list].sort((a, b) => a - b).slice(-8)));
  };

  r.get('/presets', wrap(async (_req, res) => {
    res.json({ ...getPresets(), default_grade: defaultGrade(), cohort: Number(get("SELECT value FROM settings WHERE key='exam_cohort'")?.value || 0) || null });
  }));

  r.put('/presets', wrap(async (req, res) => {
    for (const k of PRESET_KEYS) {
      if (Array.isArray(req.body?.[k])) {
        const list = [...new Set(req.body[k].map(Number).filter((x) => x > 0))].sort((a, b) => a - b).slice(-8);
        run('INSERT INTO exam_presets (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(list));
      }
    }
    res.json({ ok: true, ...getPresets() });
  }));

  /** 考次列表：带筛选（年级/学期/科目/类型） */
  r.get('/sessions', wrap(async (req, res) => {
    const where = ['s.deleted_at IS NULL'];
    const p = [];
    if (req.query.grade) { where.push('s.grade=?'); p.push(Number(req.query.grade)); }
    if (req.query.term) { where.push('s.term=?'); p.push(String(req.query.term)); }
    if (req.query.type) { where.push('s.exam_type=?'); p.push(String(req.query.type)); }
    if (req.query.subject && req.query.subject !== 'all') {
      where.push('EXISTS (SELECT 1 FROM exams e WHERE e.session_id=s.id AND e.subject_id=? AND e.deleted_at IS NULL)');
      p.push(String(req.query.subject));
    }
    const rows = all(
      "SELECT s.*, (SELECT COUNT(*) FROM exams e WHERE e.session_id=s.id AND e.deleted_at IS NULL) AS subject_count, " +
      "(SELECT COALESCE(SUM(e.my_score),0) FROM exams e WHERE e.session_id=s.id AND e.deleted_at IS NULL) AS sum_score, " +
      "(SELECT COALESCE(SUM(e.full_score),0) FROM exams e WHERE e.session_id=s.id AND e.deleted_at IS NULL) AS sum_full " +
      'FROM exam_sessions s WHERE ' + where.join(' AND ') + ' ORDER BY s.exam_date DESC, s.id DESC',
      ...p
    );
    const subjects = all(
      'SELECT e.id, e.session_id, e.subject_id, e.name, e.full_score, e.my_score, e.rank, e.total_students, ' +
      'e.rank_class, e.class_size, e.rank_school, e.school_size, e.has_grade_point ' +
      'FROM exams e JOIN exam_sessions s ON s.id=e.session_id WHERE e.deleted_at IS NULL ORDER BY e.id'
    );
    const byId = new Map();
    for (const e of subjects) {
      if (!byId.has(e.session_id)) byId.set(e.session_id, []);
      byId.get(e.session_id).push(e);
    }
    res.json({
      sessions: rows.map((s) => ({
        ...s,
        type_label: typeOf(s.exam_type).label,
        subjects: byId.get(s.id) || [],
      })),
      default_grade: defaultGrade(),
      filters: { grades: GRADES, terms: [['up', '上学期'], ['down', '下学期']] },
    });
  }));

  r.get('/sessions/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const session = get('SELECT * FROM exam_sessions WHERE id=? AND deleted_at IS NULL', id);
    if (!session) return res.status(404).json({ error: '这场考试不存在' });
    const subjects = all('SELECT * FROM exams WHERE session_id=? AND deleted_at IS NULL ORDER BY id', id);
    res.json({
      session: { ...session, type_label: typeOf(session.exam_type).label },
      subjects,
      presets: getPresets(),
    });
  }));

  /** 建考次：大考可一次建多科；小考只建一科 */
  r.post('/sessions', wrap(async (req, res) => {
    const b = req.body || {};
    const grade = Math.max(1, Math.min(3, Number(b.grade) || defaultGrade()));
    const term = b.term === 'down' ? 'down' : 'up';
    const examDate = S(b.exam_date) || nowISO().slice(0, 10);
    const type = typeOf(S(b.exam_type) || 'midterm');
    const isBig = b.is_big === false || b.is_big === 0 ? 0 : 1;

    const ay = academicYear(examDate);
    const cohort = Number(get("SELECT value FROM settings WHERE key='exam_cohort'")?.value || 0) || (ay - (grade - 1));
    if (!get("SELECT value FROM settings WHERE key='exam_cohort'")) {
      run("INSERT INTO settings (key,value) VALUES ('exam_cohort',?)", String(cohort));
    }
    const title = S(b.title) || buildTitle(cohort, grade, term, type.label);

    if (get('SELECT id FROM exam_sessions WHERE title=? AND deleted_at IS NULL', title)) {
      return res.status(409).json({ error: '已经有一场叫「' + title + '」的考试了' });
    }

    const sid = insert('exam_sessions', {
      title, grade, term, exam_type: type.key, exam_date: examDate, is_big: isBig,
      note: S(b.note), created_at: nowISO(), updated_at: nowISO(),
    });

    const wanted = Array.isArray(b.subjects) ? b.subjects : [];
    let added = 0;
    for (const s of wanted) {
      const subjectId = S(s.subject_id);
      if (!subjectId) continue;
      const label = (get('SELECT name FROM subjects WHERE id=?', subjectId) || {}).name || subjectId;
      insert('exams', {
        subject_id: subjectId,
        name: title + '·' + label,
        type: type.key,
        exam_date: examDate,
        full_score: num(s.full_score) ?? FULL_DEFAULT[subjectId] ?? 100,
        my_score: num(s.my_score),
        has_grade_point: s.has_grade_point ? 1 : 0,
        rank_class: num(s.rank_class), class_size: num(s.class_size),
        rank_school: num(s.rank_school), school_size: num(s.school_size),
        rank: num(s.rank), total_students: num(s.total_students),
        session_id: sid,
        status: 'staging',
        created_at: nowISO(), updated_at: nowISO(),
      });
      if (s.class_size) mergePreset('class_sizes', s.class_size);
      if (s.school_size) mergePreset('school_sizes', s.school_size);
      added++;
    }
    res.json({ id: sid, session: get('SELECT * FROM exam_sessions WHERE id=?', sid), added });
  }));

  r.patch('/sessions/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const s = get('SELECT * FROM exam_sessions WHERE id=? AND deleted_at IS NULL', id);
    if (!s) return res.status(404).json({ error: '这场考试不存在' });
    const b = req.body || {};
    const patch = {};
    for (const k of ['title', 'term', 'exam_type', 'exam_date', 'note']) if (k in b) patch[k] = S(b[k]);
    if ('grade' in b) patch.grade = Math.max(1, Math.min(3, Number(b.grade) || s.grade));
    if ('is_big' in b) patch.is_big = b.is_big ? 1 : 0;
    // 名称不手填：改了年级/学期/类型就按入学届重算
    if (!('title' in b) && ('grade' in b || 'term' in b || 'exam_type' in b)) {
      const cohort = Number(get("SELECT value FROM settings WHERE key='exam_cohort'")?.value || 0)
        || (academicYear(patch.exam_date || s.exam_date) - ((patch.grade || s.grade) - 1));
      const term = patch.term || s.term;
      const label = typeOf(patch.exam_type || s.exam_type).label;
      patch.title = buildTitle(cohort, patch.grade || s.grade, term, label);
    }
    patch.updated_at = nowISO();
    update('exam_sessions', id, patch);
    // 科目记录的 name / type / date 跟着走，别出现「考试叫期中、科目还叫月考」
    const next = get('SELECT * FROM exam_sessions WHERE id=?', id);
    run('UPDATE exams SET type=?, exam_date=?, name=? || \'·\' || (SELECT name FROM subjects WHERE id=exams.subject_id), updated_at=? WHERE session_id=?',
      next.exam_type, next.exam_date, next.title, nowISO(), id);
    res.json({ ok: true, session: next });
  }));

  r.delete('/sessions/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    run('UPDATE exam_sessions SET deleted_at=? WHERE id=?', nowISO(), id);
    run('UPDATE exams SET deleted_at=? WHERE session_id=?', nowISO(), id);
    res.json({ ok: true });
  }));

  /** 往已有考次加一科（大考漏录、或小考补充） */
  r.post('/sessions/:id/subjects', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const s = get('SELECT * FROM exam_sessions WHERE id=? AND deleted_at IS NULL', id);
    if (!s) return res.status(404).json({ error: '这场考试不存在' });
    const b = req.body || {};
    const subjectId = S(b.subject_id);
    if (!subjectId) return res.status(400).json({ error: '要选科目' });
    if (get('SELECT id FROM exams WHERE session_id=? AND subject_id=? AND deleted_at IS NULL', id, subjectId)) {
      return res.status(409).json({ error: '这场考试已经有这一科了' });
    }
    const label = (get('SELECT name FROM subjects WHERE id=?', subjectId) || {}).name || subjectId;
    const eid = insert('exams', {
      subject_id: subjectId, name: s.title + '·' + label, type: s.exam_type, exam_date: s.exam_date,
      full_score: num(b.full_score) ?? FULL_DEFAULT[subjectId] ?? 100,
      my_score: num(b.my_score), has_grade_point: b.has_grade_point ? 1 : 0,
      rank_class: num(b.rank_class), class_size: num(b.class_size),
      rank_school: num(b.rank_school), school_size: num(b.school_size),
      session_id: id, status: 'staging', created_at: nowISO(), updated_at: nowISO(),
    });
    if (b.class_size) mergePreset('class_sizes', b.class_size);
    if (b.school_size) mergePreset('school_sizes', b.school_size);
    res.json({ id: eid, exam: get('SELECT * FROM exams WHERE id=?', eid) });
  }));

  r.get('/:id(\\d+)', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const exam = get('SELECT * FROM exams WHERE id=? AND deleted_at IS NULL', id);
    if (!exam) return res.status(404).json({ error: '考试不存在' });
    const pages = all('SELECT * FROM exam_pages WHERE exam_id=? ORDER BY sort, id', id);
    const items = all('SELECT * FROM exam_items WHERE exam_id=? ORDER BY q_no + 0, id', id);
    res.json({ exam: { ...exam, type_label: EXAM_TYPES[exam.type] || exam.type }, pages, items });
  }));

  r.patch('/:id(\\d+)', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const patch = {};
    for (const k of ['subject_id', 'name', 'type', 'exam_date', 'note', 'status']) if (k in b) patch[k] = S(b[k]);
    for (const k of ['full_score', 'my_score', 'rank', 'total_students', 'rank_class', 'class_size', 'rank_school', 'school_size']) {
      if (k in b) patch[k] = num(b[k]);
    }
    if ('has_grade_point' in b) patch.has_grade_point = b.has_grade_point ? 1 : 0;
    patch.updated_at = nowISO();
    update('exams', id, patch);
    res.json({ ok: true, exam: get('SELECT * FROM exams WHERE id=?', id) });
  }));

  r.delete('/:id(\\d+)', wrap(async (req, res) => {
    const id = Number(req.params.id);
    for (const p of all('SELECT image_path FROM exam_pages WHERE exam_id=?', id)) {
      try { unlinkSync(path.join(UPLOAD_DIR, p.image_path)); } catch { /* 已删 */ }
    }
    run('DELETE FROM exams WHERE id=?', id);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- 传图
  r.post('/:id/pages', upload.array('photos', 20), wrap(async (req, res) => {
    const id = Number(req.params.id);
    const exam = get('SELECT * FROM exams WHERE id=?', id);
    if (!exam) return res.status(404).json({ error: '考试不存在' });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '没有收到图片' });
    const base = Number(get('SELECT COALESCE(MAX(sort),0) AS m FROM exam_pages WHERE exam_id=?', id)?.m || 0);
    const ids = [];
    files.forEach((f, i) => {
      ids.push(insert('exam_pages', {
        exam_id: id,
        image_path: path.basename(f.path),
        role: S(req.body.role) || 'unknown',
        sort: base + i + 1,
        status: 'pending',
        uploaded_at: nowISO(),
      }));
    });
    res.json({ added: ids.length, ids, pages: all('SELECT * FROM exam_pages WHERE exam_id=? ORDER BY sort, id', id) });
  }));

  r.patch('/pages/:pid', wrap(async (req, res) => {
    const pid = Number(req.params.pid);
    const b = req.body || {};
    const patch = {};
    if ('role' in b) patch.role = S(b.role) || 'unknown';
    if ('sort' in b) patch.sort = num(b.sort) || 0;
    if ('role_note' in b) patch.role_note = S(b.role_note);
    update('exam_pages', pid, patch);
    res.json({ ok: true, page: get('SELECT * FROM exam_pages WHERE id=?', pid) });
  }));

  r.delete('/pages/:pid', wrap(async (req, res) => {
    const p = get('SELECT * FROM exam_pages WHERE id=?', Number(req.params.pid));
    if (!p) return res.status(404).json({ error: '图片不存在' });
    try { unlinkSync(path.join(UPLOAD_DIR, p.image_path)); } catch { /* 已删 */ }
    run('DELETE FROM exam_pages WHERE id=?', p.id);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- 识别一张
  r.post('/pages/:pid/extract', wrap(async (req, res) => {
    const pid = Number(req.params.pid);
    const page = get('SELECT * FROM exam_pages WHERE id=?', pid);
    if (!page) return res.status(404).json({ error: '图片不存在' });
    const exam = get('SELECT * FROM exams WHERE id=?', page.exam_id);

    run("UPDATE exam_pages SET status='running', error=NULL WHERE id=?", pid);
    try {
      const dataUrl = await imageToDataUrl(path.join(UPLOAD_DIR, page.image_path));
      const out = await chat({
        kind: 'vision',
        messages: examPageMessages({
          imageDataUrl: dataUrl,
          subjectId: exam.subject_id,
          examName: exam.name,
          examType: EXAM_TYPES[exam.type] || exam.type,
          roleHint: req.body?.roleHint || page.role_note || '',
          kpList: kpList(exam.subject_id),
        }),
        json: true,
        maxTokens: 9000,
        thinking: process.env.VISION_THINKING === 'on',
      });
      const parsed = parseLooseJson(out.content, 'object');
      const role = S(parsed.page_role) || 'unknown';
      run(
        "UPDATE exam_pages SET status='done', role=?, role_conf=?, role_note=?, raw_json=? WHERE id=?",
        role, num(parsed.role_confidence), S(parsed.role_reason) || S(parsed.page_note), JSON.stringify(parsed), pid
      );
      res.json({
        page: get('SELECT * FROM exam_pages WHERE id=?', pid),
        staged: (parsed.questions || []).length,
        parsed,
        usage: out.usage,
      });
    } catch (e) {
      run("UPDATE exam_pages SET status='failed', error=? WHERE id=?", String(e.message).slice(0, 800), pid);
      throw e;
    }
  }));

  // ---------------------------------------------------------------- 合并进暂存
  // 把已识别页面的题目并进 exam_items。同题号已存在则补空字段，不覆盖人工改过的内容。
  r.post('/:id/merge', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const pages = all(
      "SELECT * FROM exam_pages WHERE exam_id=? AND status='done' AND raw_json IS NOT NULL ORDER BY sort, id", id
    );
    if (!pages.length) return res.status(400).json({ error: '还没有识别完成的图片' });

    let added = 0, filled = 0;
    const seen = new Set();
    for (const p of pages) {
      let parsed;
      try { parsed = JSON.parse(p.raw_json); } catch { continue; }
      for (const q of parsed.questions || []) {
        const row = toItemRow(id, p.id, q);
        if (!row.stem && !row.correct_answer && !row.my_answer) continue; // 空条目不要
        const key = row.q_no;
        if (seen.has(key)) {           // 同一次合并内重复题号：当作补充信息
          const ex = get('SELECT * FROM exam_items WHERE exam_id=? AND q_no=?', id, key);
          if (ex) {
            const patch = {};
            for (const f of ['stem', 'my_answer', 'correct_answer', 'solution', 'grading_note', 'kp_name', 'score_got', 'score_full', 'qtype', 'difficulty']) {
              if (!ex[f] && row[f]) patch[f] = row[f];
            }
            if (Object.keys(patch).length) { patch.updated_at = nowISO(); update('exam_items', ex.id, patch); filled++; }
          }
          continue;
        }
        seen.add(key);
        const ex = get('SELECT * FROM exam_items WHERE exam_id=? AND q_no=?', id, key);
        if (ex) {
          const patch = {};
          for (const f of ['stem', 'my_answer', 'correct_answer', 'solution', 'grading_note', 'kp_name', 'score_got', 'score_full', 'qtype', 'difficulty', 'handwriting']) {
            if (!ex[f] && row[f]) patch[f] = row[f];
          }
          if (Object.keys(patch).length) { patch.updated_at = nowISO(); update('exam_items', ex.id, patch); filled++; }
        } else {
          insert('exam_items', row);
          added++;
        }
      }
      run('UPDATE exam_pages SET extracted=1 WHERE id=?', p.id);
    }
    run("UPDATE exams SET status='reviewing', updated_at=? WHERE id=?", nowISO(), id);
    res.json({ added, filled, total: get('SELECT COUNT(*) AS c FROM exam_items WHERE exam_id=?', id).c });
  }));

  // ---------------------------------------------------------------- 手工加一道（缺原卷 / 识别漏题时用）
  r.post('/:id/items', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const exam = get('SELECT * FROM exams WHERE id=?', id);
    if (!exam) return res.status(404).json({ error: '考试不存在' });
    const b = req.body || {};
    if (!S(b.q_no) && !S(b.stem)) return res.status(400).json({ error: '至少要填题号或题干' });
    const row = toItemRow(id, null, { ...b, q_no: S(b.q_no) || String(get('SELECT COUNT(*) AS c FROM exam_items WHERE exam_id=?', id).c + 1) });
    row.source = 'manual';
    const iid = insert('exam_items', row);
    res.json({ id: iid, item: get('SELECT * FROM exam_items WHERE id=?', iid) });
  }));

  // ---------------------------------------------------------------- 暂存条目
  r.get('/:id/items', wrap(async (req, res) => {
    res.json(all('SELECT * FROM exam_items WHERE exam_id=? ORDER BY q_no + 0, id', Number(req.params.id)));
  }));

  r.patch('/items/:iid', wrap(async (req, res) => {
    const iid = Number(req.params.iid);
    const b = req.body || {};
    const patch = {};
    for (const k of ['q_no', 'qtype', 'stem', 'my_answer', 'correct_answer', 'solution', 'grading_note', 'kp_name', 'verdict', 'handwriting']) {
      if (k in b) patch[k] = S(b[k]);
    }
    for (const k of ['score_full', 'score_got', 'difficulty']) if (k in b) patch[k] = num(b[k]);
    if ('marks' in b) {
      const marks = b.marks || null;
      patch.marks_json = marks ? JSON.stringify(marks) : null;
      if (marks) {
        const d = deriveMarks(marks);
        patch.my_answer = d.my_answer;
        patch.correct_answer = d.correct_answer;
        patch.verdict = d.verdict;
      }
    }
    patch.updated_at = nowISO();
    update('exam_items', iid, patch);
    res.json({ ok: true, item: get('SELECT * FROM exam_items WHERE id=?', iid) });
  }));

  r.delete('/items/:iid', wrap(async (req, res) => {
    run('DELETE FROM exam_items WHERE id=?', Number(req.params.iid));
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- 收进错题库
  r.post('/:id/import', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const exam = get('SELECT * FROM exams WHERE id=?', id);
    if (!exam) return res.status(404).json({ error: '考试不存在' });
    const onlyWrong = req.body?.onlyWrong !== false;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;

    let list = all('SELECT * FROM exam_items WHERE exam_id=?', id);
    if (ids) list = list.filter((x) => ids.includes(x.id));
    if (onlyWrong) list = list.filter((x) => x.verdict === 'wrong' || x.verdict === 'partial');
    list = list.filter((x) => !x.imported_qid);

    const created = [];
    for (const it of list) {
      const kp = resolveKp(exam.subject_id, it.kp_name);
      const stem = it.stem || ('（来自 ' + exam.name + ' 第 ' + it.q_no + ' 题，题干未识别，请补）');
      const qid = insert('questions', {
        subject_id: exam.subject_id,
        exam_id: exam.id,
        exam_item_id: it.id,
        kp_id: kp.kp_id,
        kp_name: kp.kp_name,
        stem,
        my_answer: it.my_answer,
        correct_answer: it.correct_answer,
        solution: it.solution,
        error_cause: it.grading_note,
        error_type: null,
        difficulty: it.difficulty || 3,
        status: 'first',
        error_count: 1,
        correct_streak: 0,
        review_count: 0,
        first_error_at: exam.exam_date + 'T00:00:00.000Z',
        last_error_at: exam.exam_date + 'T00:00:00.000Z',
        next_review_at: nowISO(),
        created_at: nowISO(),
        updated_at: nowISO(),
      });
      update('exam_items', it.id, { imported_qid: qid });
      created.push(qid);
    }
    res.json({ imported: created.length, ids: created });
  }));

  // ---------------------------------------------------------------- 分析
  r.get('/:id/analysis', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const exam = get('SELECT * FROM exams WHERE id=? AND deleted_at IS NULL', id);
    if (!exam) return res.status(404).json({ error: '考试不存在' });
    const items = all('SELECT * FROM exam_items WHERE exam_id=?', id);
    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

    const full = items.reduce((a, b) => a + (b.score_full || 0), 0);
    const got = items.reduce((a, b) => a + (b.score_got || 0), 0);
    const wrong = items.filter((x) => x.verdict === 'wrong').length;
    const partial = items.filter((x) => x.verdict === 'partial').length;
    const right = items.filter((x) => x.verdict === 'right').length;
    const unknown = items.filter((x) => x.verdict === 'unknown').length;

    const group = (fn) => {
      const m = new Map();
      for (const it of items) {
        const k = fn(it) || '未标注';
        const o = m.get(k) || { label: k, n: 0, lost: 0, full: 0, got: 0 };
        o.n += 1;
        o.full += it.score_full || 0;
        o.got += it.score_got || 0;
        o.lost = Math.max(0, o.full - o.got);
        m.set(k, o);
      }
      return [...m.values()].map((o) => ({ ...o, rate: pct(o.got, o.full) })).sort((a, b) => b.lost - a.lost || b.n - a.n);
    };

    const byKp = group((i) => i.kp_name);
    const byType = group((i) => ({ choice: '选择题', fill: '填空题', short: '简答', essay: '作文', calc: '计算/证明' }[i.qtype] || '未标注'));
    const byDiff = group((i) => '难度 ' + (i.difficulty || '?'));

    const lostTop = items
      .filter((i) => (i.score_full || 0) > (i.score_got || 0))
      .sort((a, b) => (b.score_full - b.score_got) - (a.score_full - a.score_got))
      .slice(0, 8)
      .map((i) => ({ id: i.id, q_no: i.q_no, kp_name: i.kp_name, lost: (i.score_full || 0) - (i.score_got || 0), full: i.score_full, got: i.score_got, verdict: i.verdict }));

    // 同科目历次对比
    const history = all(
      "SELECT id, name, exam_date, my_score, full_score FROM exams WHERE subject_id=? AND deleted_at IS NULL ORDER BY exam_date DESC, id DESC LIMIT 8",
      exam.subject_id
    ).reverse();

    res.json({
      exam: { ...exam, type_label: EXAM_TYPES[exam.type] || exam.type },
      totals: {
        items: items.length, wrong, partial, right, unknown,
        full: Math.round(full * 10) / 10,
        got: Math.round(got * 10) / 10,
        lost: Math.round((full - got) * 10) / 10,
        rate: pct(got, full),
        my_score: exam.my_score,
        full_score: exam.full_score,
      },
      by_kp: byKp.slice(0, 12),
      by_type: byType,
      by_difficulty: byDiff,
      lost_top: lostTop,
      history,
    });
  }));


  return r;
}