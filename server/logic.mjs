// 业务规则：遗忘曲线调度、状态机、复习单排布、周报统计
//
// 关键设计：在校 6:00-22:30 无设备，所以不做每日推送，
// 改成「周末批处理 + 一张纸质复习单带进学校」。

import { all, get, run, nowISO } from './db.mjs';

const ARCHIVE_AFTER_DAYS = Number(process.env.ARCHIVE_AFTER_DAYS || 30);
// 归档前至少要真的重做过几次、连对几次，避免「从没排进复习单」的题被误判为已掌握
const ARCHIVE_MIN_REVIEWS = Number(process.env.ARCHIVE_MIN_REVIEWS || 2);
const ARCHIVE_MIN_STREAK = Number(process.env.ARCHIVE_MIN_STREAK || 1);
const SHEET_PER_DAY = Math.min(8, Math.max(1, Number(process.env.SHEET_PER_DAY || 4)));

// ---------------------------------------------------------------- 日期
export const DAY = 86_400_000;

export function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function isoDate(d = new Date()) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

/** ISO 周编号，如 2026-W45 */
export function isoWeek(d = new Date()) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = x.getUTCDay() || 7;      // 周一=1 … 周日=7
  x.setUTCDate(x.getUTCDate() + 4 - dayNum); // 移到本周周四
  const yearStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((x - yearStart) / DAY + 1) / 7);
  return `${x.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 某个 ISO 周对应的周一到周日 */
export function weekRange(weekKey) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!m) throw new Error(`周格式不对：${weekKey}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
  const local = new Date(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate());
  return { start: local, end: addDays(local, 6) };
}

/**
 * 复习单该排哪一周。
 *
 * 关键：你在校是周一到周五，周末才回家。
 * 所以周末（周六/周日）生成的单子，用的人是「下周一」开始的，
 * 必须排到下一周去，否则新题全部落在窗口外，单子永远是空的。
 * 周一到周五生成的，就排本周。
 */
export function defaultSheetWeek(now = new Date()) {
  const d = startOfDay(now);
  const isoDay = d.getDay() || 7;          // 周一=1 … 周日=7
  const monday = addDays(d, 1 - isoDay);   // 本周一
  const target = isoDay >= 6 ? addDays(monday, 7) : monday; // 周六日 → 下周一
  return isoWeek(target);
}

// ---------------------------------------------------------------- 遗忘曲线
/** 复习间隔（天）。first=头次错，key=重点错。
 *  终点不是无限复习，而是靠「30 天不再错」自动归档来终止。 */
export function intervals(status) {
  return status === 'key' ? [1, 2, 4, 7, 14, 21, 15, 15] : [1, 3, 7, 15, 15];
}

export function computeNextReview(q, from = new Date()) {
  const chain = intervals(q.status);
  const idx = Math.min(q.review_count ?? 0, chain.length - 1);
  return addDays(from, chain[idx]).toISOString();
}

/** 按规律刷新所有活跃错题的 next_review_at（幂等，可反复跑） */
export function refreshSchedules() {
  const rows = all(
    `SELECT * FROM questions WHERE status != 'archived' AND deleted_at IS NULL`
  );
  let n = 0;
  for (const q of rows) {
    const base = q.last_review_at ? new Date(q.last_review_at) : new Date(q.first_error_at);
    const next = computeNextReview(q, base);
    if (next !== q.next_review_at) {
      run('UPDATE questions SET next_review_at=? WHERE id=?', next, q.id);
      n++;
    }
  }
  return n;
}

/** 30 天没再错 → 归档为已掌握。二次错 → 升级为重点错题。
 *
 *  重要：光"30 天没再错"不等于"掌握了"——
 *  一道题可能压根没排进复习单（一周只装 20 道），从没重做过也被算成已掌握。
 *  所以必须同时满足：至少重做过 ARCHIVE_MIN_REVIEWS 次，且连对 ARCHIVE_MIN_STREAK 次。 */
