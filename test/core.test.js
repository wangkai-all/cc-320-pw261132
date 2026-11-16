'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDatabase } = require('../src/db');
const { Store } = require('../src/store');
const { LedgerService } = require('../src/ledger');
const { JobService } = require('../src/jobs');
const { applyTiers, normalizeTiers, perEventMethodSum } = require('../src/rules');
const { allocateProportionally, yuanToCents, centsToYuan } = require('../src/money');
const { digestEvents, xorHex, eventHash } = require('../src/digest');
const { computeSegment } = require('../src/compute');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebate-test-'));
  const file = path.join(dir, 'test.db');
  return { db: openDatabase(file), file, dir };
}

function fixture() {
  const { db, file, dir } = tmpDb();
  const store = new Store(db);
  const ledger = new LedgerService(db, store);
  const jobs = new JobService(db, store);
  const group = store.createGroup({ name: '测试集团（虚构）', code: 'TG' }, 'test');
  const other = store.createGroup({ name: '另一集团（虚构）', code: 'OG' }, 'test');
  const east = store.createEntity({ name: '东区', code: 'EAST' }, 'test');
  const south = store.createEntity({ name: '南区', code: 'SOUTH' }, 'test');
  const supplierA = store.createSupplier({ name: '甲供应商', code: 'SA', group_id: group.id }, 'test');
  const supplierB = store.createSupplier({ name: '乙供应商', code: 'SB', group_id: other.id }, 'test');
  const contract = store.createContract({
    name: '测试钢材合同',
    group_id: group.id,
    category: '钢材',
    period_type: 'quarter',
    tiers: [
      { threshold_cents: 0, rate_bps: 100, label: '1%' },
      { threshold_cents: 1_000_000, rate_bps: 300, label: '3%' },
      { threshold_cents: 5_000_000, rate_bps: 500, label: '5%' },
    ],
  }, 'test');
  return {
    db, file, dir, store, ledger, jobs, group, other, east, south, supplierA, supplierB,
    contractId: contract.contractId,
  };
}

function purchase(f, cents, period = '2026-Q1', entity = null, supplier = null) {
  return f.store.insertEvent({
    event_type: 'purchase',
    supplier_id: (supplier || f.supplierA).id,
    entity_id: (entity || f.east).id,
    category: '钢材',
    period,
    amount_cents: cents,
    occurred_at: `${period.slice(0, 4)}-01-15T00:00:00.000Z`,
    actor: 'test',
    note: '',
  });
}

function returned(f, purchaseEvent, cents) {
  return f.store.insertEvent({
    event_type: 'return',
    supplier_id: purchaseEvent.supplier_id,
    entity_id: purchaseEvent.entity_id,
    category: purchaseEvent.category,
    period: purchaseEvent.period,
    amount_cents: cents,
    occurred_at: '2026-02-01T00:00:00.000Z',
    reverses_event_id: purchaseEvent.id,
    actor: 'test',
    note: '',
  });
}

test('阶梯按整段累计套单档，而不是逐单相加', () => {
  const tiers = [
    { threshold_cents: 0, rate_bps: 100, label: '1%' },
    { threshold_cents: 1_000_000, rate_bps: 300, label: '3%' },
  ];
  const applied = applyTiers(900_000, tiers);
  assert.equal(applied.rebateCents, 9000);
  // 两笔各 45 万分：逐单相加 = 9000，整段跨过 100 万分门槛后 = 135000
  const perOrder = perEventMethodSum([450_000, 450_000], tiers);
  assert.equal(perOrder, 9000);
  const crossed = applyTiers(1_000_000, tiers);
  assert.equal(crossed.rebateCents, 30000);
  assert.equal(crossed.rateBps, 300);
  assert.equal(crossed.tierThresholdCents, 1_000_000);
});

test('两实体共享门槛：跨档改变整段费率并确定性分摊，合计严格相等', () => {
  const f = fixture();
  purchase(f, 600_000, '2026-Q1', f.east);
  purchase(f, 500_000, '2026-Q1', f.south);
  const seg = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  assert.equal(seg.eligible_base_cents, 1_100_000);
  assert.equal(seg.rate_bps, 300);
  assert.equal(seg.rebate_cents, 33_000);
  const shares = f.store
    .getSegmentWithDetails(seg.id).entities;
  assert.equal(shares.reduce((s, e) => s + e.share_cents, 0), seg.rebate_cents);
  // 按 60/50 权重，最大余数法确定性分配
  const byEntity = new Map(shares.map((e) => [e.entity_id, e.share_cents]));
  assert.equal(byEntity.get(f.east.id), 18_000);
  assert.equal(byEntity.get(f.south.id), 15_000);
  assert.equal(f.store.consistencyReport().ok, true);
});

