'use strict';

const { tx, nowIso, newId } = require('./db');
const { fail } = require('./errors');
const { normalizeTiers, applyTiers } = require('./rules');
const { allocateProportionally, normalizeLabel } = require('./money');
const { computeSegment } = require('./compute');
const crypto = require('crypto');
const { eventHash, xorHex } = require('./digest');

/**
 * 聚合维护策略（可在设置中切换）：
 *
 * incremental —— 事件写入时只把增量累加到 (集团, 品类, 期间) 聚合状态，然后对
 *   新累计额重新套一次阶梯。单笔写入 O(1) 聚合更新 + O(实体数) 分摊，不重扫历史。
 *   规则调整时直接拿缓存的合格金额套新阶梯，O(受影响期间段数)。
 *
 * recompute —— 写入后重扫该期间段全部有效事件，从零计算；规则调整时逐段重扫。
 *   单笔写入 O(段内事件数)，规则调整 O(受影响事件总数)。它更慢，但可自证不漂移，
 *   用作增量状态的校验与修复路径。
 *
 * 两条路径共用同一套整段套档函数，结果必须逐分一致；一致性检查接口会对全部段做对照。
 */
class Store {
  constructor(db) {
    this.db = db;
  }

  strategy() {
    return this.db.prepare("SELECT value FROM app_meta WHERE key = 'calc_strategy'").get()?.value || 'incremental';
  }

  setStrategy(value, actor) {
    if (!['incremental', 'recompute'].includes(value)) {
      fail('invalid_strategy', 'strategy 必须是 incremental 或 recompute', 400, { field: 'strategy' });
    }
    this.setMeta('calc_strategy', value);
    this.audit('set_strategy', 'app_meta', 'calc_strategy', actor, { strategy: value });
    return value;
  }

  audit(action, entityType, entityId, actor, details = {}) {
    this.db
      .prepare(
        `INSERT INTO audit_log(actor, action, entity_type, entity_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(actor || 'system', action, entityType, entityId, JSON.stringify(details), nowIso());
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO app_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  // ---------- 基础资料 ----------

  listGroups() {
    return this.db.prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM suppliers s WHERE s.group_id = g.id) AS supplier_count
       FROM supplier_groups g ORDER BY g.name`
    ).all();
  }