export function applyStatusRules(now = new Date()) {
  const archived = run(
    `UPDATE questions
        SET status='archived', archived_at=?, archive_reason=?
      WHERE status != 'archived'
        AND deleted_at IS NULL
        AND julianday(?) - julianday(last_error_at) > ?
        AND review_count >= ?
        AND correct_streak >= ?`,
    now.toISOString(),
    `${ARCHIVE_AFTER_DAYS} 天内未再出错，且已重做通过`,
    now.toISOString(),
    ARCHIVE_AFTER_DAYS,
    ARCHIVE_MIN_REVIEWS,
    ARCHIVE_MIN_STREAK
  ).changes;

  const promoted = run(
    `UPDATE questions
        SET status='key', updated_at=?
      WHERE status='first' AND error_count >= 2 AND deleted_at IS NULL`,
    now.toISOString()
  ).changes;

  return { archived, promoted };
}

/** 记一次重做结果 */
export function recordAttempt(questionId, result, via = 'app', note = null) {
  const q = get('SELECT * FROM questions WHERE id=? AND deleted_at IS NULL', questionId);
  if (!q) throw new Error(`错题 ${questionId} 不存在`);

  const at = nowISO();
  run(
    'INSERT INTO attempts (question_id, at, result, via, note) VALUES (?,?,?,?,?)',
    questionId, at, result, via, note
  );

  const patch = {
    review_count: (q.review_count || 0) + 1,
    last_review_at: at,
    updated_at: at,
  };

  if (result === 'wrong') {
    patch.error_count = (q.error_count || 1) + 1;
    patch.correct_streak = 0;
    patch.last_error_at = at;
    patch.status = (patch.error_count >= 2 || q.status === 'key') ? 'key' : 'first';
    // 错了就回到"前几天"重新走一遍曲线
    patch.review_count = 0;
  } else {
    patch.correct_streak = (q.correct_streak || 0) + 1;
  }

  const merged = { ...q, ...patch };
  patch.next_review_at = computeNextReview(merged, new Date(at));

  const keys = Object.keys(patch);
  run(
    `UPDATE questions SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`,
    ...keys.map((k) => patch[k]), questionId
  );

  return get('SELECT * FROM questions WHERE id=?', questionId);
}

// ---------------------------------------------------------------- 复习单
/**
 * 生成本周复习单。
 * 挑选：本周到期 + 逾期未审 + 重点错题兜底，按优先级分配到周一~周五。
 */
export function buildSheet(weekKey, { perDay = SHEET_PER_DAY, force = false } = {}) {
  const { start, end } = weekRange(weekKey);
  const sundayEnd = addDays(end, 1);

  const existing = get('SELECT * FROM sheets WHERE week=?', weekKey);
  if (existing && existing.status === 'returned' && !force) {
    throw new Error('这周的复习单已经回收并生效了，重建会打乱记录。要重排请先删掉它。');
  }

  const candidates = all(
    `SELECT * FROM questions
      WHERE status != 'archived' AND deleted_at IS NULL
      ORDER BY
        CASE status WHEN 'key' THEN 0 ELSE 1 END,
        COALESCE(next_review_at, '1970') ASC,
        error_count DESC,
        difficulty DESC`
  );

  const due = candidates.filter((q) => {
    const next = q.next_review_at ? new Date(q.next_review_at) : new Date(0);
    return next < sundayEnd;
  });

  // 容量控制：超了就先放弃"不逾期且非重点"的
  const capacity = perDay * 5;
  let picked = due;
  if (due.length > capacity) {
    const urgent = due.filter(
      (q) =>
        q.status === 'key' ||
        (q.next_review_at && new Date(q.next_review_at) < start)
    );
    picked = [...urgent, ...due.filter((q) => !urgent.includes(q))].slice(0, capacity);
  }

  // 分配：按优先级轮流塞进每天，避免某天堆 8 道
  const slots = Array.from({ length: 5 }, () => []);
  picked.forEach((q, i) => {
    let best = 0;
    for (let d = 1; d < 5; d++) if (slots[d].length < slots[best].length) best = d;
    slots[best].push(q);
  });

  const sheetId = existing?.id ?? null;
  if (sheetId) {
    run('DELETE FROM sheet_items WHERE sheet_id=?', sheetId);
    run("UPDATE sheets SET created_at=?, status='draft' WHERE id=?", nowISO(), sheetId);
  }
  const sid =
    sheetId ??
    Number(
      run('INSERT INTO sheets (week, created_at, status) VALUES (?,?,?)', weekKey, nowISO(), 'draft')
        .lastInsertRowid
    );

  let pos = 0;
  slots.forEach((list, di) => {
    list.forEach((q, i) => {
      run(
        'INSERT INTO sheet_items (sheet_id, question_id, day, position) VALUES (?,?,?,?)',
        sid, q.id, di + 1, i + 1
      );
      pos++;
    });
  });

  return { week: weekKey, sheetId: sid, total: pos, days: slots.map((s) => s.length) };
}