test('退货追溯原期间，历史段返利下降且影响记录可解释', () => {
  const f = fixture();
  const first = purchase(f, 700_000);
  purchase(f, 500_000, '2026-Q1', f.south);
  const before = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  assert.equal(before.rebate_cents, 36_000);
  returned(f, first.event, 400_000);
  const after = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  assert.equal(after.eligible_base_cents, 800_000);
  assert.equal(after.rate_bps, 100);
  assert.equal(after.rebate_cents, 8_000);
  assert.equal(after.version, before.version + 1);

  const change = f.store.getChange(
    f.store.listChanges({ limit: 1 })[0].id
  );
  assert.equal(change.kind, 'return');
  const impact = change.impacts.find((i) => i.segment_id === after.id);
  assert.ok(impact, '退货必须记录对原期间的影响');
  assert.equal(impact.delta_base_cents, -400_000);
  assert.equal(impact.delta_rebate_cents, -28_000);
  assert.equal(impact.before.segment.rebate_cents, 36_000);
  assert.equal(impact.after.segment.rebate_cents, 8_000);
});

test('退货不能超过原采购可退余额，且必须归入原期间', () => {
  const f = fixture();
  const first = purchase(f, 300_000);
  assert.throws(
    () => returned(f, first.event, 300_001),
    (err) => err.code === 'invalid_return'
  );
  returned(f, first.event, 200_000);
  assert.throws(
    () => returned(f, first.event, 100_001),
    (err) => err.code === 'invalid_return'
  );
  returned(f, first.event, 100_000);
  // 另有一笔未退完的采购，用于验证“期间必须追溯原采购期间”
  const second = purchase(f, 500_000, '2026-Q1');
  assert.throws(
    () => f.store.insertEvent({
      event_type: 'return',
      supplier_id: f.supplierA.id,
      entity_id: f.east.id,
      category: '钢材',
      period: '2026-Q3',
      amount_cents: 1,
      occurred_at: '2026-03-01T00:00:00.000Z',
      reverses_event_id: second.event.id,
      actor: 'test',
    }),
    (err) => err.code === 'invalid_return_period'
  );
});

test('试算快照不写台账；旧快照在段变化后被拒绝确认', () => {
  const f = fixture();
  const first = purchase(f, 700_000);
  purchase(f, 400_000, '2026-Q1', f.south);
  const seg = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  const snap = f.store.createSnapshot(seg.id, { actor: 'test' });
  assert.equal(f.store.confirmedSummary(seg.id).totalCents, 0);
  assert.equal(snap.stale, null);
  assert.equal(snap.rebate_cents, 33_000);

  returned(f, first.event, 100_000);
  const stale = f.store.getSnapshot(snap.id);
  assert.ok(stale.stale);
  assert.equal(stale.stale.code, 'stale_version');
  assert.throws(
    () => f.ledger.confirm({
      snapshot_id: snap.id, mode: 'exact', idempotency_key: 'k-stale', actor: 'test',
    }),
    (err) => err.code === 'stale_snapshot' && err.status === 409
  );
  const summary = f.store.confirmedSummary(seg.id);
  assert.equal(summary.totalCents, 0);
});

