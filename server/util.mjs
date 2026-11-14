// 后端共用的小工具。以前 index.mjs 和 exams.mjs 各抄了一份，改一处忘一处。
import { all, get } from './db.mjs';

/** 空字符串 / null / undefined → null；其余 trim 后返回（空串也算 null） */
export const S = (v) => (v === undefined || v === null ? null : String(v).trim() || null);

/** 数字：空/NaN → null */
export const num = (v) =>
  v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);

export function kpList(subjectId = 'math') {
  return all('SELECT id, chapter, name FROM kps WHERE subject_id=? ORDER BY id', subjectId);
}

/** 考点解析：先精确，再包含匹配，最后原样保留（学生可后续补建） */
export function resolveKp(subjectId, rawName) {
  if (!rawName) return { kp_id: null, kp_name: null };
  const name = String(rawName).trim();
  if (!name) return { kp_id: null, kp_name: null };
  const exact = get('SELECT id, name FROM kps WHERE subject_id=? AND name=?', subjectId, name);
  if (exact) return { kp_id: exact.id, kp_name: exact.name };
  const hit = kpList(subjectId).find((k) => k.name.includes(name) || name.includes(k.name));
  if (hit) return { kp_id: hit.id, kp_name: hit.name };
  return { kp_id: null, kp_name: name };
}
