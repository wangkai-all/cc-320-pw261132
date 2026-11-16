'use strict';

const { fail } = require('./errors');

const PERIOD_RE = /^(\d{4})-Q([1-4])$/;

function parsePeriod(period) {
  const m = PERIOD_RE.exec(String(period || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const quarter = Number(m[2]);
  return { year, quarter, index: year * 4 + (quarter - 1) };
}

function isValidPeriod(period) {
  return parsePeriod(period) !== null;
}

function assertPeriod(period, field = 'period') {
  if (!isValidPeriod(period)) {
    fail('invalid_period', `${field} 必须是 YYYY-QN 格式的季度，例如 2026-Q1`, 400, { field });
  }
  return period;
}

function periodIndex(period) {
  const parsed = parsePeriod(period);
  if (!parsed) throw new Error(`bad period ${period}`);
  return parsed.index;
}

function periodFromIndex(index) {
  const year = Math.floor(index / 4);
  const quarter = (index % 4) + 1;
  return `${year}-Q${quarter}`;
}

function offsetPeriod(period, delta) {
  return periodFromIndex(periodIndex(period) + delta);
}

function comparePeriod(a, b) {
  return periodIndex(a) - periodIndex(b);
}

/** 金额以人民币分为单位在内部运算，避免二进制浮点误差。 */
function yuanToCents(value, field = 'amount') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_amount', `${field} 必须是有限数字`, 400, { field });
    return Math.round(value * 100);
  }
  if (typeof value !== 'string') {
    fail('invalid_amount', `${field} 必须是元字符串或数字`, 400, { field });
  }
  const trimmed = value.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
    fail('invalid_amount', `${field} 必须是最多两位小数的金额（元）`, 400, { field });
  }
  const neg = trimmed.startsWith('-');
  const [intPart, decPart = ''] = (neg ? trimmed.slice(1) : trimmed).split('.');
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) fail('invalid_amount', `${field} 超出可处理范围`, 400, { field });
  return neg ? -cents : cents;
}

/** 品类/名称的规范化键：去首尾空白、合并空白、Unicode NFKC，避免同义写法拆成两个段。 */
function normalizeLabel(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function centsToYuan(cents) {
  if (!Number.isFinite(cents)) return null;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function formatCny(cents) {
  const value = centsToYuan(cents);
  if (value === null) return '—';
  const neg = value.startsWith('-');
  const [i, d] = (neg ? value.slice(1) : value).split('.');
  return `${neg ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${d}`;
}

/** 按比例分配，余数用最大余数法保证合计恰好等于目标，确定性排序。整数分 + BigInt，无浮点误差。 */
function allocateProportionally(totalCents, weightedItems) {
  const result = new Map();
  const items = weightedItems
    .filter((it) => Number(it.weight) > 0)
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const totalWeight = items.reduce((sum, it) => sum + BigInt(Math.trunc(it.weight)), 0n);
  if (totalCents === 0 || items.length === 0) {
    for (const it of items) result.set(it.key, 0);
    return { allocations: result, totalWeight: Number(totalWeight) };
  }
  const sign = totalCents < 0 ? -1 : 1;
  const absTotal = BigInt(Math.abs(totalCents));
  const raw = items.map((it) => {
    const weight = BigInt(Math.trunc(it.weight));
    const numerator = absTotal * weight;
    return {
      key: it.key,
      weight,
      floor: numerator / totalWeight,
      rem: numerator % totalWeight,
    };
  });
  const assigned = raw.reduce((sum, r) => sum + r.floor, 0n);
  let remainder = absTotal - assigned;
  const order = raw.slice().sort((a, b) => {
    if (a.rem !== b.rem) return a.rem > b.rem ? -1 : 1;
    if (a.weight !== b.weight) return a.weight > b.weight ? -1 : 1;
    return a.key < b.key ? -1 : 1;
  });
  const bonus = new Map();
  let i = 0;
  while (remainder > 0n) {
    const key = order[i % order.length].key;
    bonus.set(key, (bonus.get(key) || 0n) + 1n);
    remainder -= 1n;
    i++;
  }
  for (const r of raw) {
    result.set(r.key, sign * Number(r.floor + (bonus.get(r.key) || 0n)));
  }
  return { allocations: result, totalWeight: Number(totalWeight) };
}

module.exports = {
  normalizeLabel,
  parsePeriod,
  isValidPeriod,
  assertPeriod,
  periodIndex,
  periodFromIndex,
  offsetPeriod,
  comparePeriod,
  yuanToCents,
  centsToYuan,
  formatCny,
  allocateProportionally,
};