test('确认幂等：同一幂等键重放不重复分配；不同键第二次只补差额', () => {
  const f = fixture();
  purchase(f, 1_200_000);
  const seg = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  const snap = f.store.createSnapshot(seg.id, { actor: 'test' });
  const first = f.ledger.confirm({
    snapshot_id: snap.id, mode: 'exact', idempotency_key: 'once', actor: 'test',
  });
  assert.equal(first.totalAddedCents, snap.rebate_cents);
  const replay = f.ledger.confirm({
    snapshot_id: snap.id, mode: 'exact', idempotency_key: 'once', actor: 'test',
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.totalAddedCents, first.totalAddedCents);
  assert.equal(f.store.confirmedSummary(seg.id).totalCents, snap.rebate_cents);
});

test('确认与补记并发不会重复分配同一返利', () => {
  const f = fixture();
  purchase(f, 2_000_000);
  const seg = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  const a = f.store.createSnapshot(seg.id, { actor: 'A' });
  const b = f.store.createSnapshot(seg.id, { actor: 'B' });
  const r1 = f.ledger.confirm({ snapshot_id: a.id, mode: 'exact', idempotency_key: 'a1', actor: 'A' });
  assert.equal(r1.totalAddedCents, seg.rebate_cents);
  // 第二个不同快照：不能再次分配同一笔返利；达到目标即不新增
  const r2 = f.ledger.confirm({ snapshot_id: b.id, mode: 'topup', idempotency_key: 'b1', actor: 'B' });
  assert.equal(r2.totalAddedCents, 0);
  assert.equal(f.store.confirmedSummary(seg.id).totalCents, seg.rebate_cents);
  const rows = f.store.listLedgerEntries(seg.id);
  assert.equal(rows.length, 1);
});

test('已确认后新增采购可显式补记到当前应得，且不重复分配', () => {
  const f = fixture();
  purchase(f, 900_000);
  const seg = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  const snap = f.store.createSnapshot(seg.id, { actor: 'test' });
  f.ledger.confirm({ snapshot_id: snap.id, mode: 'exact', idempotency_key: 'c1', actor: 'test' });
  assert.equal(f.store.confirmedSummary(seg.id).totalCents, 9000);
  purchase(f, 200_000);
  const fresh = f.store.createSnapshot(seg.id, { actor: 'test' });
  assert.equal(fresh.stale, null);
  const topup = f.ledger.confirm({ snapshot_id: fresh.id, mode: 'topup', idempotency_key: 'c2', actor: 'test' });
  assert.equal(topup.totalAddedCents, 33_000 - 9000);
  assert.equal(f.store.confirmedSummary(seg.id).totalCents, 33_000);
  const replayTopup = f.ledger.confirm({ snapshot_id: fresh.id, mode: 'topup', idempotency_key: 'c2', actor: 'test' });
  assert.equal(replayTopup.replayed, true);
  assert.equal(f.store.confirmedSummary(seg.id).totalCents, 33_000);
});

test('退货造成确认超额时确认被拒绝，回补需显式且不可超限', () => {
  const f = fixture();
  const first = purchase(f, 1_200_000);
  const seg = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  const snap = f.store.createSnapshot(seg.id, { actor: 'test' });
  f.ledger.confirm({ snapshot_id: snap.id, mode: 'exact', idempotency_key: 'c1', actor: 'test' });
  returned(f, first.event, 400_000);
  const after = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  const summary = f.store.confirmedSummary(after.id);
  assert.ok(summary.exposureCents > 0);
  const fresh = f.store.createSnapshot(after.id, { actor: 'test' });
  assert.throws(
    () => f.ledger.confirm({ snapshot_id: fresh.id, mode: 'exact', idempotency_key: 'c2', actor: 'test' }),
    (err) => err.code === 'clawback_required'
  );
  const entityId = summary.entities[0].entityId;
  assert.throws(
    () => f.ledger.clawback({
      segmentId: after.id, entity_id: entityId,
      amount_cents: summary.totalCents + 1, idempotency_key: 'cb-big', actor: 'test',
    }),
    (err) => err.code === 'exceeds_confirmed'
  );
  const cb = f.ledger.clawback({
    segmentId: after.id, entity_id: entityId,
    amount_cents: summary.exposureCents, idempotency_key: 'cb-ok', actor: 'test',
  });
  assert.equal(cb.clawbackCents, summary.exposureCents);
  assert.equal(f.store.confirmedSummary(after.id).exposureCents, 0);
  // 回补后不会把已确认净额变为负数
  assert.ok(f.store.confirmedSummary(after.id).totalCents >= 0);
});

test('台账只追加：数据库触发器拒绝修改与删除', () => {
  const f = fixture();
  purchase(f, 1_200_000);
  const seg = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  const snap = f.store.createSnapshot(seg.id, { actor: 'test' });
  f.ledger.confirm({ snapshot_id: snap.id, mode: 'exact', idempotency_key: 'c1', actor: 'test' });
  assert.throws(() => f.db.exec("UPDATE confirmed_entries SET amount_cents = 1"));
  assert.throws(() => f.db.exec('DELETE FROM confirmed_entries'));
});

test('增量维护与全量重算在各类写入后逐分一致', () => {
  const f = fixture();
  const a = purchase(f, 800_000);
  purchase(f, 300_000, '2026-Q1', f.south);
  purchase(f, 4_000_000, '2026-Q2');
  returned(f, a.event, 250_000);
  assert.equal(f.store.consistencyReport().ok, true);

  f.store.setStrategy('recompute', 'test');
  const b = purchase(f, 1_500_000);
  returned(f, b.event, 500_000);
  assert.equal(f.store.consistencyReport().ok, true);
  f.store.setStrategy('incremental', 'test');
  purchase(f, 200_000);
  assert.equal(f.store.consistencyReport().ok, true);
});

test('规则变更：旧规则段按新费率整段重算，旧试算过期，任务可暂停恢复', () => {
  const f = fixture();
  purchase(f, 600_000, '2026-Q1');
  purchase(f, 400_000, '2026-Q2');
  purchase(f, 1_200_000, '2026-Q3');
  const q1Before = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  const snap = f.store.createSnapshot(q1Before.id, { actor: 'test' });
  const rv = f.store.createRuleVersion(f.contractId, {
    tiers: [
      { threshold_cents: 0, rate_bps: 200, label: '2%' },
      { threshold_cents: 1_000_000, rate_bps: 400, label: '4%' },
    ],
    note: '测试提档',
  }, 'test');
  const created = f.jobs.createRuleChangeJob(
    { ...rv.contract, currentVersion: rv.version }, rv.ruleVersionId, 'test'
  );
  assert.equal(created.job.total_items, 3);
  assert.equal(created.job.strategy, 'incremental');

  const paused = f.jobs.pauseJob(created.job.id, 'test');
  assert.equal(paused.status, 'paused');
  const partial = f.jobs.runJob(created.job.id, { batches: 1 });
  assert.equal(partial.job.done_items, 0);

  f.jobs.resumeJob(created.job.id, 'test');
  const firstBatch = f.jobs.runJob(created.job.id, { batches: 1 });
  assert.ok(firstBatch.job.done_items > 0);
  assert.equal(firstBatch.job.done_items, Math.min(2, created.job.total_items));
  const final = f.jobs.runJob(created.job.id, { batches: 10 });
  assert.equal(final.job.status, 'completed');
  assert.equal(final.job.done_items, 3);

  const q1 = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  // 60 万分 → 新规则 2% = 12000
  assert.equal(q1.rebate_cents, 12_000);
  assert.equal(q1.rate_bps, 200);
  assert.equal(q1.dirty, 0);
  assert.ok(f.store.getSnapshot(snap.id).stale);
  assert.equal(f.store.consistencyReport().ok, true);

  // 已完成任务重入是幂等的
  const again = f.jobs.runJob(created.job.id, { batches: 5 });
  assert.equal(again.job.done_items, 3);
});

test('重算任务中断后从 pending 继续，完成项不重复处理', () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    purchase(f, 200_000 + i * 10_000, `2026-Q${(i % 4) + 1}`, i % 2 ? f.east : f.south);
  }
  const rv = f.store.createRuleVersion(f.contractId, {
    tiers: [
      { threshold_cents: 0, rate_bps: 500, label: '5%' },
    ],
    note: '单一档',
  }, 'test');
  const created = f.jobs.createRuleChangeJob(
    { ...rv.contract, currentVersion: rv.version }, rv.ruleVersionId, 'test'
  );
  const jobId = created.job.id;
  f.jobs.runJob(jobId, { batches: 1 });
  const mid = f.jobs.getJob(jobId);
  const doneFirst = mid.done_items;
  assert.ok(doneFirst > 0 && doneFirst < mid.total_items);
  // 模拟进程中断后重新启动：任务记录已在库中，继续推进剩余项
  const resumed = f.jobs.runJob(jobId, { batches: 20 });
  assert.equal(resumed.job.status, 'completed');
  const items = f.jobs.getJob(jobId).items;
  assert.equal(items.filter((i) => i.status === 'done').length, items.length);
  // 任务计数与逐项状态一致：没有重复累加，也没有漏项
  assert.equal(resumed.job.done_items, items.length);
  assert.equal(resumed.job.batches_done, mid.batches_done + resumed.batches.length);
  assert.ok(items.every((i) => i.processed_at && i.status === 'done'));
  // 任务影响记录与逐段结果一致
  const change = f.store.getChange(created.changeId);
  assert.equal(change.impacts.length, items.length);
  assert.equal(f.store.consistencyReport().ok, true);
});

