'use strict';

const { fail } = require('./errors');
const { assertPeriod, isValidPeriod, normalizeLabel } = require('./money');

const EVENT_TYPES = new Set(['purchase', 'return']);
const ENTITY_CODE_RE = /^[A-Za-z0-9_-]{2,24}$/;

function text(value, field, { max = 200, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('missing_field', `缺少字段 ${field}`, 400, { field });
    return '';
  }
  if (typeof value !== 'string') fail('invalid_field', `${field} 必须是文本`, 400, { field });
  const trimmed = normalizeLabel(value);
  if (required && !trimmed) fail('missing_field', `${field} 不能为空`, 400, { field });
  if (trimmed.length > max) fail('invalid_field', `${field} 过长（最多 ${max} 字符）`, 400, { field });
  return trimmed;
}

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isSafeInteger(n)) fail('invalid_field', `${field} 必须是整数`, 400, { field });
  if (n < min || n > max) fail('invalid_field', `${field} 必须在 ${min}–${max} 之间`, 400, { field });
  return n;
}

function optionalKey(value, field = 'idempotency_key') {
  return text(value, field, { max: 120, required: false });
}

function actor(value) {
  return text(value, 'actor', { max: 40, required: false }) || '演示用户';
}

function eventInput(body) {
  const eventType = text(body.event_type, 'event_type', { max: 20 });
  if (!EVENT_TYPES.has(eventType)) {
    fail('invalid_event_type', 'event_type 必须是 purchase 或 return', 400, { field: 'event_type' });
  }
  const isReturn = eventType === 'return';
  const supplierId = text(body.supplier_id, 'supplier_id', { max: 80, required: !isReturn });
  const entityId = text(body.entity_id, 'entity_id', { max: 80, required: !isReturn });
  const category = text(body.category, 'category', { max: 60, required: !isReturn });
  let period = null;
  if (isReturn) {
    if (body.period) period = assertPeriod(body.period);
  } else {
    period = assertPeriod(body.period);
  }
  if (!Number.isSafeInteger(body.amount_cents) || body.amount_cents <= 0) {
    fail('invalid_amount', 'amount_cents 必须是大于 0 的整数分', 400, { field: 'amount_cents' });
  }
  const occurredAt = text(body.occurred_at, 'occurred_at', { max: 40, required: false }) || new Date().toISOString();
  const event = {
    event_type: eventType,
    supplier_id: supplierId,
    entity_id: entityId,
    category,
    period,
    amount_cents: body.amount_cents,
    occurred_at: occurredAt,
    note: text(body.note, 'note', { max: 300, required: false }),
    actor: actor(body.actor),
    client_request_id: optionalKey(body.client_request_id, 'client_request_id') || null,
    reverses_event_id: null,
  };
  if (eventType === 'return') {
    const reverses = text(body.reverses_event_id, 'reverses_event_id', { max: 80, required: false });
    if (!reverses) fail('missing_field', '退货必须关联原采购事件 reverses_event_id', 400, { field: 'reverses_event_id' });
    event.reverses_event_id = reverses;
  } else if (body.reverses_event_id) {
    fail('invalid_field', '只有退货事件可以填写 reverses_event_id', 400, { field: 'reverses_event_id' });
  }
  event.client_request_id = optionalKey(body.client_request_id, 'client_request_id') || null;
  return event;
}

function supplierInput(body) {
  return {
    name: text(body.name, 'name', { max: 120 }),
    code: text(body.code, 'code', { max: 32 }).toUpperCase(),
    group_id: text(body.group_id, 'group_id', { max: 80 }),
  };
}

function groupInput(body) {
  return {
    name: text(body.name, 'name', { max: 120 }),
    code: text(body.code, 'code', { max: 32 }).toUpperCase(),
  };
}

function entityInput(body) {
  const code = text(body.code, 'code', { max: 24 }).toUpperCase();
  if (!ENTITY_CODE_RE.test(code)) fail('invalid_field', '采购实体代码只能包含字母、数字、下划线和短横线', 400, { field: 'code' });
  return { name: text(body.name, 'name', { max: 120 }), code, active: body.active === false ? 0 : 1 };
}

function contractInput(body) {
  const category = text(body.category, 'category', { max: 60 });
  const groupId = text(body.group_id, 'group_id', { max: 80 });
  const name = text(body.name, 'name', { max: 120 });
  const periodType = text(body.period_type, 'period_type', { max: 20, required: false }) || 'quarter';
  if (periodType !== 'quarter') fail('invalid_field', '当前仅支持按季度累计（period_type=quarter）', 400, { field: 'period_type' });
  if (!Array.isArray(body.tiers)) fail('invalid_field', 'tiers 必须是数组', 400, { field: 'tiers' });
  return { name, group_id: groupId, category, period_type: periodType, tiers: body.tiers };
}

function ruleInput(body) {
  if (!Array.isArray(body.tiers)) fail('invalid_field', 'tiers 必须是数组', 400, { field: 'tiers' });
  return { tiers: body.tiers, note: text(body.note, 'note', { max: 300, required: false }) };
}

function confirmInput(body) {
  const snapshotId = text(body.snapshot_id, 'snapshot_id', { max: 80 });
  const mode = text(body.mode, 'mode', { max: 20, required: false }) || 'exact';
  if (!['exact', 'topup'].includes(mode)) {
    fail('invalid_mode', 'mode 只能是 exact（按快照确认差额）或 topup（补记到当前应得）', 400, { field: 'mode' });
  }
  return {
    snapshot_id: snapshotId,
    mode,
    idempotency_key: text(body.idempotency_key, 'idempotency_key', { max: 120 }),
    actor: actor(body.actor),
    note: text(body.note, 'note', { max: 300, required: false }),
  };
}

function supplierMoveInput(body) {
  return {
    supplier_id: text(body.supplier_id, 'supplier_id', { max: 80 }),
    group_id: text(body.group_id, 'group_id', { max: 80 }),
    reason: text(body.reason, 'reason', { max: 300 }),
    idempotency_key: text(body.idempotency_key, 'idempotency_key', { max: 120 }),
    actor: actor(body.actor),
  };
}

function periodOrNull(value) {
  return value && isValidPeriod(value) ? value : null;
}

module.exports = {
  eventInput,
  supplierInput,
  groupInput,
  entityInput,
  contractInput,
  ruleInput,
  confirmInput,
  supplierMoveInput,
  periodOrNull,
  integer,
  text,
  actor,
};
