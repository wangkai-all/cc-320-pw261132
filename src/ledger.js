'use strict';

const { tx, nowIso, newId } = require('./db');
const { fail } = require('./errors');
const { centsToYuan } = require('./money');

/**
 * 正式台账写入服务。
 *
 * 隔离原则：
 *  - calc_snapshots 只是试算，confirmed_entries 只由本服务写入，绝不自动从试算回写；
 *  - 试算确认必须通过 segment.version / input_digest / rule_version_id 校验，
 *    任何一项不匹配即判定过期并拒绝，绝不“尽量确认”；
 *  - 台账只追加：confirmed_entries 上有禁止 UPDATE/DELETE 的触发器；
 *  - 确认与补记的并发由 BEGIN IMMEDIATE + 幂等键 + “目标减已确认”三重保证，
 *    同一笔返利最多分配一次。
 *
 * mode:
 *  - exact：按快照中实体分摊确认；若段已变化（快照过期）则拒绝。
 *  - topup：快照未过期时，补记到当前段应得；若段已变化则拒绝（必须重新试算）。
 *    补记用于“同一段先确认过一部分，后来又跨档”的已审阅追加，不静默追加。
 */
class LedgerService {
  constructor(db, store) {
    this.db = db;
    this.store = store;
  }

  confirm({
    snapshot_id, mode = 'exact', idempotency_key, actor = '演示用户', note = '',
  }) {
    return tx(this.db, () => {
      const requestKey = `confirm:${idempotency_key}`;
      const replay = this.db.prepare(
        'SELECT * FROM ledger_requests WHERE idempotency_key = ?'
      ).get(requestKey);
      if (replay) return { ...JSON.parse(replay.result_json), replayed: true };

      const snap = this.store.getSnapshot(snapshot_id);
      if (!snap) fail('not_found', '试算快照不存在', 404, { field: 'snapshot_id' });
      if (snap.is_what_if) {
        fail('what_if_not_confirmable', '假设试算（what-if）不能写入正式台账', 409);
      }
      const stale = this.store.snapshotStaleReason(snap);
      if (stale) {
        fail('stale_snapshot', `旧试算已过期，拒绝确认：${stale.message}`, 409, {
          reason: stale.code,
          snapshot_version: snap.segment_version,
          current_version: snap.segment ? snap.segment.version : null,
        });
      }
      const segment = snap.segment;
      if (!segment) fail('not_found', '期间段不存在', 409);

      const existingConf = this.db.prepare(
        'SELECT * FROM snapshot_confirmations WHERE snapshot_id = ?'
      ).get(snapshot_id);
      if (existingConf && existingConf.status === 'confirmed') {
        fail('already_confirmed', '该快照已全额确认，无需重复确认', 409, {
          confirmed_cents: existingConf.ledger_total_cents,
        });
      }

      const summary = this.store.confirmedSummary(segment.id);
      const targetRebate = mode === 'topup' ? segment.rebate_cents : snap.rebate_cents;
      const requested = targetRebate - summary.totalCents;
      if (requested < 0) {
        fail(
          'clawback_required',
          `已确认台账 ${centsToYuan(summary.totalCents)} 元高于目标 ${centsToYuan(targetRebate)} 元，` +
            '差额需通过回补接口显式冲销，不能由确认静默减少',
          409,
          { confirmed_cents: summary.totalCents, target_cents: targetRebate }
        );
      }
      if (requested === 0) {
        const result = this.resultPayload({
          segment, snapshotId: snapshot_id, mode, summary,
          entries: [], addedCents: 0,
          outstandingCents: Math.max(0, segment.rebate_cents - summary.totalCents),
          message: '台账已达到该快照目标，无需新增分配',
        });
        this.finishRequest(requestKey, segment.id, snapshot_id, mode, actor, result);
        return result;
      }

      const targets = this.targetAllocations({ mode, snap, segment, targetRebate, summary });
      const targetTotal = targets.reduce((s, t) => s + t.targetCents, 0);
      if (targetTotal !== targetRebate) {
        throw new Error(`目标分摊合计 ${targetTotal} 与目标返利 ${targetRebate} 不一致`);
      }
      const alreadyByEntity = new Map(summary.entities.map((e) => [e.entityId, e.total]));
      const entries = [];
      const insert = this.db.prepare(
        `INSERT INTO confirmed_entries(id,segment_id,snapshot_id,entity_id,kind,amount_cents,
           idempotency_key,note,actor,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      let kind = mode === 'topup' || summary.totalCents > 0 ? 'topup' : 'confirm';
      for (const target of targets) {
        const already = alreadyByEntity.get(target.entityId) || 0;
        const delta = target.targetCents - already;
        if (delta === 0) continue;
        if (delta < 0) {
          fail(
            'clawback_required',
            `实体 ${target.entityCode} 已确认高于该快照目标 ${centsToYuan(-delta)} 元，需先回补`,
            409,
            { entity_id: target.entityId, excess_cents: -delta }
          );
        }
        const id = newId('led');
        insert.run(
          id, segment.id, snapshot_id, target.entityId, kind, delta,
          `${requestKey}:${target.entityId}`, note, actor, nowIso()
        );
        entries.push({
          id, entityId: target.entityId, entityCode: target.entityCode,
          kind, amountCents: delta,
        });
      }
      const added = entries.reduce((s, e) => s + e.amountCents, 0);
      if (added !== requested) {
        throw new Error(`本次分配 ${added} 与目标差额 ${requested} 不一致，已回滚`);
      }
      const newTotal = summary.totalCents + added;
      const status = newTotal === segment.rebate_cents ? 'confirmed' : 'partially_confirmed';
      this.db.prepare(
        `INSERT INTO snapshot_confirmations(snapshot_id,segment_id,ledger_total_cents,status,last_mode,updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(snapshot_id) DO UPDATE SET
           ledger_total_cents = excluded.ledger_total_cents,
           status = excluded.status, last_mode = excluded.last_mode, updated_at = excluded.updated_at`
      ).run(snapshot_id, segment.id, newTotal, status, mode, nowIso());

      const result = this.resultPayload({
        segment, snapshotId: snapshot_id, mode, summary, entries, addedCents: added,
        outstandingCents: Math.max(0, segment.rebate_cents - newTotal),
      });
      this.finishRequest(requestKey, segment.id, snapshot_id, mode, actor, result);
      this.store.audit('confirm_rebate', 'segment', segment.id, actor, {
        snapshot_id, mode, added_cents: added, confirmed_total_cents: newTotal,
      });
      return result;
    });
  }

  resultPayload({ segment, snapshotId, mode, summary, entries, addedCents, outstandingCents, message }) {
    return {
      segmentId: segment.id,
      snapshotId,
      mode,
      entries,
      totalAddedCents: addedCents,
      confirmedBeforeCents: summary.totalCents,
      confirmedTotalCents: summary.totalCents + addedCents,
      segmentRebateCents: segment.rebate_cents,
      outstandingCents,
      message: message || '',
      replayed: false,
    };
  }

  targetAllocations({ mode, snap, segment, targetRebate, summary }) {
    const entities = this.db.prepare(
      `SELECT b.entity_id, ent.code AS entity_code, b.base_cents
       FROM segment_entity_bases b JOIN procurement_entities ent ON ent.id = b.entity_id
       WHERE b.segment_id = ? ORDER BY ent.code`
    ).all(segment.id);
    if (mode === 'exact') {
      const snapAlloc = new Map(snap.allocation.map((a) => [a.entity_id, a.rebate_cents]));
      return entities.map((e) => ({
        entityId: e.entity_id,
        entityCode: e.entity_code,
        targetCents: snapAlloc.get(e.entity_id) || 0,
      }));
    }
    const { allocateProportionally } = require('./money');
    const weighted = entities.map((e) => ({ key: e.entity_id, weight: Math.max(0, e.base_cents) }));
    const { allocations } = allocateProportionally(targetRebate, weighted);
    return entities.map((e) => ({
      entityId: e.entity_id,
      entityCode: e.entity_code,
      targetCents: allocations.get(e.entity_id) || 0,
    }));
  }

  finishRequest(key, segmentId, snapshotId, mode, actor, result) {
    this.db.prepare(
      `INSERT INTO ledger_requests(idempotency_key,segment_id,snapshot_id,mode,actor,result_json,created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(key, segmentId, snapshotId || null, mode, actor, JSON.stringify(result), nowIso());
  }

  /**
   * 回补：退货使历史应得下降后，把多确认的部分显式冲回（负分录）。
   * 必须提供幂等键；金额上限为该实体与整段的已确认净额。
   */
  clawback({ segmentId, entity_id, amount_cents, idempotency_key, actor = '演示用户', note = '' }) {
    return tx(this.db, () => {
      const requestKey = `clawback:${idempotency_key}`;
      const replay = this.db.prepare(
        'SELECT * FROM ledger_requests WHERE idempotency_key = ?'
      ).get(requestKey);
      if (replay) return { ...JSON.parse(replay.result_json), replayed: true };
      const segment = this.db.prepare('SELECT * FROM segments WHERE id = ?').get(segmentId);
      if (!segment) fail('not_found', '期间段不存在', 404);
      if (!Number.isSafeInteger(amount_cents) || amount_cents <= 0) {
        fail('invalid_amount', '回补金额必须为正的整数分', 400, { field: 'amount_cents' });
      }
      const summary = this.store.confirmedSummary(segmentId);
      const entity = summary.entities.find((e) => e.entityId === entity_id);
      if (!entity || entity.total <= 0) {
        fail('no_confirmed', '该实体没有可回补的已确认返利', 409);
      }
      if (entity.total < amount_cents) {
        fail('exceeds_confirmed', '回补金额不能超过该实体已确认净额', 409, {
          confirmed_cents: entity.total,
        });
      }
      const id = newId('led');
      this.db.prepare(
        `INSERT INTO confirmed_entries(id,segment_id,snapshot_id,entity_id,kind,amount_cents,
           idempotency_key,note,actor,created_at)
         VALUES (?,?,NULL,?,?,?,?,?,?,?)`
      ).run(
        id, segmentId, entity_id, 'clawback', -amount_cents,
        `${requestKey}:${entity_id}`, note || '退货追溯回补', actor, nowIso()
      );
      const result = {
        segmentId,
        entityId: entity_id,
        entryId: id,
        clawbackCents: amount_cents,
        totalAddedCents: -amount_cents,
        confirmedTotalCents: summary.totalCents - amount_cents,
        replayed: false,
      };
      this.finishRequest(requestKey, segmentId, null, 'clawback', actor, result);
      this.store.audit('clawback_rebate', 'segment', segmentId, actor, result);
      return result;
    });
  }
}

module.exports = { LedgerService };