export function sheetDetail(sheetId) {
  const sheet = get('SELECT * FROM sheets WHERE id=?', sheetId);
  if (!sheet) return null;
  const items = all(
    `SELECT si.*, q.stem, q.subject_id, q.kp_name, q.difficulty, q.status AS q_status,
            q.correct_answer, q.solution, q.error_cause, q.my_answer
       FROM sheet_items si JOIN questions q ON q.id = si.question_id
      WHERE si.sheet_id=?
      ORDER BY si.day, si.position`,
    sheetId
  );
  return { sheet, items };
}

/** 回收复习单：把勾选结果批量写回 */
export function fillSheet(sheetId, results) {
  const items = all('SELECT * FROM sheet_items WHERE sheet_id=?', sheetId);
  const byId = new Map(items.map((i) => [i.question_id, i]));
  const touched = [];
  for (const [qidRaw, result] of Object.entries(results)) {
    const qid = Number(qidRaw);
    if (!byId.has(qid)) continue;
    if (result !== 'correct' && result !== 'wrong') continue;
    run(
      'UPDATE sheet_items SET result=?, filled_at=? WHERE sheet_id=? AND question_id=?',
      result, nowISO(), sheetId, qid
    );
    recordAttempt(qid, result, 'sheet');
    touched.push(qid);
  }
  run("UPDATE sheets SET status='returned' WHERE id=?", sheetId);
  applyStatusRules();
  refreshSchedules();
  return { updated: touched.length };
}

// ---------------------------------------------------------------- 统计
export function weeklyStats(weekKey) {
  const { start, end } = weekRange(weekKey);
  const s = start.toISOString();
  const e = addDays(end, 1).toISOString();

  const prevStart = addDays(start, -7).toISOString();
  const prevEnd = s;

  const num = (sql, ...p) => Number(get(sql, ...p)?.v ?? 0);

  const newQ = num(
    'SELECT COUNT(*) AS v FROM questions WHERE deleted_at IS NULL AND created_at>=? AND created_at<?',
    s, e
  );
  const prevNewQ = num(
    'SELECT COUNT(*) AS v FROM questions WHERE deleted_at IS NULL AND created_at>=? AND created_at<?',
    prevStart, prevEnd
  );
  const attempts = num('SELECT COUNT(*) AS v FROM attempts WHERE at>=? AND at<?', s, e);
  const prevAttempts = num('SELECT COUNT(*) AS v FROM attempts WHERE at>=? AND at<?', prevStart, prevEnd);
  const correct = num(
    "SELECT COUNT(*) AS v FROM attempts WHERE at>=? AND at<? AND result='correct'", s, e
  );
  const prevCorrect = num(
    "SELECT COUNT(*) AS v FROM attempts WHERE at>=? AND at<? AND result='correct'", prevStart, prevEnd
  );

  const byKp = all(
    `SELECT COALESCE(kp_name,'未标注') AS kp, COUNT(*) AS n
       FROM questions WHERE deleted_at IS NULL AND created_at>=? AND created_at<?
      GROUP BY kp ORDER BY n DESC LIMIT 8`,
    s, e
  );
  const byType = all(
    `SELECT COALESCE(error_type,'未分类') AS type, COUNT(*) AS n
       FROM questions WHERE deleted_at IS NULL AND created_at>=? AND created_at<?
      GROUP BY type ORDER BY n DESC`,
    s, e
  );
  const byStatus = all(
    `SELECT status, COUNT(*) AS n FROM questions WHERE deleted_at IS NULL GROUP BY status`
  );
  const archivedThisWeek = num(
    "SELECT COUNT(*) AS v FROM questions WHERE archived_at>=? AND archived_at<?", s, e
  );

  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

  return {
    week: weekKey,
    range: { start: isoDate(start), end: isoDate(end) },
    new_questions: newQ,
    new_questions_prev: prevNewQ,
    attempts,
    attempts_prev: prevAttempts,
    correct,
    accuracy: pct(correct, attempts),
    accuracy_prev: pct(prevCorrect, prevAttempts),
    archived_this_week: archivedThisWeek,
    by_kp: byKp,
    by_error_type: byType,
    by_status: byStatus,
  };
}

