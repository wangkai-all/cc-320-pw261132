PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL REFERENCES supplier_groups(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_suppliers_group ON suppliers(group_id);

CREATE TABLE IF NOT EXISTS procurement_entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES supplier_groups(id),
  category TEXT NOT NULL,
  period_type TEXT NOT NULL DEFAULT 'quarter',
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'active',
  current_rule_version_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(group_id, category)
);

CREATE TABLE IF NOT EXISTS contract_rule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL REFERENCES contracts(id),
  version INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(contract_id, version)
);

CREATE TABLE IF NOT EXISTS contract_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_version_id INTEGER NOT NULL REFERENCES contract_rule_versions(id),
  threshold_cents INTEGER NOT NULL,
  rate_bps INTEGER NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE(rule_version_id, threshold_cents)
);

CREATE INDEX IF NOT EXISTS idx_tiers_rule ON contract_tiers(rule_version_id, sort_order);

CREATE TABLE IF NOT EXISTS purchase_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('purchase', 'return')),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  entity_id TEXT NOT NULL REFERENCES procurement_entities(id),
  category TEXT NOT NULL,
  period TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  occurred_at TEXT NOT NULL,
  reverses_event_id TEXT REFERENCES purchase_events(id),
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  client_request_id TEXT UNIQUE,
  CHECK (event_type = 'purchase' OR reverses_event_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_events_lookup
  ON purchase_events(period, category, supplier_id, status);
CREATE INDEX IF NOT EXISTS idx_events_supplier ON purchase_events(supplier_id, status);
CREATE INDEX IF NOT EXISTS idx_events_reverses ON purchase_events(reverses_event_id);

CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES supplier_groups(id),
  category TEXT NOT NULL,
  period TEXT NOT NULL,
  contract_id TEXT REFERENCES contracts(id),
  version INTEGER NOT NULL DEFAULT 0,
  eligible_base_cents INTEGER NOT NULL DEFAULT 0,
  gross_cents INTEGER NOT NULL DEFAULT 0,
  returns_cents INTEGER NOT NULL DEFAULT 0,
  rebate_cents INTEGER NOT NULL DEFAULT 0,
  rate_bps INTEGER NOT NULL DEFAULT 0,
  tier_label TEXT,
  tier_threshold_cents INTEGER,
  rule_version_id INTEGER,
  event_count INTEGER NOT NULL DEFAULT 0,
  input_digest TEXT NOT NULL DEFAULT '',
  event_xor TEXT NOT NULL DEFAULT '00000000000000000000000000000000',
  dirty INTEGER NOT NULL DEFAULT 0,
  dirty_reason TEXT,
  computed_at TEXT NOT NULL,
  UNIQUE(group_id, category, period)
);

CREATE INDEX IF NOT EXISTS idx_segments_period ON segments(period);
CREATE INDEX IF NOT EXISTS idx_segments_group_category ON segments(group_id, category);

CREATE TABLE IF NOT EXISTS segment_entity_bases (
  segment_id TEXT NOT NULL REFERENCES segments(id),
  entity_id TEXT NOT NULL REFERENCES procurement_entities(id),
  base_cents INTEGER NOT NULL DEFAULT 0,
  gross_cents INTEGER NOT NULL DEFAULT 0,
  returns_cents INTEGER NOT NULL DEFAULT 0,
  share_cents INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(segment_id, entity_id)
);

CREATE TABLE IF NOT EXISTS calc_snapshots (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments(id),
  segment_version INTEGER NOT NULL,
  rule_version_id INTEGER,
  input_digest TEXT NOT NULL,
  eligible_base_cents INTEGER NOT NULL,
  rebate_cents INTEGER NOT NULL,
  rate_bps INTEGER NOT NULL,
  tier_label TEXT,
  tier_threshold_cents INTEGER,
  tiers_json TEXT NOT NULL DEFAULT '[]',
  allocation_json TEXT NOT NULL,
  confirmable INTEGER NOT NULL DEFAULT 1,
  is_what_if INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'trial' CHECK (status = 'trial'),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_segment ON calc_snapshots(segment_id, created_at);

CREATE TABLE IF NOT EXISTS confirmed_entries (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments(id),
  snapshot_id TEXT REFERENCES calc_snapshots(id),
  entity_id TEXT NOT NULL REFERENCES procurement_entities(id),
  kind TEXT NOT NULL CHECK (kind IN ('confirm', 'topup', 'clawback')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (kind IN ('confirm', 'topup') AND amount_cents > 0) OR
    (kind = 'clawback' AND amount_cents < 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_confirmed_segment ON confirmed_entries(segment_id);
CREATE INDEX IF NOT EXISTS idx_confirmed_entity ON confirmed_entries(segment_id, entity_id);

CREATE TABLE IF NOT EXISTS snapshot_confirmations (
  snapshot_id TEXT PRIMARY KEY REFERENCES calc_snapshots(id),
  segment_id TEXT NOT NULL REFERENCES segments(id),
  ledger_total_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'partially_confirmed'
    CHECK (status IN ('partially_confirmed', 'confirmed')),
  last_mode TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_requests (
  idempotency_key TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments(id),
  snapshot_id TEXT REFERENCES calc_snapshots(id),
  mode TEXT NOT NULL,
  actor TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_confirmed_append_only_update
BEFORE UPDATE ON confirmed_entries
BEGIN
  SELECT RAISE(ABORT, 'confirmed ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_confirmed_append_only_delete
BEFORE DELETE ON confirmed_entries
BEGIN
  SELECT RAISE(ABORT, 'confirmed ledger is append-only');
END;

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  source_event_id TEXT,
  source_supplier_id TEXT,
  request_key TEXT UNIQUE,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_changes_created ON changes(created_at DESC);

CREATE TABLE IF NOT EXISTS change_impacts (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES changes(id),
  segment_id TEXT NOT NULL REFERENCES segments(id),
  segment_label TEXT NOT NULL,
  delta_base_cents INTEGER NOT NULL DEFAULT 0,
  delta_rebate_cents INTEGER NOT NULL DEFAULT 0,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  invalidated_snapshot_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_impacts_change ON change_impacts(change_id);

CREATE TABLE IF NOT EXISTS supplier_group_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  from_group_id TEXT NOT NULL,
  to_group_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  change_id TEXT,
  actor TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recalc_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rule_change', 'full_recompute')),
  contract_id TEXT REFERENCES contracts(id),
  rule_version_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed')),
  reason TEXT NOT NULL DEFAULT '',
  total_items INTEGER NOT NULL DEFAULT 0,
  done_items INTEGER NOT NULL DEFAULT 0,
  batch_size INTEGER NOT NULL DEFAULT 2,
  strategy TEXT NOT NULL DEFAULT 'incremental'
    CHECK (strategy IN ('incremental', 'recompute')),
  events_scanned INTEGER NOT NULL DEFAULT 0,
  batches_done INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  error TEXT,
  change_id TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS recalc_job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES recalc_jobs(id),
  segment_id TEXT NOT NULL REFERENCES segments(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  before_json TEXT,
  after_json TEXT,
  delta_base_cents INTEGER,
  delta_rebate_cents INTEGER,
  events_scanned INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  UNIQUE(job_id, segment_id)
);

CREATE INDEX IF NOT EXISTS idx_job_items_pending ON recalc_job_items(job_id, status);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
