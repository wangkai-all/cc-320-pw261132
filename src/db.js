'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const depths = new WeakMap();
let savepointSeq = 0;

function openDatabase(file) {
  const dbPath = file || process.env.REBATE_DB || path.join(ROOT, 'data', 'rebate.db');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // 先设 busy_timeout，再切换 WAL：多个连接同时首次打开时，切换模式需要短暂写锁。
  db.exec('PRAGMA busy_timeout = 5000;');
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch (err) {
    if (!/locked|busy/i.test(String(err && err.message))) throw err;
    // 另一个连接正在切换；WAL 是持久化设置，稍等后读取现状即可。
    for (let i = 0; i < 20; i++) {
      const mode = db.prepare('PRAGMA journal_mode').get();
      const value = mode ? Object.values(mode)[0] : null;
      if (value === 'wal') break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  depths.set(db, 0);
  return db;
}

/**
 * 嵌套安全事务：最外层使用 BEGIN IMMEDIATE（立即取得写锁，串行化确认请求），
 * 内层使用 SAVEPOINT。任何一层失败都会向上抛出并由最外层整体回滚。
 */
function tx(db, fn) {
  const depth = depths.get(db) || 0;
  let savepoint = null;
  if (depth === 0) {
    db.exec('BEGIN IMMEDIATE');
  } else {
    savepoint = `sp_${++savepointSeq}`;
    db.exec(`SAVEPOINT ${savepoint}`);
  }
  depths.set(db, depth + 1);
  try {
    const result = fn();
    depths.set(db, depth);
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    depths.set(db, depth);
    try {
      if (depth === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${savepoint}`);
      if (depth > 0) db.exec(`RELEASE ${savepoint}`);
    } catch (_) {
      /* 回滚失败不能掩盖原始错误 */
    }
    throw err;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = { openDatabase, tx, nowIso, newId, ROOT };
