'use strict';

/**
 * 采购返利阶梯规则。
 *
 * 关键约定：返利按“供应商集团 + 品类 + 季度期间”整段累计后套用同一档费率，
 * 适用于整段合格采购金额。严禁逐单套档后相加——那在跨门槛时会产生系统高估。
 *
 * 规则版本中每档 threshold 是该档的起始累计额（含）。
 * 返利 = round_half_up(整段合格金额 × 当前达到的最高档费率 / 10000)。
 */

function normalizeTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { error: '至少需要一个返利档位', details: { field: 'tiers' } };
  }
  const parsed = [];
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const threshold = tier.threshold_cents;
    const rate = tier.rate_bps;
    if (!Number.isSafeInteger(threshold) || threshold < 0) {
      return { error: `第 ${i + 1} 档的门槛必须是不小于 0 的整数分`, details: { field: `tiers[${i}].threshold_cents` } };
    }
    if (!Number.isSafeInteger(rate) || rate < 0 || rate > 10000) {
      return { error: `第 ${i + 1} 档的费率必须为 0–10000 的整数基点（1 基点 = 0.01%）`, details: { field: `tiers[${i}].rate_bps` } };
    }
    parsed.push({
      threshold_cents: threshold,
      rate_bps: rate,
      label: String(tier.label || '').trim() || `${rate / 100}%`,
    });
  }
  parsed.sort((a, b) => a.threshold_cents - b.threshold_cents);
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].threshold_cents === parsed[i - 1].threshold_cents) {
      return { error: '门槛金额不能重复', details: { field: `tiers[${i}].threshold_cents` } };
    }
    if (parsed[i].rate_bps < parsed[i - 1].rate_bps) {
      return { error: '费率必须随门槛单调不降（更高采购额不应适用更低费率）', details: { field: `tiers[${i}].rate_bps` } };
    }
  }
  if (parsed[0].threshold_cents !== 0) {
    return { error: '最低一档门槛必须为 0，确保任何合格采购都有基础费率', details: { field: 'tiers[0].threshold_cents' } };
  }
  return { tiers: parsed };
}

/**
 * 对整段累计额套用阶梯。返回命中的档位与返利。
 * 注意：这是“整段一次性”计算，不是逐单或逐实体相加。
 */
function rebateFor(baseCents, rateBps) {
  const base = BigInt(Math.max(0, Math.trunc(baseCents)));
  const rate = BigInt(Math.max(0, Math.trunc(rateBps)));
  // 整数分 × 基点，四舍五入（half-up）；避免浮点在超大金额下丢分。
  return Number((base * rate + 5000n) / 10000n);
}

function applyTiers(baseCents, tiers) {
  const base = Math.max(0, Math.trunc(baseCents));
  let chosen = tiers[0];
  for (const tier of tiers) {
    if (base >= tier.threshold_cents) chosen = tier;
    else break;
  }
  const rebateCents = rebateFor(base, chosen.rate_bps);
  const next = tiers.find((t) => t.threshold_cents > base) || null;
  return {
    eligibleBaseCents: base,
    rebateCents,
    rateBps: chosen.rate_bps,
    tierLabel: chosen.label,
    tierThresholdCents: chosen.threshold_cents,
    nextTier: next
      ? {
          label: next.label,
          thresholdCents: next.threshold_cents,
          rateBps: next.rate_bps,
          gapCents: next.threshold_cents - base,
          /** 达到下一档后的整段返利（用于钻取“能多拿多少”）。 */
          projectedRebateCents: rebateFor(base, next.rate_bps),
          incrementalRebateCents: rebateFor(base, next.rate_bps) - rebateCents,
        }
      : null,
    /** 若金额为 0，返利也为 0，不命中任何实质档位。 */
    isZero: base === 0,
  };
}

/**
 * 演示“若只计算某笔采购”的返利，仅用于解释整段法差异，不写入台账。
 * 逐单相加法把每笔采购各自套档后相加。
 */
function perEventMethodSum(eventBases, tiers) {
  return eventBases.reduce((sum, cents) => sum + applyTiers(Math.abs(cents), tiers).rebateCents, 0);
}

function tierGapDrilldown(baseCents, tiers, eventBases) {
  const applied = applyTiers(baseCents, tiers);
  const perOrder = perEventMethodSum(eventBases, tiers);
  return {
    baseCents,
    applied: {
      rebateCents: applied.rebateCents,
      rateBps: applied.rateBps,
      tierLabel: applied.tierLabel,
      tierThresholdCents: applied.tierThresholdCents,
    },
    perOrderMethod: {
      rebateCents: perOrder,
      description: '逐单独立套档后相加（错误做法，仅用于对比）',
    },
    overstatementCents: perOrder - applied.rebateCents,
    nextTier: applied.nextTier,
  };
}

module.exports = { normalizeTiers, applyTiers, rebateFor, perEventMethodSum, tierGapDrilldown };
