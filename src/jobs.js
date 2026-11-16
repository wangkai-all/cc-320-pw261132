'use strict';

const { tx, nowIso, newId } = require('./db');
const { fail } = require('./errors');
const { applyTiers, normalizeTiers } = require('./rules');
const { allocateProportionally } = require('./money');

/**
 * 可恢复的批量重算任务。
 *
 * 两种策略：
 *  - incremental（默认）：规则变更时，合格金额本身与规则无关，直接复用缓存的
 *    实体净额与新阶梯相乘，每段 O(实体数)，只扫一遍受影响段的元数据；
 *  - recompute：每段重扫全部事件从零计算，O(受影响段事件总数)，用于修复或校验。
 *
 * 任务按 batch_size 分段提交，每处理完一项立即持久化 done 标记和影响记录，
 * 进程中断后从 pending 项继续，不会重复处理已完成项，也不会丢影响解释。
 */
class JobService {
  constructor(db, store) {
    this.db = db;
    this.store = store;
  }

  createRuleChangeJob(contract, ruleVersionId, actor) {
    return tx(this.db, () => {
      const segments = this.store.segmentsForScope(contract.group_id, contract.category);
      if (segments.length === 0) {
        return { job: null, empty: true, affectedSegments: 0 };
      }
      const change = this.store.recordChange({
        kind: 'rule_change',
        title: `返利规则变更 · ${contract.name} · 第 ${contract.currentVersion || ''} 版`,
        summary:
          `合同 ${contract.id} 规则版本 ${ruleVersionId} 生效；` +
          `${segments.length} 个历史期间段需按整段重新套档`,
        actor,
        metadata: {
          contract_id: contract.id,
          group_id: contract.group_id,
          category: contract.category,
          rule_version_id: ruleVersionId,
        },
      });
      const jobId = newId('job');
      const ts = nowIso();
      this.db.prepare(
        `INSERT INTO recalc_jobs(id,kind,contract_id,rule_version_id,status,reason,total_items,
           done_items,batch_size,strategy,actor,created_at,updated_at,change_id)
         VALUES (?,?,?,?, 'pending', ?, ?, 0, ?, ?, ?, ?, ?, ?)`
      ).run(
        jobId, 'rule_change', contract.id, ruleVersionId,
        '规则版本变更后按新阶梯重算历史段', segments.length, 2,
        this.store.strategy(), actor, ts, ts, change.id
      );
      const insertItem = this.db.prepare(
        `INSERT INTO recalc_job_items(job_id,segment_id,status,before_json)
         VALUES (?,?, 'pending', ?)`
      );
      for (const seg of segments) {
        insertItem.run(
          jobId, seg.id,
          JSON.stringify({
            eligible_base_cents: seg.eligible_base_cents,
            rebate_cents: seg.rebate_cents,
            rate_bps: seg.rate_bps,
            tier_label: seg.tier_label,
            version: seg.version,
          })
        );
      }
      this.store.audit('create_recalc_job', 'recalc_job', jobId, actor, {
        kind: 'rule_change', total: segments.length, strategy: this.store.strategy(),
      });
      return { job: this.getJob(jobId), changeId: change.id, affectedSegments: segments.length };
    });
  }

  createFullRecomputeJob(actor, note = '') {
    return tx(this.db, () => {
      const segments = this.db.prepare('SELECT * FROM segments ORDER BY group_id, category, period').all();
      if (segments.length === 0) return { job: null, empty: true, affectedSegments: 0 };
      const jobId = newId('job');
      const ts = nowIso();
      this.db.prepare(
        `INSERT INTO recalc_jobs(id,kind,status,reason,total_items,done_items,batch_size,
           strategy,actor,created_at,updated_at)
         VALUES (?, 'full_recompute', 'pending', ?, ?, 0, 2, ?, ?, ?, ?)`
      ).run(
        jobId, note || '全量对照重算，用于校验增量聚合', segments.length,
        this.store.strategy(), actor, ts, ts
      );
      const insertItem = this.db.prepare(
        `INSERT INTO recalc_job_items(job_id,segment_id,status,before_json) VALUES (?,?, 'pending', ?)`
      );
      for (const seg of segments) {
        insertItem.run(jobId, seg.id, JSON.stringify({
          eligible_base_cents: seg.eligible_base_cents,
          rebate_cents: seg.rebate_cents,
          rate_bps: seg.rate_bps,
          tier_label: seg.tier_label,
          version: seg.version,
        }));
      }
      this.store.audit('create_recalc_job', 'recalc_job', jobId, actor, {
        kind: 'full_recompute', total: segments.length,
      });
      return { job: this.getJob(jobId), affectedSegments: segments.length };
    });
  }

