'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebate-api-'));
  const dbFile = path.join(dir, 'api.db');
  const app = createApp({ dbFile, withSeed: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  const request = async (method, p, options = {}) => {
    const body = options && options.body;
    const res = await fetch(base + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await res.json().catch(() => null);
    return { status: res.status, body: payload };
  };
  return {
    app, dir, base, request,
    close: () => new Promise((resolve) => app.server.close(resolve)),
  };
}

test('HTTP：完整核对流程（事件→段→试算→确认→退货→过期→影响）', async (t) => {
  const srv = await boot();
  t.after(() => srv.close());

  const meta = await srv.request('GET', '/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.body.strategy, 'incremental');
  assert.match(meta.body.disclaimer, /虚构/);

  const segs = await srv.request('GET', '/api/segments?category=' + encodeURIComponent('钢材') + '&period=2026-Q1');
  assert.equal(segs.status, 200);
  assert.equal(segs.body.segments.length, 1);
  const seg = segs.body.segments[0];
  assert.equal(seg.eligible_base_cents, 6_280_000);
  assert.equal(seg.rebate_cents, 157_000);

  const detail = await srv.request('GET', `/api/segments/${seg.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.entities.length, 2);
  assert.ok(detail.body.drill.overstatementCents !== 0);
  assert.equal(detail.body.confirmed.totalCents, 0);

  const snap = await srv.request('POST', `/api/segments/${seg.id}/snapshots`, {
    body: { note: 'API 测试', actor: 'tester' },
  });
  assert.equal(snap.status, 201);
  assert.equal(snap.body.stale, null);
  assert.equal(snap.body.confirmation, null);

  const confirm = await srv.request('POST', `/api/snapshots/${snap.body.id}/confirm`, {
    body: { mode: 'exact', idempotency_key: 'api-k1', actor: 'tester' },
  });
  assert.equal(confirm.status, 201);
  assert.equal(confirm.body.totalAddedCents, 157_000);

  const replay = await srv.request('POST', `/api/snapshots/${snap.body.id}/confirm`, {
    body: { mode: 'exact', idempotency_key: 'api-k1', actor: 'tester' },
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.replayed, true);

  const events = await srv.request('GET', '/api/events?category=' + encodeURIComponent('钢材') + '&period=2026-Q1');
  const purchaseEvent = events.body.events.find((e) => e.event_type === 'purchase');
  const ret = await srv.request('POST', '/api/events', {
    body: {
      event_type: 'return',
      reverses_event_id: purchaseEvent.id,
      amount_cents: 300_000,
      occurred_at: '2026-04-01T00:00:00.000Z',
      note: 'API 虚构退货',
      actor: 'tester',
      client_request_id: 'api-ret-1',
    },
  });
  assert.equal(ret.status, 201);
  assert.equal(ret.body.event.period, '2026-Q1');

  const stale = await srv.request('POST', `/api/snapshots/${snap.body.id}/confirm`, {
    body: { mode: 'topup', idempotency_key: 'api-k2', actor: 'tester' },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale_snapshot');
  assert.equal(stale.body.error.details.reason, 'stale_version');

  const after = await srv.request('GET', `/api/segments/${seg.id}`);
  assert.equal(after.body.segment.rebate_cents, 149_500);
  assert.ok(after.body.confirmed.exposureCents > 0);
  assert.ok(after.body.impacts.length >= 1);
  const impact = after.body.impacts[0];
  assert.equal(impact.delta_rebate_cents, -7_500);
  assert.ok(impact.invalidated_snapshot_ids.includes(snap.body.id));

  const changes = await srv.request('GET', '/api/changes');
  assert.ok(changes.body.changes.some((c) => c.kind === 'return'));

  const consistency = await srv.request('GET', '/api/consistency');
  assert.equal(consistency.status, 200);
  assert.equal(consistency.body.ok, true);
});

test('HTTP：参数校验与错误码', async (t) => {
  const srv = await boot();
  t.after(() => srv.close());

  const groupsRes = await srv.request('GET', '/api/groups');
  const entitiesRes = await srv.request('GET', '/api/entities');
  const suppliersRes = await srv.request('GET', '/api/suppliers');
  const supplierId = suppliersRes.body.suppliers[0].id;
  const entityId = entitiesRes.body.entities[0].id;
  assert.ok(groupsRes.body.groups.length > 0);

  const badPeriod = await srv.request('POST', '/api/events', {
    body: {
      event_type: 'purchase', supplier_id: supplierId, entity_id: entityId, category: '钢材',
      period: '2026-13', amount_cents: 100, actor: 't',
    },
  });
  assert.equal(badPeriod.status, 400);
  assert.equal(badPeriod.body.error.code, 'invalid_period');

  const badAmount = await srv.request('POST', '/api/events', {
    body: {
      event_type: 'purchase', supplier_id: supplierId, entity_id: entityId, category: '钢材',
      period: '2026-Q1', amount_cents: 1.5, actor: 't',
    },
  });
  assert.equal(badAmount.status, 400);
  assert.equal(badAmount.body.error.code, 'invalid_amount');

  const badTier = await srv.request('POST', '/api/contracts', {
    body: {
      name: '坏规则', group_id: groupsRes.body.groups[0].id, category: '测试',
      tiers: [{ threshold_cents: 100, rate_bps: 100 }], actor: 't',
    },
  });
  assert.equal(badTier.status, 400);
  assert.equal(badTier.body.error.code, 'invalid_rule');

  const missing = await srv.request('GET', '/api/segments/does-not-exist');
  assert.equal(missing.status, 404);

  const wrongMethod = await srv.request('DELETE', '/api/segments');
  assert.equal(wrongMethod.status, 405);

  const badJsonRes = await fetch(srv.base + '/api/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops',
  });
  assert.equal(badJsonRes.status, 400);

  const unknownApi = await srv.request('GET', '/api/nope');
  assert.equal(unknownApi.status, 404);
});

test('HTTP：what-if 保存后不能确认，也不影响正式段', async (t) => {
  const srv = await boot();
  t.after(() => srv.close());
  const segs = await srv.request('GET', '/api/segments?period=2026-Q1');
  const seg = segs.body.segments.find((x) => x.category === '钢材');

  const before = seg.rebate_cents;
  const whatIf = await srv.request('POST', `/api/segments/${seg.id}/snapshots`, {
    body: { what_if_tiers: [{ threshold_cents: 0, rate_bps: 700, label: '7%' }], note: '假设', actor: 't' },
  });
  assert.equal(whatIf.status, 201);
  assert.equal(whatIf.body.is_what_if, true);
  assert.notEqual(whatIf.body.rebate_cents, before);

  const confirm = await srv.request('POST', `/api/snapshots/${whatIf.body.id}/confirm`, {
    body: { mode: 'exact', idempotency_key: 'whatif-k', actor: 't' },
  });
  assert.equal(confirm.status, 409);
  assert.equal(confirm.body.error.code, 'what_if_not_confirmable');

  const detail = await srv.request('GET', `/api/segments/${seg.id}`);
  assert.equal(detail.body.segment.rebate_cents, before);
  assert.equal(detail.body.confirmed.totalCents, 0);

  const drill = await srv.request('POST', `/api/segments/${seg.id}/drill`, {
    body: { tiers: [{ threshold_cents: 0, rate_bps: 700 }] },
  });
  assert.equal(drill.status, 201);
  assert.equal(drill.body.deltaRebateCents, drill.body.applied.rebateCents - before);
});

test('HTTP：规则变更创建任务并可分批推进，旧快照失效', async (t) => {
  const srv = await boot();
  t.after(() => srv.close());

  const contracts = await srv.request('GET', '/api/contracts');
  const steel = contracts.body.contracts.find((c) => c.category === '钢材');
  const segs = await srv.request('GET', '/api/segments?period=2026-Q1&category=' + encodeURIComponent('钢材'));
  const snap = await srv.request('POST', `/api/segments/${segs.body.segments[0].id}/snapshots`, {
    body: { actor: 't' },
  });
  assert.equal(snap.body.stale, null);

  const newRule = await srv.request('POST', `/api/contracts/${steel.id}/versions`, {
    body: {
      tiers: [
        { threshold_cents: 0, rate_bps: 200, label: '2%' },
        { threshold_cents: 6_000_000, rate_bps: 350, label: '3.5%' },
      ],
      note: 'API 测试提档',
      actor: 't',
    },
  });
  assert.equal(newRule.status, 201);
  assert.equal(newRule.body.version, 2);
  assert.equal(newRule.body.affectedSegments, 2);
  assert.equal(newRule.body.job.status, 'pending');

  const jobId = newRule.body.job.id;
  const run = await srv.request('POST', `/api/jobs/${jobId}/run`, { body: { batches: 10, actor: 't' } });
  assert.equal(run.status, 201);
  assert.equal(run.body.job.status, 'completed');
  assert.equal(run.body.job.done_items, 2);

  const stale = await srv.request('POST', `/api/snapshots/${snap.body.id}/confirm`, {
    body: { mode: 'exact', idempotency_key: 'after-rule', actor: 't' },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale_snapshot');

  const fresh = await srv.request('POST', `/api/segments/${segs.body.segments[0].id}/snapshots`, {
    body: { actor: 't' },
  });
  assert.equal(fresh.body.stale, null);
  assert.equal(fresh.body.rebate_cents, Math.round(6_280_000 * 0.035));

  const jobs = await srv.request('GET', '/api/jobs');
  assert.ok(jobs.body.jobs.length >= 1);
});

test('HTTP：静态页面可访问，路径穿越被拒绝', async (t) => {
  const srv = await boot();
  t.after(() => srv.close());
  const index = await fetch(srv.base + '/');
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /返利核对台/);
  assert.match(html, /虚构/);
  const css = await fetch(srv.base + '/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const traversal = await fetch(srv.base + '/..%2F..%2Fpackage.json');
  assert.ok([403, 404].includes(traversal.status));
});
