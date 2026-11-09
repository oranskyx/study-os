// 数据层：SQLite（Node 内置 node:sqlite，零原生依赖，不需要编译）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'study.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

// ---------------------------------------------------------------- helpers
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function insert(table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys
    .map(() => '?')
    .join(',')})`;
  const info = db.prepare(sql).run(...keys.map((k) => normalize(row[k])));
  return Number(info.lastInsertRowid);
}

export function update(table, id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`;
  db.prepare(sql).run(...keys.map((k) => normalize(patch[k])), id);
}

// node:sqlite 只接受 number/string/bigint/null/Uint8Array
function normalize(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  return JSON.stringify(v);
}

export const nowISO = () => new Date().toISOString();

// ---------------------------------------------------------------- schema
db.exec(`
CREATE TABLE IF NOT EXISTS subjects (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id TEXT NOT NULL,
  chapter    TEXT,
  name       TEXT NOT NULL,
  UNIQUE(subject_id, name)
);

CREATE TABLE IF NOT EXISTS pages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id  TEXT NOT NULL DEFAULT 'math',
  image_path  TEXT NOT NULL,
  bytes       INTEGER,
  uploaded_at TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed
  error       TEXT,
  raw_json    TEXT,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id      TEXT NOT NULL DEFAULT 'math',
  page_id         INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  kp_id           INTEGER,
  kp_name         TEXT,
  stem            TEXT NOT NULL,
  my_answer       TEXT,
  correct_answer  TEXT,
  solution        TEXT,
  error_cause     TEXT,
  error_cause_ai  TEXT,
  error_type      TEXT,          -- 概念|计算|审题|方法|记忆|表达
  difficulty      INTEGER,       -- 1..5
  status          TEXT NOT NULL DEFAULT 'first',  -- first|key|archived
  error_count     INTEGER NOT NULL DEFAULT 1,
  correct_streak  INTEGER NOT NULL DEFAULT 0,
  review_count    INTEGER NOT NULL DEFAULT 0,
  variant_mode    TEXT NOT NULL DEFAULT 'ai',     -- ai|textbook
  first_error_at  TEXT NOT NULL,
  last_error_at   TEXT NOT NULL,
  last_review_at  TEXT,
  next_review_at  TEXT,
  archived_at     TEXT,
  archive_reason  TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX IF NOT EXISTS ix_q_status ON questions(status);
CREATE INDEX IF NOT EXISTS ix_q_next   ON questions(next_review_at);
CREATE INDEX IF NOT EXISTS ix_q_kp     ON questions(kp_id);

CREATE TABLE IF NOT EXISTS attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  result      TEXT NOT NULL,     -- correct|wrong
  via         TEXT,              -- sheet|app
  note        TEXT
);
CREATE INDEX IF NOT EXISTS ix_att_q ON attempts(question_id);

CREATE TABLE IF NOT EXISTS variants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,    -- same|trap|layered|cross
  tier         TEXT,             -- 基础|中档|压轴
  stem         TEXT NOT NULL,
  answer       TEXT,
  solution     TEXT,
  source       TEXT NOT NULL DEFAULT 'ai',   -- ai|textbook
  ref          TEXT,             -- 教辅书名/页码/题号
  verdict      TEXT,             -- good|too_hard|too_easy|wrong
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_v_q ON variants(question_id);

CREATE TABLE IF NOT EXISTS sheets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  week       TEXT NOT NULL UNIQUE,      -- 2026-W45
  created_at TEXT NOT NULL,
  printed_at TEXT,
  status     TEXT NOT NULL DEFAULT 'draft'   -- draft|printed|returned
);

CREATE TABLE IF NOT EXISTS sheet_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id    INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  day         INTEGER NOT NULL,   -- 1..5 代表周一到周五
  position    INTEGER NOT NULL,
  result      TEXT,               -- null|correct|wrong
  filled_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_si_sheet ON sheet_items(sheet_id);

CREATE TABLE IF NOT EXISTS methods (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id TEXT,
  kp_id      INTEGER,
  kp_name    TEXT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  status     TEXT NOT NULL DEFAULT 'active',   -- active|revised|dropped
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,     -- weekly|monthly
  period     TEXT NOT NULL,     -- 2026-W45 / 2026-11
  body_md    TEXT NOT NULL,
  data_json  TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(kind, period)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---------------------------------------------------------------- seed
const SUBJECTS = [
  ['math', '数学', 1],
  ['chinese', '语文', 2],
  ['english', '英语', 3],
  ['physics', '物理', 4],
  ['chemistry', '化学', 5],
  ['biology', '生物', 6],
];

const MATH_KPS = [
  ['第一章 集合与常用逻辑用语', '集合的概念与表示'],
  ['第一章 集合与常用逻辑用语', '集合间的基本关系'],
  ['第一章 集合与常用逻辑用语', '集合的基本运算'],
  ['第一章 集合与常用逻辑用语', '充分条件与必要条件'],
  ['第一章 集合与常用逻辑用语', '全称量词与存在量词'],
  ['第二章 一元二次函数、方程和不等式', '不等式性质与比较大小'],
  ['第二章 一元二次函数、方程和不等式', '基本不等式'],
  ['第二章 一元二次函数、方程和不等式', '一元二次不等式'],
  ['第二章 一元二次函数、方程和不等式', '一元二次函数与方程'],
  ['第三章 函数的概念与性质', '函数的概念及其表示'],
  ['第三章 函数的概念与性质', '分段函数'],
  ['第三章 函数的概念与性质', '函数的单调性与最值'],
  ['第三章 函数的概念与性质', '函数的奇偶性'],
  ['第三章 函数的概念与性质', '幂函数'],
  ['第三章 函数的概念与性质', '函数模型及其应用'],
  ['第四章 指数函数与对数函数', '指数与指数幂运算'],
  ['第四章 指数函数与对数函数', '指数函数图象与性质'],
  ['第四章 指数函数与对数函数', '对数与对数运算'],
  ['第四章 指数函数与对数函数', '对数函数图象与性质'],
  ['第四章 指数函数与对数函数', '指对幂比较大小'],
  ['第四章 指数函数与对数函数', '函数的零点与二分法'],
  ['第五章 三角函数', '任意角与弧度制'],
  ['第五章 三角函数', '任意角的三角函数'],
  ['第五章 三角函数', '同角三角函数基本关系'],
  ['第五章 三角函数', '诱导公式'],
  ['第五章 三角函数', '三角函数的图象与性质'],
  ['第五章 三角函数', '函数 y=Asin(ωx+φ)'],
  ['第五章 三角函数', '三角恒等变换'],
];

export function seedIfEmpty() {
  const n = get('SELECT COUNT(*) AS c FROM subjects')?.c ?? 0;
  if (n > 0) return false;
  for (const [id, name, sort] of SUBJECTS) {
    insert('subjects', { id, name, sort });
  }
  for (const [chapter, name] of MATH_KPS) {
    insert('kps', { subject_id: 'math', chapter, name });
  }
  return true;
}

seedIfEmpty();