  getJob(jobId) {
    const job = this.db.prepare('SELECT * FROM recalc_jobs WHERE id = ?').get(jobId);
    if (!job) return null;
    job.items = this.db.prepare(
      `SELECT i.*, sg.category, sg.period, sg.group_id, g.name AS group_name
       FROM recalc_job_items i
       JOIN segments sg ON sg.id = i.segment_id
       JOIN supplier_groups g ON g.id = sg.group_id
       WHERE i.job_id = ? ORDER BY i.id`
    ).all(jobId).map((i) => ({
      ...i,
      before: i.before_json ? JSON.parse(i.before_json) : null,
      after: i.after_json ? JSON.parse(i.after_json) : null,
      before_json: undefined,
      after_json: undefined,
    }));
    return job;
  }

  listJobs(limit = 20) {
    return this.db.prepare(
      `SELECT * FROM recalc_jobs ORDER BY created_at DESC LIMIT ?`
    ).all(Math.min(Math.max(Number(limit) || 20, 1), 100)).map((j) => ({
      ...j,
      progress: j.total_items ? Number((j.done_items / j.total_items).toFixed(3)) : 0,
    }));
  }

  /**
   * 推进任务若干批。每批一个事务；断电/异常时已提交批次保留，重入从 pending 继续。
   * strategy 在任务创建时固定，避免中途改变口径导致前后不一致。
   */
  runJob(jobId, { batches = 1, actor = '系统' } = {}) {
    const startedAt = Date.now();
    const results = [];
    for (let b = 0; b < Math.max(1, Math.min(Number(batches) || 1, 200)); b++) {
      const batch = tx(this.db, () => {
        const job = this.db.prepare('SELECT * FROM recalc_jobs WHERE id = ?').get(jobId);
        if (!job) fail('not_found', '重算任务不存在', 404);
        if (job.status === 'completed') return { completed: true, processed: 0 };
        if (job.status === 'failed') fail('job_failed', '任务已失败，请新建任务', 409);
        if (job.status === 'paused') return { paused: true, processed: 0 };
        this.db.prepare(
          "UPDATE recalc_jobs SET status = 'running', updated_at = ? WHERE id = ?"
        ).run(nowIso(), jobId);
        const items = this.db.prepare(
          `SELECT i.*, sg.group_id, sg.category, sg.period
           FROM recalc_job_items i JOIN segments sg ON sg.id = i.segment_id
           WHERE i.job_id = ? AND i.status = 'pending' ORDER BY i.id LIMIT ?`
        ).all(jobId, Math.max(1, job.batch_size));
        let processed = 0;
        let scanned = 0;
        for (const item of items) {
          const before = {
            eligible_base_cents: item.before ? JSON.parse(item.before_json).eligible_base_cents : 0,
            rebate_cents: item.before ? JSON.parse(item.before_json).rebate_cents : 0,
          };
          const beforeState = this.store.segmentState(item.group_id, item.category, item.period);
          let outcome;
          let eventsScanned = 0;
          if (job.strategy === 'recompute') {
            outcome = this.store.recomputeSegment(
              item.group_id, item.category, item.period, '重算任务（recompute）'
            );
            eventsScanned = outcome ? outcome.computed.eventCount : 0;
          } else {
            outcome = this.reapplyCachedRule(item.group_id, item.category, item.period);
            eventsScanned = 0; // 增量路径不读取事件明细，只复用段内缓存的金额与实体净额
          }
          const afterState = this.store.segmentState(item.group_id, item.category, item.period);
          const deltaRebate = (afterState.segment ? afterState.segment.rebate_cents : 0) -
            (beforeState.segment ? beforeState.segment.rebate_cents : 0);
          const deltaBase = (afterState.segment ? afterState.segment.eligible_base_cents : 0) -
            (beforeState.segment ? beforeState.segment.eligible_base_cents : 0);
          this.db.prepare(
            `UPDATE recalc_job_items SET status='done', before_json=?, after_json=?,
               delta_base_cents=?, delta_rebate_cents=?, events_scanned=?, processed_at=?
             WHERE id=?`
          ).run(
            JSON.stringify(beforeState), JSON.stringify(afterState),
            deltaBase, deltaRebate, eventsScanned, nowIso(), item.id
          );
          if (job.change_id) {
            this.store.recordImpact(job.change_id, beforeState, item.group_id, item.category, item.period);
          }
          processed += 1;
          scanned += eventsScanned;
        }
        const now = nowIso();
        const agg = this.db.prepare(
          `SELECT COUNT(*) AS pending FROM recalc_job_items WHERE job_id = ? AND status='pending'`
        ).get(jobId).pending;
        const done = this.db.prepare(
          `SELECT COUNT(*) AS n FROM recalc_job_items WHERE job_id = ? AND status='done'`
        ).get(jobId).n;
        const completed = agg === 0;
        this.db.prepare(
          `UPDATE recalc_jobs SET done_items=?, batches_done=batches_done+1, events_scanned=events_scanned+?,
             elapsed_ms=elapsed_ms+?, status=?, updated_at=?, finished_at=?
           WHERE id=?`
        ).run(
          done, scanned, Date.now() - startedAt,
          completed ? 'completed' : 'running', now, completed ? now : null, jobId
        );
        return { completed, processed, done, total: job.total_items };
      });
      results.push(batch);
      if (batch.completed || batch.paused) {
        return { job: this.getJob(jobId), batches: results, elapsedMs: Date.now() - startedAt };
      }
      if (batch.processed === 0) break;
    }
    return { job: this.getJob(jobId), batches: results, elapsedMs: Date.now() - startedAt };
  }