/** 给模型看的错题摘要（控制长度，避免烧 token） */
export function weekDigest(weekKey, limit = 25) {
  const { start, end } = weekRange(weekKey);
  const rows = all(
    `SELECT id, kp_name, error_type, difficulty, status, error_count, stem, error_cause
       FROM questions
      WHERE deleted_at IS NULL AND created_at>=? AND created_at<?
      ORDER BY CASE status WHEN 'key' THEN 0 WHEN 'first' THEN 1 ELSE 2 END, difficulty DESC
      LIMIT ?`,
    start.toISOString(), addDays(end, 1).toISOString(), limit
  );
  return rows
    .map(
      (q) =>
        `#${q.id} [${q.kp_name || '未标注'}|${q.error_type || '未分类'}|难度${q.difficulty || '?'}|错${q.error_count}次]` +
        `\n题干：${(q.stem || '').replace(/\s+/g, ' ').slice(0, 160)}` +
        `\n错因：${(q.error_cause || '未记录').slice(0, 80)}`
    )
    .join('\n\n');
}

// ---------------------------------------------------------------- 月报
export function currentMonth(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}`;
}

export function monthRange(monthKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) throw new Error(`月份格式不对：${monthKey}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const start = new Date(y, mo, 1, 0, 0, 0, 0);
  const end = new Date(y, mo + 1, 1, 0, 0, 0, 0); // 含头不含尾
  return { start, end };
}

export function prevMonthKey(monthKey) {
  const { start } = monthRange(monthKey);
  return currentMonth(new Date(start.getFullYear(), start.getMonth() - 1, 15));
}

