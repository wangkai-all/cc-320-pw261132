'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { openDatabase } = require('./db');
const { Store } = require('./store');
const { LedgerService } = require('./ledger');
const { JobService } = require('./jobs');
const { AppError, fail } = require('./errors');
const { seed } = require('./seed');
const validate = require('./validate');
const { formatCny, centsToYuan, yuanToCents, isValidPeriod } = require('./money');

const PUBLIC = path.join(__dirname, '..', 'public');
const MAX_BODY = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new AppError('payload_too_large', '请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new AppError('invalid_json', '请求体必须是 JSON 对象', 400));
          return;
        }
        resolve(parsed);
      } catch (e) {
        reject(new AppError('invalid_json', '请求体不是合法 JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

function serializeSnapshot(snap) {
  if (!snap) return null;
  return {
    id: snap.id,
    segment_id: snap.segment_id,
    segment_version: snap.segment_version,
    rule_version_id: snap.rule_version_id,
    eligible_base_cents: snap.eligible_base_cents,
    rebate_cents: snap.rebate_cents,
    rate_bps: snap.rate_bps,
    tier_label: snap.tier_label,
    tier_threshold_cents: snap.tier_threshold_cents,
    tiers: snap.tiers,
    allocation: snap.allocation,
    is_what_if: Boolean(snap.is_what_if),
    confirmable: Boolean(snap.confirmable),
    status: snap.status,
    actor: snap.actor,
    created_at: snap.created_at,
    stale: snap.stale,
    confirmation: snap.confirmation,
    display: {
      rebate: formatCny(snap.rebate_cents),
      base: formatCny(snap.eligible_base_cents),
      rate: `${(snap.rate_bps / 100).toFixed(2)}%`,
    },
  };
}

function serializeSegment(sg) {
  return {
    ...sg,
    dirty: Boolean(sg.dirty),
    display: {
      base: formatCny(sg.eligible_base_cents),
      rebate: formatCny(sg.rebate_cents),
      confirmed: formatCny(sg.confirmed_cents || 0),
      rate: `${(sg.rate_bps / 100).toFixed(2)}%`,
    },
  };
}

function createApp({ dbFile = process.env.REBATE_DB, withSeed = false } = {}) {
  const db = openDatabase(dbFile);
  const store = new Store(db);
  const ledger = new LedgerService(db, store);
  const jobs = new JobService(db, store);
  if (withSeed && store.listGroups().length === 0) seed(db);

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:[A-Za-z0-9_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$'
    );
    routes.push({ method, re, keys, handler });
  };

  // ---------- 元信息与基础资料 ----------

  route('GET', '/api/meta', () => {
    const summary = store.listSegments();
    return {
      disclaimer: store.getMeta('demo_disclaimer') ||
        '本应用全部为虚构演示数据与虚构金额，仅用于产品与技术演示，不构成税务、法律或会计意见。',
      strategy: store.strategy(),
      counts: {
        groups: store.listGroups().length,
        suppliers: store.listSuppliers().length,
        entities: store.listEntities().length,
        contracts: store.listContracts().length,
        events: store.listEvents({ limit: 1000 }).length,
        segments: summary.length,
      },
      periods: store.listPeriods(),
      categories: [...new Set(store.listSegments().map((s) => s.category))],
      currency: 'CNY',
    };
  });

  route('GET', '/api/groups', () => ({ groups: store.listGroups() }));
  route('POST', '/api/groups', (ctx) => {
    const input = validate.groupInput(ctx.body);
    return store.createGroup(input, ctx.actor);
  });
  route('GET', '/api/suppliers', () => ({ suppliers: store.listSuppliers() }));
  route('POST', '/api/suppliers', (ctx) => {
    const input = validate.supplierInput(ctx.body);
    return store.createSupplier(input, ctx.actor);
  });
  route('GET', '/api/entities', () => ({ entities: store.listEntities() }));
  route('POST', '/api/entities', (ctx) => {
    const input = validate.entityInput(ctx.body);
    return store.createEntity(input, ctx.actor);
  });
  route('POST', '/api/suppliers/:id/move', (ctx) => {
    const body = { ...ctx.body, supplier_id: ctx.params.id };
    const input = validate.supplierMoveInput(body);
    return store.moveSupplier(input);
  });

  // ---------- 合同 ----------

  route('GET', '/api/contracts', () => ({
    contracts: store.listContracts().map((c) => ({
      ...c,
      tiers: c.tiers,
      display: c.tiers.map((t) => ({
        threshold: formatCny(t.threshold_cents),
        rate: `${(t.rate_bps / 100).toFixed(2)}%`,
      })),
    })),
  }));

  route('POST', '/api/contracts', (ctx) => {
    const input = validate.contractInput(ctx.body);
    const result = store.createContract(input, ctx.actor);
    // 合同首次生效时，历史采购段需要按新阶梯重算；创建可恢复任务而不是同步扫全表。
    const created = store.listContracts().find((c) => c.id === result.contractId);
    const job = result.affectedSegments > 0
      ? jobs.createRuleChangeJob(created, result.ruleVersionId, ctx.actor)
      : { job: null };
    return {
      ...result,
      job: job.job ? jobs.getJob(job.job.id) : null,
    };
  });

  route('GET', '/api/contracts/:id/versions', (ctx) => {
    return { versions: store.listRuleVersions(ctx.params.id) };
  });

  route('POST', '/api/contracts/:id/versions', (ctx) => {
    const input = validate.ruleInput(ctx.body);
    const result = store.createRuleVersion(ctx.params.id, input, ctx.actor);
    const jobResult = jobs.createRuleChangeJob(
      { ...result.contract, currentVersion: result.version, name: result.contract.name },
      result.ruleVersionId,
      ctx.actor
    );
    return {
      ruleVersionId: result.ruleVersionId,
      version: result.version,
      affectedSegments: result.affectedSegments,
      job: jobResult.job ? jobs.getJob(jobResult.job.id) : null,
    };
  });

  // ---------- 事件 ----------

  route('GET', '/api/events', (ctx) => {
    const events = store.listEvents({
      groupId: ctx.query.group_id,
      category: ctx.query.category,
      period: ctx.query.period,
      supplierId: ctx.query.supplier_id,
      entityId: ctx.query.entity_id,
      limit: ctx.query.limit,
    });
    return {
      events: events.map((e) => ({
        ...e,
        display: {
          amount: formatCny(e.amount_cents),
          type: e.event_type === 'return' ? '退货' : '采购',
        },
      })),
    };
  });

  route('POST', '/api/events', (ctx) => {
    const input = validate.eventInput(ctx.body);
    return store.insertEvent(input);
  });

  // ---------- 期间段 ----------

  route('GET', '/api/segments', (ctx) => {
    const segments = store.listSegments({
      groupId: ctx.query.group_id,
      category: ctx.query.category,
      period: ctx.query.period,
      dirtyOnly: ctx.query.dirty === '1',
    });
    return { segments: segments.map(serializeSegment) };
  });

  route('GET', '/api/segments/:id', (ctx) => {
    const details = store.getSegmentWithDetails(ctx.params.id);
    if (!details) fail('not_found', '期间段不存在', 404);
    const seg = details.segment;
    return {
      segment: serializeSegment({ ...seg, confirmed_cents: details.confirmed.totalCents }),
      rule: {
        contract_id: details.rule.contract ? details.rule.contract.id : null,
        contract_name: details.rule.contract ? details.rule.contract.name : null,
        rule_version_id: details.rule.ruleVersionId,
        version: details.rule.version,
        note: details.rule.note,
        tiers: details.rule.tiers.map((t) => ({
          ...t,
          threshold_display: formatCny(t.threshold_cents),
          rate_display: `${(t.rate_bps / 100).toFixed(2)}%`,
        })),
      },
      entities: details.entities.map((e) => ({
        ...e,
        display: {
          base: formatCny(e.base_cents),
          share: formatCny(e.share_cents),
          gross: formatCny(e.gross_cents),
          returns: formatCny(e.returns_cents),
        },
      })),
      events: details.events.map((e) => ({
        ...e,
        display: { amount: formatCny(e.amount_cents), type: e.event_type === 'return' ? '退货' : '采购' },
      })),
      confirmed: {
        ...details.confirmed,
        display: {
          total: formatCny(details.confirmed.totalCents),
          rebate: formatCny(details.confirmed.rebateCents),
          exposure: formatCny(details.confirmed.exposureCents),
          outstanding: formatCny(details.confirmed.outstandingCents),
        },
      },
      exposure: details.exposure
        ? { ...details.exposure, display: { exposure: formatCny(details.exposure.exposure_cents) } }
        : null,
      snapshots: details.snapshots.map(serializeSnapshot),
      impacts: details.impacts,
      ledger: details.ledger,
      drill: {
        ...details.drill,
        display: {
          base: formatCny(details.drill.baseCents),
          applied: formatCny(details.drill.applied.rebateCents),
          perOrder: formatCny(details.drill.perOrderMethod.rebateCents),
          overstatement: formatCny(details.drill.overstatementCents),
          nextTier: details.drill.nextTier
            ? {
                ...details.drill.nextTier,
                gap: formatCny(details.drill.nextTier.gapCents),
                projected: formatCny(details.drill.nextTier.projectedRebateCents),
                incremental: formatCny(details.drill.nextTier.incrementalRebateCents),
              }
            : null,
        },
      },
    };
  });

  route('POST', '/api/segments/:id/drill', (ctx) => {
    const details = store.getSegmentWithDetails(ctx.params.id);
    if (!details) fail('not_found', '期间段不存在', 404);
    // 可选择任意门槛做假设钻取，不写回、不影响正式段。
    const whatIfTiers = Array.isArray(ctx.body.tiers) ? ctx.body.tiers : null;
    if (!whatIfTiers) return details.drill;
    const { normalizeTiers, applyTiers } = require('./rules');
    const normalized = normalizeTiers(whatIfTiers);
    if (normalized.error) fail('invalid_rule', normalized.error, 400, normalized.details);
    const applied = applyTiers(details.segment.eligible_base_cents, normalized.tiers);
    return {
      baseCents: details.segment.eligible_base_cents,
      applied,
      comparedTo: {
        rateBps: details.segment.rate_bps,
        rebateCents: details.segment.rebate_cents,
      },
      deltaRebateCents: applied.rebateCents - details.segment.rebate_cents,
    };
  });

  route('POST', '/api/segments/:id/snapshots', (ctx) => {
    const body = ctx.body;
    if (body.what_if_tiers !== undefined && !Array.isArray(body.what_if_tiers)) {
      fail('invalid_field', 'what_if_tiers 必须是数组', 400, { field: 'what_if_tiers' });
    }
    const whatIf = Array.isArray(body.what_if_tiers) ? body.what_if_tiers : null;
    const snap = store.createSnapshot(ctx.params.id, {
      note: validate.text(body.note, 'note', { max: 300, required: false }),
      actor: ctx.actor,
      whatIfTiers: whatIf,
      label: body.label,
    });
    return serializeSnapshot(snap);
  });

  route('GET', '/api/snapshots/:id', (ctx) => {
    const snap = store.getSnapshot(ctx.params.id);
    if (!snap) fail('not_found', '快照不存在', 404);
    return serializeSnapshot(snap);
  });

  route('POST', '/api/snapshots/:id/confirm', (ctx) => {
    const input = validate.confirmInput({ ...ctx.body, snapshot_id: ctx.params.id });
    return ledger.confirm(input);
  });

  route('POST', '/api/segments/:id/clawback', (ctx) => {
    const body = ctx.body;
    if (!Number.isSafeInteger(body.amount_cents) || body.amount_cents <= 0) {
      fail('invalid_amount', 'amount_cents 必须是正整数分', 400, { field: 'amount_cents' });
    }
    return ledger.clawback({
      segmentId: ctx.params.id,
      entity_id: validate.text(body.entity_id, 'entity_id', { max: 80 }),
      amount_cents: body.amount_cents,
      idempotency_key: validate.text(body.idempotency_key, 'idempotency_key', { max: 120 }),
      actor: ctx.actor,
      note: validate.text(body.note, 'note', { max: 300, required: false }),
    });
  });

  // ---------- 变更与影响 ----------

  route('GET', '/api/changes', (ctx) => ({
    changes: store.listChanges({ limit: ctx.query.limit, supplierId: ctx.query.supplier_id }),
  }));

  route('GET', '/api/changes/:id', (ctx) => {
    const change = store.getChange(ctx.params.id);
    if (!change) fail('not_found', '变更不存在', 404);
    return change;
  });

  route('GET', '/api/suppliers/:id/history', (ctx) => ({
    history: db.prepare(
      `SELECT h.*, fg.name AS from_group_name, tg.name AS to_group_name
       FROM supplier_group_history h
       JOIN supplier_groups fg ON fg.id = h.from_group_id
       JOIN supplier_groups tg ON tg.id = h.to_group_id
       WHERE h.supplier_id = ? ORDER BY h.changed_at`
    ).all(ctx.params.id),
    events: store.listEvents({ supplierId: ctx.params.id, limit: 500 }),
  }));

  // ---------- 重算任务 ----------

  route('GET', '/api/jobs', (ctx) => ({ jobs: jobs.listJobs(ctx.query.limit) }));
  route('GET', '/api/jobs/:id', (ctx) => {
    const job = jobs.getJob(ctx.params.id);
    if (!job) fail('not_found', '任务不存在', 404);
    return job;
  });
  route('POST', '/api/jobs/:id/run', (ctx) => {
    const result = jobs.runJob(ctx.params.id, {
      batches: Number(ctx.body.batches) || 50,
      actor: ctx.actor,
    });
    return result;
  });
  route('POST', '/api/jobs/:id/pause', (ctx) => jobs.pauseJob(ctx.params.id, ctx.actor));
  route('POST', '/api/jobs/:id/resume', (ctx) => jobs.resumeJob(ctx.params.id, ctx.actor));
  route('POST', '/api/jobs/full-recompute', (ctx) => {
    const created = jobs.createFullRecomputeJob(ctx.actor, ctx.body.note || '');
    if (!created.job) return { job: null, empty: true };
    const run = jobs.runJob(created.job.id, { batches: Number(ctx.body.batches) || 200, actor: ctx.actor });
    return { job: run.job, changeId: null };
  });

  // ---------- 设置、审计、一致性 ----------

  route('GET', '/api/settings', () => ({ strategy: store.strategy() }));
  route('POST', '/api/settings/strategy', (ctx) => {
    const value = validate.text(ctx.body.strategy, 'strategy', { max: 20 });
    return { strategy: store.setStrategy(value, ctx.actor) };
  });
  route('GET', '/api/consistency', () => store.consistencyReport());
  route('GET', '/api/audit', (ctx) => ({
    audit: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(Math.min(Number(ctx.query.limit) || 60, 200)),
  }));

  route('GET', '/api/export', () => {
    const payload = {
      exported_at: new Date().toISOString(),
      disclaimer: store.getMeta('demo_disclaimer'),
      groups: store.listGroups(),
      suppliers: store.listSuppliers(),
      entities: store.listEntities(),
      contracts: store.listContracts(),
      rule_versions: db.prepare('SELECT * FROM contract_rule_versions ORDER BY id').all(),
      rule_tiers: db.prepare('SELECT * FROM contract_tiers ORDER BY id').all(),
      events: store.listEvents({ limit: 1000 }),
      segments: store.listSegments(),
      snapshots: db.prepare('SELECT * FROM calc_snapshots ORDER BY created_at').all(),
      ledger: db.prepare('SELECT * FROM confirmed_entries ORDER BY created_at').all(),
      changes: store.listChanges({ limit: 200 }),
      jobs: jobs.listJobs(100),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    return payload;
  });

  // ---------- HTTP 分发 ----------

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return json(res, 400, { error: { code: 'bad_url', message: '非法 URL' } });
    }
    const pathname = decodeURIComponent(url.pathname);
    const query = Object.fromEntries(url.searchParams.entries());
    if (pathname.startsWith('/api/') || pathname === '/api') {
      try {
        const match = routes.find((r) => r.method === req.method && r.re.test(pathname));
        if (!match) {
          const pathExists = routes.some((r) => r.re.test(pathname));
          return json(res, pathExists ? 405 : 404, {
            error: {
              code: pathExists ? 'method_not_allowed' : 'not_found',
              message: pathExists ? '方法不允许' : '接口不存在',
            },
          });
        }
        const values = match.re.exec(pathname).slice(1);
        const params = {};
        match.keys.forEach((k, i) => { params[k] = decodeURIComponent(values[i]); });
        let body = {};
        if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req);
        const actorHeader = req.headers['x-actor'];
        const ctx = {
          params,
          query,
          body,
          actor: validate.actor(
            (body && body.actor) || (typeof actorHeader === 'string' ? actorHeader : '') || '演示用户'
          ),
          req,
        };
        const result = await match.handler(ctx);
        const status = req.method === 'POST' ? 201 : 200;
        json(res, status, result);
      } catch (err) {
        if (err instanceof AppError) {
          json(res, err.status, {
            error: { code: err.code, message: err.message, details: err.details },
          });
        } else {
          console.error('[api]', req.method, pathname, err);
          json(res, 500, {
            error: { code: 'internal_error', message: '服务器内部错误，请查看服务日志' },
          });
        }
      }
      return;
    }

    // 静态文件仅允许 public 下的已知扩展名。
    let rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.normalize(path.join(PUBLIC, rel));
    if (!filePath.startsWith(PUBLIC + path.sep)) {
      return json(res, 403, { error: { code: 'forbidden', message: '禁止访问' } });
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:",
      });
      fs.createReadStream(filePath).pipe(res);
    });
  });

  return { server, db, store, ledger, jobs };
}

module.exports = { createApp, serializeSegment, serializeSnapshot, formatCny, centsToYuan, yuanToCents, isValidPeriod };