  createGroup({ name, code }, actor) {
    return tx(this.db, () => {
      const id = newId('grp');
      try {
        this.db.prepare('INSERT INTO supplier_groups(id,name,code,created_at) VALUES (?,?,?,?)')
          .run(id, name, code, nowIso());
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) fail('duplicate', '集团名称或代码已存在', 409);
        throw e;
      }
      this.audit('create_group', 'supplier_group', id, actor, { name, code });
      return this.db.prepare('SELECT * FROM supplier_groups WHERE id = ?').get(id);
    });
  }

  listSuppliers() {
    return this.db.prepare(
      `SELECT s.*, g.name AS group_name, g.code AS group_code
       FROM suppliers s JOIN supplier_groups g ON g.id = s.group_id
       ORDER BY g.name, s.name`
    ).all();
  }

  getSupplier(id) {
    return this.db.prepare(
      `SELECT s.*, g.name AS group_name, g.code AS group_code
       FROM suppliers s JOIN supplier_groups g ON g.id = s.group_id WHERE s.id = ?`
    ).get(id);
  }

  createSupplier({ name, code, group_id }, actor) {
    return tx(this.db, () => {
      const group = this.db.prepare('SELECT * FROM supplier_groups WHERE id = ?').get(group_id);
      if (!group) fail('not_found', '供应商集团不存在', 404, { field: 'group_id' });
      const id = newId('sup');
      try {
        this.db.prepare('INSERT INTO suppliers(id,name,code,group_id,created_at) VALUES (?,?,?,?,?)')
          .run(id, name, code, group_id, nowIso());
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) fail('duplicate', '供应商名称或代码已存在', 409);
        throw e;
      }
      this.audit('create_supplier', 'supplier', id, actor, { name, code, group_id });
      return this.getSupplier(id);
    });
  }

  listEntities() {
    return this.db.prepare('SELECT * FROM procurement_entities ORDER BY code').all();
  }

  createEntity({ name, code, active = 1 }, actor) {
    return tx(this.db, () => {
      const id = newId('ent');
      const activeFlag = active === false || active === 0 ? 0 : 1;
      try {
        this.db.prepare('INSERT INTO procurement_entities(id,name,code,active) VALUES (?,?,?,?)')
          .run(id, name, code, activeFlag);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) fail('duplicate', '采购实体代码已存在', 409);
        throw e;
      }
      this.audit('create_entity', 'procurement_entity', id, actor, { name, code });
      return this.db.prepare('SELECT * FROM procurement_entities WHERE id = ?').get(id);
    });
  }

  // ---------- 合同与规则版本 ----------

  listContracts() {
    const contracts = this.db.prepare(
      `SELECT c.*, g.name AS group_name, g.code AS group_code,
              rv.version AS current_version, rv.created_at AS rule_updated_at,
              rv.note AS rule_note
       FROM contracts c
       JOIN supplier_groups g ON g.id = c.group_id
       LEFT JOIN contract_rule_versions rv ON rv.id = c.current_rule_version_id
       ORDER BY g.name, c.category`
    ).all();
    for (const c of contracts) c.tiers = this.tiersForRule(c.current_rule_version_id);
    return contracts;
  }

  tiersForRule(ruleVersionId) {
    if (!ruleVersionId) return [];
    return this.db.prepare(
      `SELECT threshold_cents, rate_bps, label FROM contract_tiers
       WHERE rule_version_id = ? ORDER BY threshold_cents`
    ).all(ruleVersionId);
  }

  listRuleVersions(contractId) {
    return this.db.prepare(
      `SELECT rv.*, (SELECT COUNT(*) FROM contract_tiers t WHERE t.rule_version_id = rv.id) AS tier_count
       FROM contract_rule_versions rv WHERE rv.contract_id = ? ORDER BY rv.version DESC`
    ).all(contractId);
  }

  getRuleForSegment(groupId, category) {
    const contract = this.db.prepare(
      "SELECT * FROM contracts WHERE group_id = ? AND category = ? AND status = 'active'"
    ).get(groupId, category);
    if (!contract || !contract.current_rule_version_id) {
      return {
        contract: null,
        tiers: [{ threshold_cents: 0, rate_bps: 0, label: '未配置合同（0%）' }],
        ruleVersionId: null,
        version: 0,
        note: '',
      };
    }
    const rv = this.db.prepare('SELECT * FROM contract_rule_versions WHERE id = ?')
      .get(contract.current_rule_version_id);
    return {
      contract,
      tiers: this.tiersForRule(contract.current_rule_version_id),
      ruleVersionId: rv.id,
      version: rv.version,
      note: rv.note,
    };
  }

  createContract({ name, group_id, category, period_type, tiers }, actor) {
    category = normalizeLabel(category);
    const normalized = normalizeTiers(tiers);
    if (normalized.error) fail('invalid_rule', normalized.error, 400, normalized.details);
    return tx(this.db, () => {
      const group = this.db.prepare('SELECT * FROM supplier_groups WHERE id = ?').get(group_id);
      if (!group) fail('not_found', '供应商集团不存在', 404, { field: 'group_id' });
      const id = newId('ctr');
      try {
        this.db.prepare(
          `INSERT INTO contracts(id,name,group_id,category,period_type,currency,status,created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        ).run(id, name, group_id, category, period_type, 'CNY', 'active', nowIso());
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) {
          fail('duplicate', '该集团在此品类已有合同；请改用新规则版本', 409);
        }
        throw e;
      }
      const ruleVersionId = this.insertRuleVersion(id, 1, '初始规则', actor, normalized.tiers);
      this.db.prepare('UPDATE contracts SET current_rule_version_id = ? WHERE id = ?').run(ruleVersionId, id);
      this.markSegmentsDirtyForScope(group_id, category, '合同创建，规则首次生效');
      this.audit('create_contract', 'contract', id, actor, {
        name, group_id, category, tiers: normalized.tiers,
      });
      const segments = this.segmentsForScope(group_id, category);
      return {
        contractId: id,
        ruleVersionId,
        affectedSegments: segments.length,
        segments,
      };
    });
  }

  insertRuleVersion(contractId, version, note, actor, tiers) {
    const result = this.db.prepare(
      `INSERT INTO contract_rule_versions(contract_id, version, note, actor, created_at)
       VALUES (?,?,?,?,?)`
    ).run(contractId, version, note, actor, nowIso());
    const ruleVersionId = Number(result.lastInsertRowid);
    let order = 0;
    for (const tier of tiers) {
      this.db.prepare(
        `INSERT INTO contract_tiers(rule_version_id, threshold_cents, rate_bps, label, sort_order)
         VALUES (?,?,?,?,?)`
      ).run(ruleVersionId, tier.threshold_cents, tier.rate_bps, tier.label, order++);
    }
    return ruleVersionId;
  }

  createRuleVersion(contractId, { tiers, note }, actor) {
    const normalized = normalizeTiers(tiers);
    if (normalized.error) fail('invalid_rule', normalized.error, 400, normalized.details);
    return tx(this.db, () => {
      const contract = this.db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
      if (!contract) fail('not_found', '合同不存在', 404);
      const max = this.db.prepare(
        'SELECT MAX(version) AS v FROM contract_rule_versions WHERE contract_id = ?'
      ).get(contractId);
      const version = Number(max.v || 0) + 1;
      const ruleVersionId = this.insertRuleVersion(
        contractId, version, note || '规则调整', actor, normalized.tiers
      );
      this.db.prepare('UPDATE contracts SET current_rule_version_id = ? WHERE id = ?')
        .run(ruleVersionId, contractId);
      this.markSegmentsDirtyForScope(contract.group_id, contract.category, '规则版本变更，待重算');
      this.audit('create_rule_version', 'contract', contractId, actor, {
        ruleVersionId, version, tiers: normalized.tiers, note,
      });
      return {
        contract,
        ruleVersionId,
        version,
        tiers: normalized.tiers,
        affectedSegments: this.segmentsForScope(contract.group_id, contract.category).length,
      };
    });
  }

  // ---------- 期间段 ----------

  segmentIdFor(groupId, category, period) {
    // 使用稳定哈希避免中文/特殊字符被规范化后发生 ID 碰撞。
    const hash = crypto.createHash('sha1')
      .update(`${groupId}\u0000${category}\u0000${period}`)
      .digest('hex')
      .slice(0, 16);
    return `seg_${period.replace('-', '')}_${hash}`;
  }

  getSegment(groupId, category, period) {
    return this.db.prepare(
      'SELECT * FROM segments WHERE group_id = ? AND category = ? AND period = ?'
    ).get(groupId, category, period);
  }

  segmentsForScope(groupId, category) {
    return this.db.prepare(
      'SELECT * FROM segments WHERE group_id = ? AND category = ? ORDER BY period'
    ).all(groupId, category);
  }

  markSegmentsDirtyForScope(groupId, category, reason) {
    this.db.prepare(
      'UPDATE segments SET dirty = 1, dirty_reason = ? WHERE group_id = ? AND category = ?'
    ).run(reason, groupId, category);
  }

  segmentState(groupId, category, period) {
    const segment = this.getSegment(groupId, category, period);
    const entities = segment
      ? this.db.prepare(
          `SELECT b.*, ent.code AS entity_code, ent.name AS entity_name
           FROM segment_entity_bases b JOIN procurement_entities ent ON ent.id = b.entity_id
           WHERE b.segment_id = ? ORDER BY ent.code`
        ).all(segment.id)
      : [];
    return { groupId, category, period, segment: segment || null, entities };
  }

  eventsForSegment(groupId, category, period) {
    return this.db.prepare(
      `SELECT e.*, s.name AS supplier_name, s.code AS supplier_code,
              ent.name AS entity_name, ent.code AS entity_code
       FROM purchase_events e
       JOIN suppliers s ON s.id = e.supplier_id
       JOIN procurement_entities ent ON ent.id = e.entity_id
       WHERE e.status = 'active' AND s.group_id = ? AND e.category = ? AND e.period = ?
       ORDER BY e.occurred_at, e.id`
    ).all(groupId, category, period);
  }

  entityIdsForSegment(segment) {
    if (!segment) return this.listEntities().filter((e) => e.active).map((e) => e.id);
    return this.db.prepare(
      'SELECT entity_id AS id FROM segment_entity_bases WHERE segment_id = ?'
    ).all(segment.id).map((r) => r.id);
  }

  /**
   * 写入（或重建）一个期间段的持久聚合。version 只在口径输入真正变化时递增，
   * 避免无意义地把全部旧试算判为过期。
   */
  persistComputed(computed, rule, existing, reason) {
    const ts = nowIso();
    const sameInputs = Boolean(existing) &&
      existing.input_digest === computed.eventDigest &&
      existing.eligible_base_cents === computed.eligibleBaseCents &&
      existing.rebate_cents === computed.rebateCents &&
      existing.rate_bps === computed.rateBps &&
      existing.tier_threshold_cents === computed.tierThresholdCents;
    const segId = existing ? existing.id : this.segmentIdFor(computed.groupId, computed.category, computed.period);
    const version = sameInputs ? existing.version : (existing ? existing.version + 1 : 1);
    const contractId = rule.contract ? rule.contract.id : null;
    if (existing) {
      this.db.prepare(
        `UPDATE segments SET contract_id=?, version=?, eligible_base_cents=?, gross_cents=?,
           returns_cents=?, rebate_cents=?, rate_bps=?, tier_label=?, tier_threshold_cents=?,
           rule_version_id=?, event_count=?, input_digest=?, event_xor=?, dirty=0, dirty_reason=NULL,
           computed_at=?
         WHERE id=?`
      ).run(
        contractId, version, computed.eligibleBaseCents, computed.grossPurchaseCents,
        computed.returnsCents, computed.rebateCents, computed.rateBps, computed.tierLabel,
        computed.tierThresholdCents, rule.ruleVersionId, computed.eventCount,
        computed.eventDigest, computed.eventXor, ts, segId
      );
    } else {
      this.db.prepare(
        `INSERT INTO segments(id,group_id,category,period,contract_id,version,eligible_base_cents,
           gross_cents,returns_cents,rebate_cents,rate_bps,tier_label,tier_threshold_cents,
           rule_version_id,event_count,input_digest,event_xor,dirty,dirty_reason,computed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?)`
      ).run(
        segId, computed.groupId, computed.category, computed.period, contractId, version,
        computed.eligibleBaseCents, computed.grossPurchaseCents, computed.returnsCents,
        computed.rebateCents, computed.rateBps, computed.tierLabel, computed.tierThresholdCents,
        rule.ruleVersionId, computed.eventCount, computed.eventDigest, computed.eventXor, ts
      );
    }
    this.db.prepare('DELETE FROM segment_entity_bases WHERE segment_id = ?').run(segId);
    const insert = this.db.prepare(
      `INSERT INTO segment_entity_bases(segment_id,entity_id,base_cents,gross_cents,returns_cents,
         share_cents,event_count) VALUES (?,?,?,?,?,?,?)`
    );
    for (const pe of computed.perEntity) {
      insert.run(segId, pe.entityId, pe.baseCents, pe.grossCents, pe.returnsCents, pe.rebateCents, pe.eventCount);
    }
    return { segmentId: segId, version, changed: !sameInputs, existing };
  }

  /** 全量重算受影响期间段：重扫段内事件，适用于修复、校验和 recompute 策略。 */
  recomputeSegment(groupId, category, period, reason = 'recompute') {
    const events = this.eventsForSegment(groupId, category, period);
    const existing = this.getSegment(groupId, category, period);
    if (events.length === 0 && !existing) return null;
    const rule = this.getRuleForSegment(groupId, category);
    const computed = computeSegment({ groupId, category, period, rule, events });
    const result = this.persistComputed(computed, rule, existing, reason);
    return { ...result, reason, computed, rule };
  }

  /**
   * 增量维护：用刚写入事件的增量更新聚合，再按整段新累计额套档。
   * 退货会计入其追溯的原采购期间；amountSign 为负。
   */
  applyEventDelta({ groupId, category, period, entityId, signedCents, eventType, eventId, reason }) {
    const existing = this.getSegment(groupId, category, period);
    if (!existing) {
      // 首次事件：没有缓存可增量更新，按全量路径建立初态。
      return this.recomputeSegment(groupId, category, period, reason);
    }
    const newGross = existing.gross_cents + (eventType === 'purchase' ? signedCents : 0);
    const newReturns = existing.returns_cents + (eventType === 'return' ? Math.abs(signedCents) : 0);
    const newBase = Math.max(0, newGross - newReturns);
    const rule = this.getRuleForSegment(groupId, category);
    const applied = applyTiers(newBase, rule.tiers);
    const entityRows = this.db.prepare(
      `SELECT b.*, ent.code AS entity_code FROM segment_entity_bases b
       JOIN procurement_entities ent ON ent.id = b.entity_id WHERE b.segment_id = ? ORDER BY ent.code`
    ).all(existing.id);
    const byEntity = new Map(entityRows.map((r) => [r.entity_id, { ...r }]));
    const prev = byEntity.get(entityId);
    if (prev) {
      prev.base_cents += signedCents;
      prev.gross_cents += eventType === 'purchase' ? signedCents : 0;
      prev.returns_cents += eventType === 'return' ? Math.abs(signedCents) : 0;
      prev.event_count += 1;
    } else {
      byEntity.set(entityId, {
        entity_id: entityId,
        base_cents: signedCents,
        gross_cents: eventType === 'purchase' ? signedCents : 0,
        returns_cents: eventType === 'return' ? Math.abs(signedCents) : 0,
        share_cents: 0,
        event_count: 1,
        entity_code: '',
      });
    }
    const weighted = [...byEntity.values()].map((r) => ({
      key: r.entity_id,
      weight: Math.max(0, r.base_cents),
    }));
    const { allocations } = allocateProportionally(applied.rebateCents, weighted);
    const computed = {
      groupId, category, period,
      grossPurchaseCents: newGross,
      returnsCents: newReturns,
      eligibleBaseCents: applied.eligibleBaseCents,
      rebateCents: applied.rebateCents,
      rateBps: applied.rateBps,
      tierLabel: applied.tierLabel,
      tierThresholdCents: applied.tierThresholdCents,
      eventCount: existing.event_count + 1,
      eventXor: xorHex(existing.event_xor, eventHash({
        id: eventId, event_type: eventType, amount_cents: Math.abs(signedCents),
        entity_id: entityId, category, period,
      })),
      perEntity: [...byEntity.values()]
        .sort((a, b) => (a.entity_id < b.entity_id ? -1 : 1))
        .map((r) => ({
          entityId: r.entity_id,
          baseCents: r.base_cents,
          grossCents: r.gross_cents,
          returnsCents: r.returns_cents,
          rebateCents: allocations.get(r.entity_id) || 0,
          eventCount: r.event_count,
        })),
    };
    computed.eventDigest = `${rule.ruleVersionId || 0}:${computed.eventXor}`;
    const result = this.persistComputed(computed, rule, existing, reason);
    return { ...result, reason, computed, rule };
  }

  // ---------- 事件 ----------

  listEvents({ groupId, category, period, supplierId, limit = 200, entityId } = {}) {
    const where = [];
    const params = [];
    if (groupId) { where.push('s.group_id = ?'); params.push(groupId); }
    if (category) { where.push('e.category = ?'); params.push(category); }
    if (period) { where.push('e.period = ?'); params.push(period); }
    if (supplierId) { where.push('e.supplier_id = ?'); params.push(supplierId); }
    if (entityId) { where.push('e.entity_id = ?'); params.push(entityId); }
    const sql = `SELECT e.*, s.name AS supplier_name, s.code AS supplier_code, s.group_id,
                        g.name AS group_name, ent.name AS entity_name, ent.code AS entity_code,
                        rev.id AS reversed_by_id
                 FROM purchase_events e
                 JOIN suppliers s ON s.id = e.supplier_id
                 JOIN supplier_groups g ON g.id = s.group_id
                 JOIN procurement_entities ent ON ent.id = e.entity_id
                 LEFT JOIN purchase_events rev ON rev.reverses_event_id = e.id AND rev.status = 'active'
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY e.period DESC, e.occurred_at DESC, e.created_at DESC
                 LIMIT ?`;
    return this.db.prepare(sql).all(...params, Math.min(Math.max(Number(limit) || 200, 1), 1000));
  }

  getEvent(id) {
    return this.db.prepare(
      `SELECT e.*, s.name AS supplier_name, s.group_id, s.code AS supplier_code,
              ent.name AS entity_name, ent.code AS entity_code
       FROM purchase_events e
       JOIN suppliers s ON s.id = e.supplier_id
       JOIN procurement_entities ent ON ent.id = e.entity_id
       WHERE e.id = ?`
    ).get(id);
  }

  insertEvent(event) {
    event.category = normalizeLabel(event.category);
    return tx(this.db, () => {
      if (event.client_request_id) {
        const existing = this.db.prepare('SELECT * FROM purchase_events WHERE client_request_id = ?')
          .get(event.client_request_id);
        if (existing) return { event: this.getEvent(existing.id), replayed: true, impact: null };
      }
      let reversed = null;
      let effectivePeriod = event.period;
      let effectiveSupplier = event.supplier_id;
      let effectiveEntity = event.entity_id;
      if (event.event_type === 'return') {
        reversed = this.getEvent(event.reverses_event_id);
        if (!reversed || reversed.event_type !== 'purchase') {
          fail('invalid_return', '退货必须关联一笔存在的采购事件', 400, { field: 'reverses_event_id' });
        }
        const suppliedCategory = event.category;
        if (!event.supplier_id) event.supplier_id = reversed.supplier_id;
        if (!event.entity_id) event.entity_id = reversed.entity_id;
        if (!event.category) event.category = reversed.category;
        effectiveSupplier = event.supplier_id;
        effectiveEntity = event.entity_id;
        if (suppliedCategory && suppliedCategory !== reversed.category) {
          fail('invalid_return', '退货品类必须与原采购一致', 400, { field: 'category' });
        }
        if (reversed.supplier_id !== event.supplier_id) {
          fail('invalid_return', '退货供应商必须与原采购一致', 400, { field: 'supplier_id' });
        }
        if (reversed.entity_id !== event.entity_id) {
          fail('invalid_return', '退货实体必须与原采购一致', 400, { field: 'entity_id' });
        }
        const prior = this.db.prepare(
          `SELECT COALESCE(SUM(amount_cents),0) AS s FROM purchase_events
           WHERE reverses_event_id = ? AND status = 'active'`
        ).get(reversed.id);
        if (event.amount_cents + prior.s > reversed.amount_cents) {
          fail('invalid_return', '退货金额超过该采购可退余额', 400, {
            field: 'amount_cents', refundable_cents: reversed.amount_cents - prior.s,
          });
        }
        // 退货追溯原采购所属期间，历史期间段因此被改变。
        effectivePeriod = reversed.period;
        event.category = reversed.category;
        if (event.period && event.period !== effectivePeriod) {
          fail(
            'invalid_return_period',
            `退货必须归入原采购期间 ${effectivePeriod}；请留空期间或填写原期间`,
            400,
            { field: 'period', original_period: effectivePeriod }
          );
        }
      }

      const supplier = this.getSupplier(effectiveSupplier);
      if (!supplier) fail('not_found', '供应商不存在', 404, { field: 'supplier_id' });
      const entity = this.db.prepare('SELECT * FROM procurement_entities WHERE id = ?').get(effectiveEntity);
      if (!entity) fail('not_found', '采购实体不存在', 404, { field: 'entity_id' });
      if (!entity.active) fail('invalid_entity', '采购实体已停用', 400, { field: 'entity_id' });

      const id = newId(event.event_type === 'return' ? 'ret' : 'pur');
      const ts = nowIso();
      const beforeState = this.segmentState(supplier.group_id, event.category, effectivePeriod);
      this.db.prepare(
        `INSERT INTO purchase_events(
           id,event_type,supplier_id,entity_id,category,period,amount_cents,occurred_at,
           reverses_event_id,status,note,actor,created_at,updated_at,client_request_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id, event.event_type, effectiveSupplier, effectiveEntity, event.category, effectivePeriod,
        event.amount_cents, event.occurred_at, event.reverses_event_id || null, 'active',
        event.note || '', event.actor || '演示用户', ts, ts, event.client_request_id || null
      );
      const change = this.recordChange({
        kind: event.event_type === 'return' ? 'return' : 'purchase',
        title: event.event_type === 'return'
          ? `退货 · ${supplier.name} · ${event.category} · ${effectivePeriod}`
          : `采购 · ${supplier.name} · ${event.category} · ${effectivePeriod}`,
        summary: event.event_type === 'return'
          ? `退货 ¥${(event.amount_cents / 100).toFixed(2)}，追溯原采购 ${reversed.id} 所属期间 ${effectivePeriod}`
          : `采购 ¥${(event.amount_cents / 100).toFixed(2)}，计入集团 ${supplier.group_name}`,
        actor: event.actor,
        sourceEventId: id,
        sourceSupplierId: event.supplier_id,
        requestKey: event.client_request_id,
        metadata: {
          event_type: event.event_type,
          reverses_event_id: event.reverses_event_id,
          effective_period: effectivePeriod,
        },
      });
      let computation;
      if (this.strategy() === 'recompute') {
        computation = this.recomputeSegment(
          supplier.group_id, event.category, effectivePeriod,
          event.event_type === 'return' ? '退货后重算（recompute）' : '采购写入（recompute）'
        );
      } else {
        computation = this.applyEventDelta({
          groupId: supplier.group_id,
          category: event.category,
          period: effectivePeriod,
          entityId: event.entity_id,
          signedCents: event.event_type === 'return' ? -event.amount_cents : event.amount_cents,
          eventType: event.event_type,
          eventId: id,
          reason: event.event_type === 'return' ? '退货追溯（增量）' : '采购写入（增量）',
        });
      }
      this.recordImpact(change.id, beforeState, supplier.group_id, event.category, effectivePeriod);
      this.audit('create_event', 'purchase_event', id, event.actor, {
        type: event.event_type, amount_cents: event.amount_cents, period: effectivePeriod,
        category: event.category, supplier_id: event.supplier_id, entity_id: event.entity_id,
        strategy: this.strategy(),
      });
      return {
        event: this.getEvent(id),
        replayed: false,
        changeId: change.id,
        computation: computation
          ? {
              segmentId: computation.segmentId,
              rebateCents: computation.computed.rebateCents,
              eligibleBaseCents: computation.computed.eligibleBaseCents,
              strategy: this.strategy(),
            }
          : null,
      };
    });
  }

  // ---------- 变更与影响 ----------

  recordChange({ kind, title, summary, actor, sourceEventId = null, sourceSupplierId = null, requestKey = null, metadata = {} }) {
    if (requestKey) {
      const existing = this.db.prepare('SELECT * FROM changes WHERE request_key = ?').get(requestKey);
      if (existing) return existing;
    }
    const id = newId('chg');
    this.db.prepare(
      `INSERT INTO changes(id,kind,title,summary,actor,source_event_id,source_supplier_id,request_key,metadata_json,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(id, kind, title, summary, actor, sourceEventId, sourceSupplierId, requestKey,
      JSON.stringify(metadata), nowIso());
    return this.db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  }

  recordImpact(changeId, beforeState, groupId, category, period) {
    const after = this.segmentState(groupId, category, period);
    const beforeRebate = beforeState.segment ? beforeState.segment.rebate_cents : 0;
    const afterRebate = after.segment ? after.segment.rebate_cents : 0;
    const beforeBase = beforeState.segment ? beforeState.segment.eligible_base_cents : 0;
    const afterBase = after.segment ? after.segment.eligible_base_cents : 0;
    const segmentId = after.segment
      ? after.segment.id
      : (beforeState.segment ? beforeState.segment.id : this.segmentIdFor(groupId, category, period));
    const invalidated = after.segment
      ? this.db.prepare(
          'SELECT id FROM calc_snapshots WHERE segment_id = ? AND segment_version < ?'
        ).all(segmentId, after.segment.version).map((r) => r.id)
      : [];
    const id = newId('imp');
    this.db.prepare(
      `INSERT INTO change_impacts(id,change_id,segment_id,segment_label,delta_base_cents,delta_rebate_cents,
         before_json,after_json,invalidated_snapshot_ids_json,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, changeId, segmentId, this.segmentLabel(groupId, category, period),
      afterBase - beforeBase, afterRebate - beforeRebate,
      JSON.stringify(beforeState), JSON.stringify(after),
      JSON.stringify(invalidated), nowIso()
    );
    return id;
  }

  segmentLabel(groupId, category, period) {
    const group = this.db.prepare('SELECT name FROM supplier_groups WHERE id = ?').get(groupId);
    return `${group ? group.name : groupId} · ${category} · ${period}`;
  }

  listChanges({ limit = 50, supplierId = null } = {}) {
    const params = [];
    let where = '';
    if (supplierId) { where = 'WHERE c.source_supplier_id = ?'; params.push(supplierId); }
    const changes = this.db.prepare(
      `SELECT c.* FROM changes c ${where} ORDER BY c.created_at DESC LIMIT ?`
    ).all(...params, Math.min(Math.max(Number(limit) || 50, 1), 200));
    for (const c of changes) {
      c.impacts = this.impactsForChange(c.id);
      c.metadata = JSON.parse(c.metadata_json || '{}');
    }
    return changes;
  }

  getChange(id) {
    const change = this.db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
    if (!change) return null;
    change.impacts = this.impactsForChange(id);
    change.metadata = JSON.parse(change.metadata_json || '{}');
    return change;
  }

  impactsForChange(changeId) {
    return this.db.prepare(
      `SELECT * FROM change_impacts WHERE change_id = ? ORDER BY segment_label, id`
    ).all(changeId).map((i) => ({
      id: i.id,
      change_id: i.change_id,
      segment_id: i.segment_id,
      segment_label: i.segment_label,
      delta_base_cents: i.delta_base_cents,
      delta_rebate_cents: i.delta_rebate_cents,
      before: JSON.parse(i.before_json),
      after: JSON.parse(i.after_json),
      invalidated_snapshot_ids: JSON.parse(i.invalidated_snapshot_ids_json),
    }));
  }

  // ---------- 供应商归属更正 ----------

  moveSupplier({ supplier_id, group_id, reason, idempotency_key, actor }) {
    return tx(this.db, () => {
      if (idempotency_key) {
        const existing = this.db.prepare('SELECT * FROM changes WHERE request_key = ?').get(idempotency_key);
        if (existing) return { change: this.getChange(existing.id), replayed: true };
      }
      const supplier = this.getSupplier(supplier_id);
      if (!supplier) fail('not_found', '供应商不存在', 404, { field: 'supplier_id' });
      const target = this.db.prepare('SELECT * FROM supplier_groups WHERE id = ?').get(group_id);
      if (!target) fail('not_found', '目标集团不存在', 404, { field: 'group_id' });
      if (target.id === supplier.group_id) {
        fail('no_change', '供应商已属于该集团', 409);
      }
      const eventRows = this.db.prepare(
        `SELECT DISTINCT category, period FROM purchase_events
         WHERE supplier_id = ? AND status = 'active' ORDER BY period, category`
      ).all(supplier_id);
      const affected = [];
      for (const row of eventRows) {
        affected.push({ groupId: supplier.group_id, category: row.category, period: row.period });
        affected.push({ groupId: target.id, category: row.category, period: row.period });
      }
      const beforeStates = affected.map((a) => this.segmentState(a.groupId, a.category, a.period));

      this.db.prepare('UPDATE suppliers SET group_id = ? WHERE id = ?').run(target.id, supplier_id);
      this.db.prepare(
        `INSERT INTO supplier_group_history(supplier_id,from_group_id,to_group_id,reason,actor,changed_at)
         VALUES (?,?,?,?,?,?)`
      ).run(supplier_id, supplier.group_id, target.id, reason, actor, nowIso());
      const change = this.recordChange({
        kind: 'supplier_move',
        title: `供应商归属更正 · ${supplier.name}`,
        summary: `${supplier.group_name} → ${target.name}；${reason}`,
        actor,
        sourceSupplierId: supplier_id,
        requestKey: idempotency_key,
        metadata: {
          supplier_id,
          from_group_id: supplier.group_id,
          to_group_id: target.id,
          from_group_name: supplier.group_name,
          to_group_name: target.name,
          reason,
        },
      });

      let index = 0;
      for (const a of eventRows) {
        for (const gid of [supplier.group_id, target.id]) {
          const reason = this.strategy() === 'recompute'
            ? '供应商归属更正（recompute：重扫受影响段）'
            : '供应商归属更正（增量：仅重建原/新集团受影响段）';
          this.recomputeSegment(gid, a.category, a.period, reason);
          const beforeState = beforeStates[index++];
          const beforeHasValue = Boolean(beforeState.segment &&
            (beforeState.segment.event_count > 0 || beforeState.segment.rebate_cents !== 0));
          const afterState = this.segmentState(gid, a.category, a.period);
          const afterHasValue = Boolean(afterState.segment &&
            (afterState.segment.event_count > 0 || afterState.segment.rebate_cents !== 0));
          if (!beforeHasValue && !afterHasValue) continue;
          this.recordImpact(change.id, beforeState, gid, a.category, a.period);
        }
      }
      this.audit('move_supplier', 'supplier', supplier_id, actor, {
        from_group_id: supplier.group_id, to_group_id: target.id, reason,
      });
      const details = this.getChange(change.id);
      details.exposure = details.impacts
        .map((i) => this.ledgerExposureForSegment(i.segment_id))
        .filter((x) => x && x.exposure_cents > 0);
      return { change: details, replayed: false };
    });
  }

  ledgerExposureForSegment(segmentId) {
    const seg = this.db.prepare(
      `SELECT sg.*, g.name AS group_name, g.code AS group_code
       FROM segments sg JOIN supplier_groups g ON g.id = sg.group_id WHERE sg.id = ?`
    ).get(segmentId);
    if (!seg) return null;
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(amount_cents),0) AS total FROM confirmed_entries WHERE segment_id = ?'
    ).get(segmentId);
    return {
      segment_id: segmentId,
      label: `${seg.group_name} · ${seg.category} · ${seg.period}`,
      confirmed_cents: row.total,
      rebate_cents: seg.rebate_cents,
      exposure_cents: Math.max(0, row.total - seg.rebate_cents),
    };
  }

  // ---------- 查询与钻取 ----------

  getSegmentWithDetails(segmentId) {
    const seg = this.db.prepare(
      `SELECT sg.*, g.name AS group_name, g.code AS group_code
       FROM segments sg JOIN supplier_groups g ON g.id = sg.group_id WHERE sg.id = ?`
    ).get(segmentId);
    if (!seg) return null;
    const rule = this.getRuleForSegment(seg.group_id, seg.category);
    const events = this.eventsForSegment(seg.group_id, seg.category, seg.period);
    const entities = this.db.prepare(
      `SELECT b.*, ent.name AS entity_name, ent.code AS entity_code
       FROM segment_entity_bases b JOIN procurement_entities ent ON ent.id = b.entity_id
       WHERE b.segment_id = ? ORDER BY b.base_cents DESC, ent.code`
    ).all(segmentId);
    const confirmed = this.confirmedSummary(segmentId);
    const snapshots = this.listSnapshots(segmentId);
    const impacts = this.db.prepare(
      `SELECT i.*, c.title AS change_title, c.kind AS change_kind, c.created_at AS change_created_at
       FROM change_impacts i JOIN changes c ON c.id = i.change_id
       WHERE i.segment_id = ? ORDER BY c.created_at DESC, i.id DESC LIMIT 40`
    ).all(segmentId).map((i) => ({
      id: i.id,
      change_id: i.change_id,
      change_title: i.change_title,
      change_kind: i.change_kind,
      change_created_at: i.change_created_at,
      segment_label: i.segment_label,
      delta_base_cents: i.delta_base_cents,
      delta_rebate_cents: i.delta_rebate_cents,
      before: JSON.parse(i.before_json),
      after: JSON.parse(i.after_json),
      invalidated_snapshot_ids: JSON.parse(i.invalidated_snapshot_ids_json),
    }));
    const drill = require('./compute').drilldown({
      baseCents: seg.eligible_base_cents,
      tiers: rule.tiers,
      events,
    });
    const exposure = this.ledgerExposureForSegment(segmentId);
    return {
      segment: seg,
      rule,
      events,
      entities,
      confirmed,
      snapshots,
      impacts,
      drill,
      exposure,
      ledger: this.listLedgerEntries(segmentId),
    };
  }

  listSegments({ groupId, category, period, dirtyOnly } = {}) {
    const where = [];
    const params = [];
    if (groupId) { where.push('sg.group_id = ?'); params.push(groupId); }
    if (category) { where.push('sg.category = ?'); params.push(category); }
    if (period) { where.push('sg.period = ?'); params.push(period); }
    if (dirtyOnly) where.push('sg.dirty = 1');
    return this.db.prepare(
      `SELECT sg.*, g.name AS group_name, g.code AS group_code,
              (SELECT COALESCE(SUM(amount_cents),0) FROM confirmed_entries ce
                WHERE ce.segment_id = sg.id) AS confirmed_cents
       FROM segments sg JOIN supplier_groups g ON g.id = sg.group_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY sg.period DESC, g.name, sg.category`
    ).all(...params);
  }

  listPeriods() {
    return this.db.prepare('SELECT DISTINCT period FROM segments ORDER BY period DESC')
      .all().map((r) => r.period);
  }

  // ---------- 试算快照 ----------

  createSnapshot(segmentId, { note = '', actor = '演示用户', whatIfTiers = null, label = '' } = {}) {
    return tx(this.db, () => {
      const details = this.getSegmentWithDetails(segmentId);
      if (!details) fail('not_found', '期间段不存在', 404);
      const seg = details.segment;
      const isWhatIf = Array.isArray(whatIfTiers);
      if (seg.dirty && !isWhatIf) {
        fail(
          'segment_dirty',
          `该期间段待重算（${seg.dirty_reason || '规则已变更'}），请先推进重算任务再生成可确认试算`,
          409,
          { segment_id: segmentId }
        );
      }
      let tiers = details.rule.tiers;
      let target = {
        base: seg.eligible_base_cents,
        rebate: seg.rebate_cents,
        rate: seg.rate_bps,
        label: seg.tier_label,
        threshold: seg.tier_threshold_cents,
      };
      let allocation = details.entities.map((e) => ({
        entity_id: e.entity_id,
        entity_code: e.entity_code,
        base_cents: e.base_cents,
        rebate_cents: e.share_cents,
      }));
      if (isWhatIf) {
        const normalized = normalizeTiers(whatIfTiers);
        if (normalized.error) fail('invalid_rule', normalized.error, 400, normalized.details);
        tiers = normalized.tiers;
        const applied = applyTiers(seg.eligible_base_cents, tiers);
        target = {
          base: seg.eligible_base_cents,
          rebate: applied.rebateCents,
          rate: applied.rateBps,
          label: applied.tierLabel,
          threshold: applied.tierThresholdCents,
        };
        const weighted = details.entities.map((e) => ({
          key: e.entity_id, weight: Math.max(0, e.base_cents),
        }));
        const { allocations } = allocateProportionally(applied.rebateCents, weighted);
        allocation = details.entities.map((e) => ({
          entity_id: e.entity_id,
          entity_code: e.entity_code,
          base_cents: e.base_cents,
          rebate_cents: allocations.get(e.entity_id) || 0,
        }));
      }
      const id = newId('snap');
      this.db.prepare(
        `INSERT INTO calc_snapshots(id,segment_id,segment_version,rule_version_id,input_digest,
           eligible_base_cents,rebate_cents,rate_bps,tier_label,tier_threshold_cents,tiers_json,
           allocation_json,confirmable,is_what_if,status,actor,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'trial', ?, ?)`
      ).run(
        id, segmentId, seg.version, details.rule.ruleVersionId, seg.input_digest,
        target.base, target.rebate, target.rate, target.label, target.threshold,
        JSON.stringify(tiers), JSON.stringify(allocation), isWhatIf ? 0 : 1,
        isWhatIf ? 1 : 0, actor, nowIso()
      );
      this.audit(isWhatIf ? 'what_if_snapshot' : 'create_snapshot', 'calc_snapshot', id, actor, {
        segmentId, rebateCents: target.rebate, note, label,
      });
      return this.getSnapshot(id);
    });
  }

  listSnapshots(segmentId, limit = 20) {
    return this.db.prepare(
      'SELECT id FROM calc_snapshots WHERE segment_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(segmentId, limit).map((r) => this.getSnapshot(r.id));
  }

  getSnapshot(id) {
    const snap = this.db.prepare('SELECT * FROM calc_snapshots WHERE id = ?').get(id);
    if (!snap) return null;
    snap.tiers = JSON.parse(snap.tiers_json);
    snap.allocation = JSON.parse(snap.allocation_json);
    const conf = this.db.prepare('SELECT * FROM snapshot_confirmations WHERE snapshot_id = ?').get(id);
    snap.confirmation = conf || null;
    const seg = this.db.prepare('SELECT * FROM segments WHERE id = ?').get(snap.segment_id);
    snap.segment = seg || null;
    snap.stale = this.snapshotStaleReason(snap, seg);
    return snap;
  }

  /** 旧试算过期的判定；确认时强制拒绝任何非 null 结果。 */
  snapshotStaleReason(snap, seg = null) {
    const segment = seg || this.db.prepare('SELECT * FROM segments WHERE id = ?').get(snap.segment_id);
    if (!segment) return { code: 'segment_missing', message: '期间段已不存在' };
    if (snap.is_what_if) return { code: 'what_if', message: '假设试算不能确认，只能用于比较' };
    if (!snap.confirmable) return { code: 'not_confirmable', message: '该快照不可确认' };
    if (segment.dirty) {
      return { code: 'dirty', message: `期间段待重算：${segment.dirty_reason || '输入已变化'}` };
    }
    if (segment.version !== snap.segment_version || segment.input_digest !== snap.input_digest) {
      return {
        code: 'stale_version',
        message: `试算基于第 ${snap.segment_version} 版，当前已是第 ${segment.version} 版，请重新试算`,
      };
    }
    if (snap.rule_version_id !== segment.rule_version_id) {
      return { code: 'stale_rule', message: '合同规则版本已变更，请重新试算' };
    }
    return null;
  }

  // ---------- 台账查询 ----------

  confirmedSummary(segmentId) {
    const rows = this.db.prepare(
      `SELECT entity_id, kind, SUM(amount_cents) AS amount
       FROM confirmed_entries WHERE segment_id = ? GROUP BY entity_id, kind`
    ).all(segmentId);
    const byEntity = new Map();
    let total = 0;
    for (const r of rows) {
      const current = byEntity.get(r.entity_id) || { confirmed: 0, topup: 0, clawback: 0, total: 0 };
      const bucket = r.kind === 'confirm' ? 'confirmed' : r.kind;
      current[bucket] += r.amount;
      current.total += r.amount;
      byEntity.set(r.entity_id, current);
      total += r.amount;
    }
    const seg = this.db.prepare('SELECT rebate_cents FROM segments WHERE id = ?').get(segmentId);
    const entryCount = this.db.prepare(
      'SELECT COUNT(*) AS n FROM confirmed_entries WHERE segment_id = ?'
    ).get(segmentId).n;
    return {
      totalCents: total,
      rebateCents: seg ? seg.rebate_cents : 0,
      exposureCents: Math.max(0, total - (seg ? seg.rebate_cents : 0)),
      outstandingCents: Math.max(0, (seg ? seg.rebate_cents : 0) - total),
      entryCount,
      entities: [...byEntity.entries()].map(([entityId, v]) => ({ entityId, ...v })),
    };
  }

  listLedgerEntries(segmentId) {
    return this.db.prepare(
      `SELECT ce.*, ent.code AS entity_code, ent.name AS entity_name
       FROM confirmed_entries ce JOIN procurement_entities ent ON ent.id = ce.entity_id
       WHERE ce.segment_id = ? ORDER BY ce.created_at DESC, ce.id DESC`
    ).all(segmentId);
  }

  // ---------- 一致性 ----------

  consistencyReport() {
    const segments = this.db.prepare('SELECT * FROM segments ORDER BY group_id, category, period').all();
    const mismatches = [];
    for (const seg of segments) {
      const events = this.eventsForSegment(seg.group_id, seg.category, seg.period);
      const rule = this.getRuleForSegment(seg.group_id, seg.category);
      const fresh = computeSegment({
        groupId: seg.group_id, category: seg.category, period: seg.period, rule, events,
      });
      const diffs = [];
      if (fresh.eligibleBaseCents !== seg.eligible_base_cents) diffs.push('eligible_base_cents');
      if (fresh.rebateCents !== seg.rebate_cents) diffs.push('rebate_cents');
      if (fresh.rateBps !== seg.rate_bps) diffs.push('rate_bps');
      if (fresh.eventCount !== seg.event_count) diffs.push('event_count');
      if (fresh.eventDigest !== seg.input_digest) diffs.push('input_digest');
      if (diffs.length) {
        mismatches.push({
          segment_id: seg.id,
          label: `${seg.category} · ${seg.period}`,
          fields: diffs,
          stored: {
            base: seg.eligible_base_cents, rebate: seg.rebate_cents,
            rate: seg.rate_bps, events: seg.event_count, digest: seg.input_digest,
          },
          fresh: {
            base: fresh.eligibleBaseCents, rebate: fresh.rebateCents,
            rate: fresh.rateBps, events: fresh.eventCount, digest: fresh.eventDigest,
          },
        });
      }
    }
    const allocationRows = this.db.prepare(
      `SELECT segment_id, SUM(share_cents) AS s FROM segment_entity_bases GROUP BY segment_id`
    ).all();
    const rebateBySegment = new Map(
      this.db.prepare('SELECT id, rebate_cents FROM segments').all().map((r) => [r.id, r.rebate_cents])
    );
    for (const row of allocationRows) {
      if ((rebateBySegment.get(row.segment_id) || 0) !== row.s) {
        mismatches.push({
          segment_id: row.segment_id,
          label: '实体分摊合计',
          fields: ['share_cents'],
          stored: { allocated: row.s, rebate: rebateBySegment.get(row.segment_id) },
        });
      }
    }
    return {
      checked_at: nowIso(),
      segment_count: segments.length,
      ok: mismatches.length === 0,
      mismatches,
      strategy: this.strategy(),
    };
  }
}

module.exports = { Store };