  /**
   * 增量规则重算：基础金额不依赖规则，直接拿缓存的实体净额套新阶梯并重新分摊。
   * 不读取事件明细；这与全量重算结果必须完全一致（一致性检查可验证）。
   */
  reapplyCachedRule(groupId, category, period) {
    const existing = this.store.getSegment(groupId, category, period);
    if (!existing) return null;
    const rule = this.store.getRuleForSegment(groupId, category);
    const entityRows = this.db.prepare(
      `SELECT b.* FROM segment_entity_bases b WHERE b.segment_id = ? ORDER BY b.entity_id`
    ).all(existing.id);
    const applied = applyTiers(existing.eligible_base_cents, rule.tiers);
    const weighted = entityRows.map((r) => ({ key: r.entity_id, weight: Math.max(0, r.base_cents) }));
    const { allocations } = allocateProportionally(applied.rebateCents, weighted);
    const computed = {
      groupId, category, period,
      grossPurchaseCents: existing.gross_cents,
      returnsCents: existing.returns_cents,
      eligibleBaseCents: existing.eligible_base_cents,
      rebateCents: applied.rebateCents,
      rateBps: applied.rateBps,
      tierLabel: applied.tierLabel,
      tierThresholdCents: applied.tierThresholdCents,
      eventCount: existing.event_count,
      // 事件集未变，事件异或与事件数保持不变；仅规则版本变化。
      eventXor: existing.event_xor,
      eventDigest: `${rule.ruleVersionId || 0}:${existing.event_xor}`,
      perEntity: entityRows.map((r) => ({
        entityId: r.entity_id,
        baseCents: r.base_cents,
        grossCents: r.gross_cents,
        returnsCents: r.returns_cents,
        rebateCents: allocations.get(r.entity_id) || 0,
        eventCount: r.event_count,
      })),
    };
    // 增量路径刻意不扫事件明细；漂移由一致性检查接口全量核对。
    const result = this.store.persistComputed(computed, rule, existing, '规则重算（增量）');
    return { ...result, computed, rule };
  }

  pauseJob(jobId, actor) {
    return tx(this.db, () => {
      const job = this.db.prepare('SELECT * FROM recalc_jobs WHERE id = ?').get(jobId);
      if (!job) fail('not_found', '任务不存在', 404);
      if (job.status === 'completed') fail('job_completed', '任务已完成，无法暂停', 409);
      this.db.prepare(
        "UPDATE recalc_jobs SET status='paused', updated_at=?, note=? WHERE id=?"
      ).run(nowIso(), '手动暂停', jobId);
      this.store.audit('pause_recalc_job', 'recalc_job', jobId, actor);
      return this.getJob(jobId);
    });
  }

  resumeJob(jobId, actor) {
    return tx(this.db, () => {
      const job = this.db.prepare('SELECT * FROM recalc_jobs WHERE id = ?').get(jobId);
      if (!job) fail('not_found', '任务不存在', 404);
      if (job.status === 'completed') fail('job_completed', '任务已完成', 409);
      this.db.prepare(
        "UPDATE recalc_jobs SET status='pending', updated_at=?, note=? WHERE id=?"
      ).run(nowIso(), '手动恢复', jobId);
      this.store.audit('resume_recalc_job', 'recalc_job', jobId, actor);
      return this.getJob(jobId);
    });
  }
}

module.exports = { JobService };