test('供应商归属更正同时影响原集团与目标集团，并保留历史', () => {
  const f = fixture();
  purchase(f, 700_000, '2026-Q1');
  purchase(f, 400_000, '2026-Q2');
  const before = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  const moved = f.store.moveSupplier({
    supplier_id: f.supplierA.id,
    group_id: f.other.id,
    reason: '测试归属更正',
    idempotency_key: 'mv-1',
    actor: 'test',
  });
  assert.equal(moved.change.impacts.length, 4); // 2 段 × 原/新集团
  const originalQ1 = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  assert.equal(originalQ1.eligible_base_cents, 0);
  assert.equal(originalQ1.rebate_cents, 0);
  const newQ1 = f.store.getSegment(f.other.id, '钢材', '2026-Q1');
  assert.equal(newQ1.eligible_base_cents, 700_000);
  // 新集团没有合同 → 0% 演示费率，返利为 0，但金额与段仍然存在
  assert.equal(newQ1.rebate_cents, 0);
  const history = f.db.prepare('SELECT * FROM supplier_group_history WHERE supplier_id = ?').all(f.supplierA.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].from_group_id, f.group.id);
  assert.equal(history[0].to_group_id, f.other.id);
  assert.ok(before.rebate_cents > 0);
  assert.equal(f.store.consistencyReport().ok, true);
});

