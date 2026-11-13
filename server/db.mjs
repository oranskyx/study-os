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

-- ---------------------------------------------------------------- 试卷
CREATE TABLE IF NOT EXISTS exams (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id     TEXT NOT NULL DEFAULT 'math',
  name           TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'custom',  -- midterm|final|monthly|custom
  exam_date      TEXT NOT NULL,
  full_score     REAL,
  my_score       REAL,
  rank           INTEGER,
  total_students INTEGER,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'staging', -- staging|reviewing|done
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS ix_exam_date ON exams(exam_date);

CREATE TABLE IF NOT EXISTS exam_pages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id     INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  image_path  TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'unknown',  -- paper|answer_sheet|answer_key|graded|mixed|unknown
  role_conf   REAL,
  role_note   TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed
  error       TEXT,
  raw_json    TEXT,
  extracted   INTEGER NOT NULL DEFAULT 0,
  uploaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_exam_page ON exam_pages(exam_id);

CREATE TABLE IF NOT EXISTS exam_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id        INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  page_id        INTEGER REFERENCES exam_pages(id) ON DELETE SET NULL,
  q_no           TEXT NOT NULL,             -- 题号原样：1 / 12 / 21(1)
  qtype          TEXT,                      -- choice|fill|short|essay|calc
  stem           TEXT,
  options_json   TEXT,
  my_answer      TEXT,
  correct_answer TEXT,
  solution       TEXT,
  grading_note   TEXT,
  kp_name        TEXT,
  difficulty     INTEGER,
  score_full     REAL,
  score_got      REAL,
  verdict        TEXT,                      -- right|wrong|partial|unknown
  handwriting    TEXT,                      -- printed|handwritten|mixed
  marks_json     TEXT,                      -- 答题卡涂卡与笔迹：{visible,filled,black,red,teacher,answer_key}
  source         TEXT NOT NULL DEFAULT 'ai',-- ai|manual
  imported_qid   INTEGER,                   -- 已收进错题库的 questions.id
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_exam_item ON exam_items(exam_id);
`);

// 旧库补列：错题要能反查是哪次考试的哪道题
const eiCols = new Set(db.prepare("PRAGMA table_info('exam_items')").all().map((c) => c.name));
if (!eiCols.has('marks_json')) db.exec('ALTER TABLE exam_items ADD COLUMN marks_json TEXT');

const qCols = new Set(db.prepare("PRAGMA table_info('questions')").all().map((c) => c.name));
if (!qCols.has('exam_id')) db.exec('ALTER TABLE questions ADD COLUMN exam_id INTEGER');
if (!qCols.has('exam_item_id')) db.exec('ALTER TABLE questions ADD COLUMN exam_item_id INTEGER');

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

// 其余五科的高一考点（人教版必修）。界面按科目过滤，识别时也把这份清单发给模型挑。
const CHINESE_KPS = [
  ['现代文阅读Ⅰ（信息类文本）', '论述类文本阅读'],
  ['现代文阅读Ⅰ（信息类文本）', '实用类文本阅读'],
  ['现代文阅读Ⅱ（文学类文本）', '散文阅读'],
  ['现代文阅读Ⅱ（文学类文本）', '小说阅读'],
  ['文言文阅读', '实词与虚词'],
  ['文言文阅读', '文言断句'],
  ['文言文阅读', '文化常识'],
  ['文言文阅读', '翻译句子'],
  ['文言文阅读', '内容概括与分析'],
  ['古代诗歌阅读', '形象与意境'],
  ['古代诗歌阅读', '表达技巧'],
  ['古代诗歌阅读', '思想感情'],
  ['名篇名句默写', '理解性默写'],
  ['语言文字运用', '成语与词语辨析'],
  ['语言文字运用', '病句修改'],
  ['语言文字运用', '语句衔接与补写'],
  ['语言文字运用', '修辞与表达效果'],
  ['写作', '审题立意'],
  ['写作', '记叙文写作'],
  ['写作', '议论文写作'],
];

const ENGLISH_KPS = [
  ['语法', '一般时态'],
  ['语法', '完成时态'],
  ['语法', '被动语态'],
  ['语法', '定语从句'],
  ['语法', '名词性从句'],
  ['语法', '状语从句'],
  ['语法', '非谓语动词'],
  ['语法', '主谓一致'],
  ['语法', '情态动词与虚拟语气'],
  ['词汇', '词义辨析与固定搭配'],
  ['词汇', '构词法'],
  ['阅读理解', '主旨大意'],
  ['阅读理解', '细节理解'],
  ['阅读理解', '推理判断'],
  ['阅读理解', '词义猜测'],
  ['完形填空', '语境与逻辑衔接'],
  ['七选五', '语篇结构与衔接'],
  ['语法填空', '词形变化'],
  ['书面表达', '应用文写作'],
  ['书面表达', '读后续写'],
];

const PHYSICS_KPS = [
  ['第一章 运动的描述', '质点、参考系与位移'],
  ['第一章 运动的描述', '速度与加速度'],
  ['第一章 运动的描述', 'v-t 图象'],
  ['第二章 匀变速直线运动', '匀变速直线运动规律'],
  ['第二章 匀变速直线运动', '自由落体与竖直上抛'],
  ['第三章 相互作用', '重力、弹力与摩擦力'],
  ['第三章 相互作用', '力的合成与分解'],
  ['第三章 相互作用', '共点力平衡'],
  ['第四章 牛顿运动定律', '牛顿第一、第三定律'],
  ['第四章 牛顿运动定律', '牛顿第二定律'],
  ['第四章 牛顿运动定律', '超重与失重'],
  ['第四章 牛顿运动定律', '连接体与临界问题'],
  ['第五章 抛体运动', '运动的合成与分解'],
  ['第五章 抛体运动', '平抛运动'],
  ['第六章 圆周运动', '圆周运动与向心力'],
  ['第六章 圆周运动', '生活中的圆周运动'],
  ['第七章 万有引力', '万有引力定律与天体运动'],
  ['第八章 机械能守恒', '功与功率'],
  ['第八章 机械能守恒', '动能定理'],
  ['第八章 机械能守恒', '机械能守恒定律'],
];

const CHEMISTRY_KPS = [
  ['第一章 物质及其变化', '物质的分类与转化'],
  ['第一章 物质及其变化', '离子反应与离子方程式'],
  ['第一章 物质及其变化', '氧化还原反应'],
  ['第二章 海水中的重要元素', '钠及其化合物'],
  ['第二章 海水中的重要元素', '氯及其化合物'],
  ['第二章 海水中的重要元素', '物质的量'],
  ['第二章 海水中的重要元素', '配制一定物质的量浓度溶液'],
  ['第三章 铁 金属材料', '铁及其化合物'],
  ['第三章 铁 金属材料', '金属材料与合金'],
  ['第四章 物质结构 元素周期律', '原子结构与元素周期表'],
  ['第四章 物质结构 元素周期律', '元素周期律'],
  ['第四章 物质结构 元素周期律', '化学键'],
  ['第五章 化工生产中的重要非金属', '硫及其化合物'],
  ['第五章 化工生产中的重要非金属', '氮及其化合物'],
  ['第六章 化学反应与能量', '化学能与热能'],
  ['第六章 化学反应与能量', '原电池'],
  ['第六章 化学反应与能量', '化学反应速率与限度'],
  ['第七章 有机化合物', '甲烷与烷烃'],
  ['第七章 有机化合物', '乙烯与烯烃'],
  ['第七章 有机化合物', '乙醇与乙酸'],
];

const BIOLOGY_KPS = [
  ['第一章 走近细胞', '细胞是生命活动的基本单位'],
  ['第一章 走近细胞', '细胞的多样性与统一性'],
  ['第二章 组成细胞的分子', '蛋白质与氨基酸'],
  ['第二章 组成细胞的分子', '核酸与遗传信息'],
  ['第二章 组成细胞的分子', '糖类与脂质'],
  ['第二章 组成细胞的分子', '水与无机盐'],
  ['第三章 细胞的基本结构', '细胞膜与流动镶嵌模型'],
  ['第三章 细胞的基本结构', '细胞器分工与合作'],
  ['第三章 细胞的基本结构', '细胞核的结构与功能'],
  ['第四章 细胞的物质输入和输出', '被动运输'],
  ['第四章 细胞的物质输入和输出', '主动运输与胞吞胞吐'],
  ['第五章 细胞的能量供应和利用', '酶与 ATP'],
  ['第五章 细胞的能量供应和利用', '细胞呼吸'],
  ['第五章 细胞的能量供应和利用', '光合作用'],
  ['第六章 细胞的生命历程', '细胞的增殖与有丝分裂'],
  ['第六章 细胞的生命历程', '细胞的分化、衰老与凋亡'],
  ['遗传基本规律', '分离定律'],
  ['遗传基本规律', '自由组合定律'],
  ['遗传基本规律', '伴性遗传'],
  ['遗传的分子基础', 'DNA 结构与复制'],
  ['遗传的分子基础', '基因的表达'],
];

const KPS_BY_SUBJECT = {
  math: MATH_KPS,
  chinese: CHINESE_KPS,
  english: ENGLISH_KPS,
  physics: PHYSICS_KPS,
  chemistry: CHEMISTRY_KPS,
  biology: BIOLOGY_KPS,
};

export function seedIfEmpty() {
  const n = get('SELECT COUNT(*) AS c FROM subjects')?.c ?? 0;
  if (n > 0) return false;
  for (const [id, name, sort] of SUBJECTS) {
    insert('subjects', { id, name, sort });
  }
  for (const [sid, list] of Object.entries(KPS_BY_SUBJECT)) {
    for (const [chapter, name] of list) insert('kps', { subject_id: sid, chapter, name });
  }
  return true;
}

/**
 * 补考点：老库里只有数学，其余五科是空的 → 界面上的考点下拉只有数学。
 * 按科目逐个检查，缺哪科补哪科，已有数据不动。
 */
function ensureKps() {
  for (const [sid, list] of Object.entries(KPS_BY_SUBJECT)) {
    const n = get('SELECT COUNT(*) AS c FROM kps WHERE subject_id=?', sid)?.c ?? 0;
    if (n > 0) continue;
    for (const [chapter, name] of list) insert('kps', { subject_id: sid, chapter, name });
  }
}

seedIfEmpty();
ensureKps();
