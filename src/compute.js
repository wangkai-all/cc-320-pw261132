'use strict';

const { normalizeTiers, applyTiers, tierGapDrilldown } = require('./rules');
const { allocateProportionally } = require('./money');
const { digestEvents } = require('./digest');

/**
 * 纯函数计算层：输入同一集团/品类/期间下的有效采购事件，输出整段结果与实体分摊。
 * 不访问数据库，方便单测与在重算任务中复用。
 */
function computeSegment({ groupId, category, period, rule, events, entityIds }) {
  const { tiers } = rule;
  const active = events.filter((e) => e.status === 'active');
  // 退货与采购都进入净额；退货金额以负数参与，净额不能小于 0 的部分不计返利。
  let grossPurchase = 0;
  let returns = 0;
  const byEntity = new Map();
  for (const e of active) {
    const signed = e.event_type === 'return' ? -e.amount_cents : e.amount_cents;
    if (e.event_type === 'return') returns += e.amount_cents;
    else grossPurchase += e.amount_cents;
    const current = byEntity.get(e.entity_id) || { base: 0, gross: 0, returns: 0, count: 0 };
    current.base += signed;
    if (e.event_type === 'return') current.returns += e.amount_cents;
    else current.gross += e.amount_cents;
    current.count += 1;
    byEntity.set(e.entity_id, current);
  }
  const netBase = Math.max(0, grossPurchase - returns);
  const applied = applyTiers(netBase, tiers);

  // 实体分摊权重使用其对净额的贡献（负数贡献按 0，不计权重），确定性分配。
  const weighted = (entityIds || [...byEntity.keys()]).map((entityId) => {
    const info = byEntity.get(entityId) || { base: 0, gross: 0, returns: 0, count: 0 };
    return {
      key: entityId,
      weight: Math.max(0, info.base),
      rawBase: info.base,
      gross: info.gross,
      returns: info.returns,
      count: info.count,
    };
  });
  const { allocations } = allocateProportionally(applied.rebateCents, weighted);
  const perEntity = weighted.map((w) => ({
    entityId: w.key,
    baseCents: w.rawBase,
    grossCents: w.gross,
    returnsCents: w.returns,
    rebateCents: allocations.get(w.key) || 0,
    eventCount: w.count,
  }));
  const totalAllocated = perEntity.reduce((s, x) => s + x.rebateCents, 0);
  if (totalAllocated !== applied.rebateCents) {
    throw new Error('分摊合计不等于整段返利，禁止继续确认');
  }
  const eventXor = digestEvents(active);
  const eventDigest = `${rule.ruleVersionId || 0}:${eventXor}`;
  return {
    groupId,
    category,
    period,
    grossPurchaseCents: grossPurchase,
    returnsCents: returns,
    eligibleBaseCents: applied.eligibleBaseCents,
    rebateCents: applied.rebateCents,
    rateBps: applied.rateBps,
    tierLabel: applied.tierLabel,
    tierThresholdCents: applied.tierThresholdCents,
    nextTier: applied.nextTier,
    eventCount: active.length,
    perEntity,
    eventDigest,
    eventXor,
  };
}

function drilldown({ baseCents, tiers, events }) {
  const eventBases = events
    .filter((e) => e.status === 'active')
    .filter((e) => e.event_type === 'purchase')
    .map((e) => e.amount_cents);
  return tierGapDrilldown(baseCents, tiers, eventBases);
}

module.exports = { computeSegment, drilldown, normalizeTiers };