test('试算（what-if）快照不可确认，且不改变正式聚合', () => {
  const f = fixture();
  purchase(f, 1_200_000);
  const seg = f.store.getSegment(f.group.id, '钢材', '2026-Q1');
  const snap = f.store.createSnapshot(seg.id, {
    actor: 'test',
    whatIfTiers: [
      { threshold_cents: 0, rate_bps: 800, label: '8%' },
    ],
  });
  assert.equal(snap.is_what_if, 1);
  assert.equal(snap.rebate_cents, 96_000);
  assert.equal(f.store.getSegment(f.group.id, '钢材', '2026-Q1').rebate_cents, seg.rebate_cents);
  assert.throws(
    () => f.ledger.confirm({ snapshot_id: snap.id, mode: 'exact', idempotency_key: 'w1', actor: 'test' }),
    (err) => err.code === 'what_if_not_confirmable'
  );
  assert.equal(f.store.confirmedSummary(seg.id).totalCents, 0);
});

test('金额与分摊的确定性：整数分、最大余数法、可交换摘要', () => {
  assert.equal(yuanToCents('1,234.56'), 123456);
  assert.equal(yuanToCents(12.3), 1230);
  assert.equal(centsToYuan(123456), '1234.56');
  const { allocations } = allocateProportionally(100, [
    { key: 'c', weight: 1 }, { key: 'a', weight: 1 }, { key: 'b', weight: 1 },
  ]);
  assert.equal([...allocations.values()].reduce((s, x) => s + x, 0), 100);
  assert.equal(allocations.get('a'), 34);
  assert.equal(allocations.get('b'), 33);
  assert.equal(allocations.get('c'), 33);

  const e1 = {
    id: 'p1', event_type: 'purchase', amount_cents: 100, entity_id: 'e',
    category: 'c', period: '2026-Q1', status: 'active',
  };
  const e2 = { ...e1, id: 'p2', amount_cents: 200 };
  assert.equal(digestEvents([e1, e2]), digestEvents([e2, e1]));
  assert.equal(xorHex(eventHash(e1), eventHash(e1)), '0'.repeat(32));
  const rule = normalizeTiers([{ threshold_cents: 0, rate_bps: 100 }]);
  assert.deepEqual(rule.tiers[0].label, '1%');
  const computed = computeSegment({
    groupId: 'g', category: 'c', period: '2026-Q1',
    rule: { ruleVersionId: 1, tiers: rule.tiers },
    events: [e1, e2],
  });
  assert.equal(computed.eligibleBaseCents, 300);
  assert.equal(computed.rebateCents, 3);
});

test('非法规则被拒绝：门槛起点非零、费率下降、重复门槛', () => {
  assert.ok(normalizeTiers([{ threshold_cents: 100, rate_bps: 100 }]).error);
  assert.ok(normalizeTiers([
    { threshold_cents: 0, rate_bps: 300 },
    { threshold_cents: 100, rate_bps: 200 },
  ]).error);
  assert.ok(normalizeTiers([
    { threshold_cents: 0, rate_bps: 100 },
    { threshold_cents: 0, rate_bps: 200 },
  ]).error);
  assert.ok(normalizeTiers([]).error);
  assert.equal(normalizeTiers([
    { threshold_cents: 0, rate_bps: 100 },
    { threshold_cents: 0.5, rate_bps: 200 },
  ]).error !== undefined, true);
});
