'use strict';

const crypto = require('crypto');

/**
 * 可交换的事件摘要：事件集的摘要 = 各事件摘要按位异或。
 * 这样增量加入/移除一笔采购或退货时，无需重扫整段事件就能更新摘要，
 * 同时与全量重算得到完全相同的值（用于校验增量状态）。
 */
function eventHash(event) {
  const material = [
    event.id,
    event.event_type,
    event.amount_cents,
    event.entity_id,
    event.category,
    event.period,
  ].join('|');
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

function xorHex(a, b) {
  const len = 32;
  const left = (a || '').padEnd(len, '0').slice(0, len);
  const right = (b || '').padEnd(len, '0').slice(0, len);
  let out = '';
  for (let i = 0; i < len; i += 2) {
    out += (parseInt(left.slice(i, i + 2), 16) ^ parseInt(right.slice(i, i + 2), 16))
      .toString(16)
      .padStart(2, '0');
  }
  return out;
}

function digestEvents(events) {
  return events.reduce((acc, event) => xorHex(acc, eventHash(event)), '0'.repeat(32));
}

module.exports = { eventHash, xorHex, digestEvents };
