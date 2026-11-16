'use strict';

/**
 * 真正的并发测试：多个独立 SQLite 连接（模拟两个服务进程/两个确认请求）
 * 同时确认同一期间段，验证写锁 + 幂等键 + 差额分配不会重复入账。
 *
 * 线程：worker_threads 中各自打开同一数据库文件。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { openDatabase } = require('../src/db');
const { Store } = require('../src/store');
const { LedgerService } = require('../src/ledger');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebate-conc-'));
  const file = path.join(dir, 'conc.db');
  const db = openDatabase(file);
  const store = new Store(db);
  const ledger = new LedgerService(db, store);
  const group = store.createGroup({ name: '并发集团（虚构）', code: 'CG' }, 't');
  const entity = store.createEntity({ name: '实体', code: 'E1' }, 't');
  const supplier = store.createSupplier({ name: '供应商', code: 'S1', group_id: group.id }, 't');
  store.createContract({
    name: '并发合同', group_id: group.id, category: '钢材',
    period_type: 'quarter',
    tiers: [{ threshold_cents: 0, rate_bps: 500, label: '5%' }],
  }, 't');
  store.insertEvent({
    event_type: 'purchase', supplier_id: supplier.id, entity_id: entity.id,
    category: '钢材', period: '2026-Q1', amount_cents: 10_000_000,
    occurred_at: '2026-01-10T00:00:00.000Z', actor: 't', note: '',
  });
  const segment = store.getSegment(group.id, '钢材', '2026-Q1');
  const snapA = store.createSnapshot(segment.id, { actor: 'A' });
  const snapB = store.createSnapshot(segment.id, { actor: 'B' });
  db.close();
  return { dir, file, groupId: group.id, segmentId: segment.id, snapA: snapA.id, snapB: snapB.id };
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { openDatabase } = require('${path.join(__dirname, '..', 'src', 'db.js').replace(/\\/g, '\\\\')}');
const { Store } = require('${path.join(__dirname, '..', 'src', 'store.js').replace(/\\/g, '\\\\')}');
const { LedgerService } = require('${path.join(__dirname, '..', 'src', 'ledger.js').replace(/\\/g, '\\\\')}');
const db = openDatabase(workerData.file);
const store = new Store(db);
const ledger = new LedgerService(db, store);
const out = [];
for (const attempt of workerData.attempts) {
  try {
    const r = ledger.confirm({
      snapshot_id: attempt.snapshot_id,
      mode: attempt.mode,
      idempotency_key: attempt.key,
      actor: attempt.actor,
    });
    out.push({ ok: true, key: attempt.key, added: r.totalAddedCents, replayed: Boolean(r.replayed) });
  } catch (err) {
    out.push({ ok: false, key: attempt.key, code: err.code, message: err.message });
  }
}
db.close();
parentPort.postMessage(out);
`;

function runWorkers(file, plans) {
  return Promise.all(plans.map((attempts) => new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { file, attempts } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
  })));
}

test('两个独立连接同时确认两个快照：同一返利只分配一次', async () => {
  const fx = setup();
  const results = await runWorkers(fx.file, [
    [
      { snapshot_id: fx.snapA, mode: 'exact', key: 'worker-a-1', actor: 'A' },
      { snapshot_id: fx.snapA, mode: 'exact', key: 'worker-a-2', actor: 'A' },
    ],
    [
      { snapshot_id: fx.snapB, mode: 'exact', key: 'worker-b-1', actor: 'B' },
      { snapshot_id: fx.snapB, mode: 'topup', key: 'worker-b-2', actor: 'B' },
    ],
  ]);

  const db = openDatabase(fx.file);
  const store = new Store(db);
  const summary = store.confirmedSummary(fx.segmentId);
  const rows = store.listLedgerEntries(fx.segmentId);
  assert.equal(summary.totalCents, 500_000, '整段应得 5% × 100000.00 = 5000.00 元');
  assert.equal(rows.reduce((s, r) => s + r.amount_cents, 0), 500_000);
  const occurred = results.flat().filter((r) => r.ok && !r.replayed && r.added > 0);
  // 第一个成功分配的请求恰好一个；其余要么无新增、要么被安全拒绝
  assert.equal(occurred.length, 1, `应只有一个请求实际分配金额，实际：${JSON.stringify(results)}`);
  const okSum = results.flat().filter((r) => r.ok).reduce((s, r) => s + (r.added || 0), 0);
  assert.equal(okSum, 500_000, '所有成功响应新增额之和等于整段应得');
  assert.equal(store.consistencyReport().ok, true);
  db.close();
});

test('同一幂等键跨连接并发重放：只入账一次', async () => {
  const fx = setup();
  const results = await runWorkers(fx.file, [
    [{ snapshot_id: fx.snapA, mode: 'exact', key: 'shared-key', actor: 'A' }],
    [{ snapshot_id: fx.snapA, mode: 'exact', key: 'shared-key', actor: 'A' }],
    [{ snapshot_id: fx.snapA, mode: 'exact', key: 'shared-key', actor: 'A' }],
  ]);
  const db = openDatabase(fx.file);
  const store = new Store(db);
  const rows = store.listLedgerEntries(fx.segmentId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_cents, 500_000);
  const succeeded = results.flat().filter((r) => r.ok);
  assert.ok(succeeded.length >= 1);
  assert.ok(results.flat().every((r) => r.ok || ['stale_snapshot', 'already_confirmed'].includes(r.code)));
  db.close();
});