export function monthStats(monthKey) {
  const { start, end } = monthRange(monthKey);
  const { start: pStart, end: pEnd } = monthRange(prevMonthKey(monthKey));
  const s = start.toISOString();
  const e = end.toISOString();

  const num = (sql, ...p) => Number(get(sql, ...p)?.v ?? 0);
  const newQ = num(
    'SELECT COUNT(*) AS v FROM questions WHERE deleted_at IS NULL AND created_at>=? AND created_at<?', s, e
  );
  const prevNewQ = num(
    'SELECT COUNT(*) AS v FROM questions WHERE deleted_at IS NULL AND created_at>=? AND created_at<?',
    pStart.toISOString(), pEnd.toISOString()
  );
  const attempts = num('SELECT COUNT(*) AS v FROM attempts WHERE at>=? AND at<?', s, e);
  const correct = num("SELECT COUNT(*) AS v FROM attempts WHERE at>=? AND at<? AND result='correct'", s, e);
  const attemptsPrev = num(
    'SELECT COUNT(*) AS v FROM attempts WHERE at>=? AND at<?', pStart.toISOString(), pEnd.toISOString()
  );
  const correctPrev = num(
    "SELECT COUNT(*) AS v FROM attempts WHERE at>=? AND at<? AND result='correct'",
    pStart.toISOString(), pEnd.toISOString()
  );

  const archived = num(
    'SELECT COUNT(*) AS v FROM questions WHERE deleted_at IS NULL AND archived_at>=? AND archived_at<?', s, e
  );
  const promoted = num(
    'SELECT COUNT(*) AS v FROM questions WHERE deleted_at IS NULL AND status=\'key\' AND last_error_at>=? AND last_error_at<?',
    s, e
  );
  const keyTotal = num(
    "SELECT COUNT(*) AS v FROM questions WHERE deleted_at IS NULL AND status='key'"
  );
  const activeTotal = num(
    "SELECT COUNT(*) AS v FROM questions WHERE deleted_at IS NULL AND status!='archived'"
  );

  const byKp = all(
    `SELECT COALESCE(kp_name,'未标注') AS kp, COUNT(*) AS n
       FROM questions WHERE deleted_at IS NULL AND created_at>=? AND created_at<?
      GROUP BY kp ORDER BY n DESC LIMIT 10`, s, e
  );
  const byType = all(
    `SELECT COALESCE(error_type,'未分类') AS type, COUNT(*) AS n
       FROM questions WHERE deleted_at IS NULL AND created_at>=? AND created_at<?
      GROUP BY type ORDER BY n DESC`, s, e
  );

  // 每周新增趋势（整月的形状）
  const byWeek = [];
  const seen = new Set();
  let cur = startOfDay(start);
  while (cur < end) {
    const w = isoWeek(cur);
    if (!seen.has(w)) {
      seen.add(w);
      const r = weekRange(w);
      const ws = new Date(Math.max(r.start.getTime(), start.getTime()));
      const we = new Date(Math.min(addDays(r.end, 1).getTime(), end.getTime()));
      byWeek.push({
        week: w,
        n: number(new Date(ws.toISOString()), new Date(we.toISOString())),
      });
    }
    cur = addDays(cur, 7);
  }

  const topRepeat = all(
    `SELECT id, kp_name, error_count, difficulty, stem
       FROM questions WHERE deleted_at IS NULL AND error_count >= 2
      ORDER BY error_count DESC, difficulty DESC LIMIT 6`
  );

  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

  return {
    month: monthKey,
    range: { start: isoDate(start), end: isoDate(new Date(end.getTime() - 1)) },
    new_questions: newQ,
    new_questions_prev: prevNewQ,
    attempts,
    attempts_prev: attemptsPrev,
    correct,
    accuracy: pct(correct, attempts),
    accuracy_prev: pct(correctPrev, attemptsPrev),
    archived,
    promoted,
    key_total: keyTotal,
    active_total: activeTotal,
    by_kp: byKp,
    by_error_type: byType,
    by_week: byWeek,
    top_repeat: topRepeat,
  };
}

function number(a, b) {
  return Number(
    get(
      'SELECT COUNT(*) AS v FROM questions WHERE deleted_at IS NULL AND created_at>=? AND created_at<?',
      a.toISOString(), b.toISOString()
    )?.v ?? 0
  );
}

export function monthDigest(monthKey, limit = 40) {
  const { start, end } = monthRange(monthKey);
  const rows = all(
    `SELECT id, kp_name, error_type, difficulty, status, error_count, stem, error_cause
       FROM questions
      WHERE deleted_at IS NULL AND created_at>=? AND created_at<?
      ORDER BY error_count DESC, difficulty DESC, id DESC
      LIMIT ?`,
    start.toISOString(), end.toISOString(), limit
  );
  return rows
    .map(
      (q) =>
        `#${q.id} [${q.kp_name || '未标注'}|${q.error_type || '未分类'}|难度${q.difficulty || '?'}|错${q.error_count}次|${q.status}]` +
        `\n题干：${(q.stem || '').replace(/\s+/g, ' ').slice(0, 140)}` +
        `\n错因：${(q.error_cause || '未记录').slice(0, 70)}`
    )
    .join('\n\n');
}

export const CONFIG = { ARCHIVE_AFTER_DAYS, SHEET_PER_DAY, ARCHIVE_MIN_REVIEWS, ARCHIVE_MIN_STREAK };
