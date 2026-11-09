// 测试会改配置表；绝不能因此把真实 key 弄丢。
//
// 做法：整表快照 → 跑完还原（单事务，中途失败会回滚，不会留下半张空表），
// 并且挂到进程退出钩子上——Ctrl-C、异常退出都会还原。
//
// 另外提供 hardDeleteQuestions：DELETE 接口是软删除，测试造的题会永久留一行，
// 想真删只能直接改库。

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'), 'study.db');

/** 服务端可能正在写，等一会儿而不是立刻 SQLITE_BUSY */
function open() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export function snapshotSettings() {
  const db = open();
  try {
    return db.prepare('SELECT key, value FROM settings').all();
  } finally {
    db.close();
  }
}

export function restoreSettings(snap) {
  if (!snap) return;
  const db = open();
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('DELETE FROM settings');
    const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const r of snap) ins.run(r.key, r.value);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已经回滚了 */ }
    throw e;
  } finally {
    db.close();
  }
}

/** 真删测试造的题（连带其变式和做题流水） */
export function hardDeleteQuestions(ids = []) {
  if (!ids.length) return 0;
  const db = open();
  try {
    db.exec('BEGIN IMMEDIATE');
    const delV = db.prepare('DELETE FROM variants WHERE question_id = ?');
    const delA = db.prepare('DELETE FROM attempts WHERE question_id = ?');
    const delQ = db.prepare('DELETE FROM questions WHERE id = ?');
    let n = 0;
    for (const id of ids) {
      try {
        delV.run(id);
        delA.run(id);
        delQ.run(id);
        n++;
      } catch { /* 这条已经被删了 */ }
    }
    db.exec('COMMIT');
    return n;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw e;
  } finally {
    db.close();
  }
}

/** 返回 { snap, restore }，restore 幂等 */
export function guardSettings() {
  const snap = snapshotSettings();
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    try { restoreSettings(snap); } catch { /* 服务正在写就算了 */ }
  };
  process.on('exit', restore);
  process.on('SIGINT', () => { restore(); process.exit(130); });
  process.on('SIGTERM', () => { restore(); process.exit(143); });
  return { snap, restore };
}
