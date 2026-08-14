CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  entity     TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('currency',       'GHS'),
  ('timezone',       'Africa/Accra'),
  ('property_name',  'Breakfast Unit'),
  ('default_outsider_fee', '0');
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  pin_hash      TEXT    UNIQUE,
  email         TEXT    UNIQUE,
  password_hash TEXT,
  role          TEXT    NOT NULL DEFAULT 'cook',
  permissions   TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS email_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  kind       TEXT NOT NULL,
  day        TEXT,
  recipients TEXT,
  status     TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_log_at ON email_log (at DESC);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('outsider_fee',       '0'),
  ('allow_fill_usual',   '1'),
  ('notify_on_submit',   '1'),
  ('notify_recipients',  '[]'),
  ('email_from',         ''),
  ('site_url',           ''),
  ('supplier_mode',      'select');
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('require_complete_entry',    '1'),
  ('require_resubmit_approval', '1');
INSERT OR IGNORE INTO settings (key, value)
  VALUES ('pin_pepper', lower(hex(randomblob(32))));
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users (id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);
CREATE TABLE IF NOT EXISTS push_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  day    TEXT,
  sent   INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  detail TEXT,
  at     TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('push_on_submit', '1');
CREATE TABLE IF NOT EXISTS app_notices (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL DEFAULT (datetime('now')),
  kind     TEXT NOT NULL,
  level    TEXT NOT NULL DEFAULT 'info',
  title    TEXT NOT NULL,
  body     TEXT,
  link     TEXT,
  day      TEXT,
  slot     TEXT,
  actor    TEXT,
  audience TEXT
);
CREATE TABLE IF NOT EXISTS app_notice_reads (
  user_id INTEGER PRIMARY KEY,
  last_id INTEGER NOT NULL DEFAULT 0,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('notices_enabled', '1');
CREATE TABLE IF NOT EXISTS co_departments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL UNIQUE,
  code         TEXT    NOT NULL UNIQUE,
  head_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 100
);
CREATE TABLE IF NOT EXISTS co_staff (
  user_id          INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  department_id    INTEGER REFERENCES co_departments (id) ON DELETE SET NULL,
  title            TEXT,
  signature_name   TEXT,
  away_until       TEXT,
  delegate_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS co_parties (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL UNIQUE,
  kind         TEXT    NOT NULL DEFAULT 'client',
  client_code  TEXT,
  tin          TEXT,
  contact_name TEXT,
  email        TEXT,
  phone        TEXT,
  address      TEXT,
  sector       TEXT,
  note         TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_co_parties_kind   ON co_parties (kind, active);
CREATE INDEX IF NOT EXISTS idx_co_parties_active ON co_parties (active);
CREATE TABLE IF NOT EXISTS co_categories (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL UNIQUE,
  prefix           TEXT,
  retention_years  INTEGER NOT NULL DEFAULT 6,
  workflow_id      INTEGER,
  default_due_hours INTEGER,
  sort_order       INTEGER NOT NULL DEFAULT 100,
  active           INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS co_letters (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT    NOT NULL UNIQUE,
  type            TEXT    NOT NULL,
  subject         TEXT    NOT NULL,
  body            TEXT,
  summary         TEXT,
  party_id        INTEGER REFERENCES co_parties (id) ON DELETE SET NULL,
  case_id         INTEGER REFERENCES co_cases (id) ON DELETE SET NULL,
  category_id     INTEGER REFERENCES co_categories (id) ON DELETE SET NULL,
  department_id   INTEGER REFERENCES co_departments (id) ON DELETE SET NULL,
  confidentiality TEXT    NOT NULL DEFAULT 'normal',
  priority        TEXT    NOT NULL DEFAULT 'normal',
  channel         TEXT,
  their_ref       TEXT,
  letter_date     TEXT,
  received_at     TEXT,
  dispatched_at   TEXT,
  due_at          TEXT,
  status          TEXT    NOT NULL DEFAULT 'draft',
  created_by      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_at       TEXT,
  closed_by       TEXT,
  content_hash    TEXT,
  sealed_at       TEXT,
  archived        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_co_letters_status   ON co_letters (status, archived);
CREATE INDEX IF NOT EXISTS idx_co_letters_type     ON co_letters (type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_co_letters_party    ON co_letters (party_id);
CREATE INDEX IF NOT EXISTS idx_co_letters_case     ON co_letters (case_id);
CREATE INDEX IF NOT EXISTS idx_co_letters_due      ON co_letters (due_at);
CREATE INDEX IF NOT EXISTS idx_co_letters_created  ON co_letters (created_at DESC);
CREATE TABLE IF NOT EXISTS co_recipients (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  kind      TEXT    NOT NULL DEFAULT 'to',
  party_id  INTEGER REFERENCES co_parties (id) ON DELETE SET NULL,
  user_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  name      TEXT,
  email     TEXT
);
CREATE INDEX IF NOT EXISTS idx_co_recipients_letter ON co_recipients (letter_id);
CREATE TABLE IF NOT EXISTS co_letter_links (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  other_id  INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  kind      TEXT    NOT NULL DEFAULT 'related',
  at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (letter_id, other_id, kind)
);
CREATE TABLE IF NOT EXISTS co_routes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id        INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL DEFAULT 1,
  from_user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  from_name        TEXT,
  to_user_id       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  to_department_id INTEGER REFERENCES co_departments (id) ON DELETE SET NULL,
  to_permission    TEXT,
  to_name          TEXT,
  action           TEXT    NOT NULL DEFAULT 'action',
  instruction      TEXT,
  due_at           TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending',
  decision         TEXT,
  comment          TEXT,
  acknowledged_at  TEXT,
  completed_at     TEXT,
  completed_by     TEXT,
  escalated_at     TEXT,
  escalated_to     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  reminded_at      TEXT,
  run_id           INTEGER,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_co_routes_letter ON co_routes (letter_id, seq);
CREATE INDEX IF NOT EXISTS idx_co_routes_to     ON co_routes (to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_co_routes_dept   ON co_routes (to_department_id, status);
CREATE INDEX IF NOT EXISTS idx_co_routes_due    ON co_routes (status, due_at);
CREATE TABLE IF NOT EXISTS co_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id     INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  at            TEXT    NOT NULL DEFAULT (datetime('now')),
  actor_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  actor         TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  detail        TEXT,
  prev_hash     TEXT,
  hash          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_co_events_letter ON co_events (letter_id, id);
CREATE TABLE IF NOT EXISTS co_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id   INTEGER REFERENCES co_letters (id) ON DELETE CASCADE,
  case_id     INTEGER REFERENCES co_cases (id) ON DELETE CASCADE,
  meeting_id  INTEGER REFERENCES co_meetings (id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  mime        TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT,
  storage_key TEXT    NOT NULL,
  encrypted   INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT,
  at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_co_attachments_letter  ON co_attachments (letter_id);
CREATE INDEX IF NOT EXISTS idx_co_attachments_case    ON co_attachments (case_id);
CREATE INDEX IF NOT EXISTS idx_co_attachments_meeting ON co_attachments (meeting_id);
CREATE TABLE IF NOT EXISTS co_signatures (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id    INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  route_id     INTEGER REFERENCES co_routes (id) ON DELETE SET NULL,
  user_id      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  name         TEXT    NOT NULL,
  title        TEXT,
  method       TEXT    NOT NULL DEFAULT 'typed',
  image        TEXT,
  content_hash TEXT    NOT NULL,
  seal         TEXT    NOT NULL,
  at           TEXT    NOT NULL DEFAULT (datetime('now')),
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_co_signatures_letter ON co_signatures (letter_id);
CREATE TABLE IF NOT EXISTS co_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  type        TEXT    NOT NULL DEFAULT 'outgoing',
  category_id INTEGER REFERENCES co_categories (id) ON DELETE SET NULL,
  subject     TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  note        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS co_workflows (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL UNIQUE,
  description         TEXT,
  applies_type        TEXT,
  applies_category_id INTEGER REFERENCES co_categories (id) ON DELETE SET NULL,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS co_workflow_steps (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id           INTEGER NOT NULL REFERENCES co_workflows (id) ON DELETE CASCADE,
  seq                   INTEGER NOT NULL,
  name                  TEXT    NOT NULL,
  action                TEXT    NOT NULL DEFAULT 'action',
  to_user_id            INTEGER REFERENCES users (id) ON DELETE SET NULL,
  to_department_id      INTEGER REFERENCES co_departments (id) ON DELETE SET NULL,
  to_permission         TEXT,
  sla_hours             INTEGER NOT NULL DEFAULT 48,
  escalate_after_hours  INTEGER,
  escalate_to_user_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  instruction           TEXT,
  UNIQUE (workflow_id, seq)
);
CREATE TABLE IF NOT EXISTS co_workflow_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id   INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  workflow_id INTEGER NOT NULL REFERENCES co_workflows (id) ON DELETE CASCADE,
  step_seq    INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'running',
  started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_co_runs_letter ON co_workflow_runs (letter_id);
CREATE INDEX IF NOT EXISTS idx_co_runs_status ON co_workflow_runs (status);
CREATE TABLE IF NOT EXISTS co_cases (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ref              TEXT    NOT NULL UNIQUE,
  party_id         INTEGER REFERENCES co_parties (id) ON DELETE SET NULL,
  title            TEXT    NOT NULL,
  engagement_type  TEXT    NOT NULL DEFAULT 'other',
  period_label     TEXT,
  period_end       TEXT,
  statutory_due    TEXT,
  target_due       TEXT,
  partner_user_id  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  manager_user_id  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  status           TEXT    NOT NULL DEFAULT 'planned',
  budget_hours     REAL    NOT NULL DEFAULT 0,
  fee              REAL    NOT NULL DEFAULT 0,
  note             TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_co_cases_party  ON co_cases (party_id);
CREATE INDEX IF NOT EXISTS idx_co_cases_status ON co_cases (status);
CREATE INDEX IF NOT EXISTS idx_co_cases_due    ON co_cases (statutory_due);
CREATE TABLE IF NOT EXISTS co_tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT    NOT NULL,
  detail           TEXT,
  case_id          INTEGER REFERENCES co_cases (id) ON DELETE SET NULL,
  letter_id        INTEGER REFERENCES co_letters (id) ON DELETE SET NULL,
  meeting_id       INTEGER REFERENCES co_meetings (id) ON DELETE SET NULL,
  assignee_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  assignee_name    TEXT,
  created_by       TEXT,
  due_at           TEXT,
  priority         TEXT    NOT NULL DEFAULT 'normal',
  status           TEXT    NOT NULL DEFAULT 'open',
  hours            REAL    NOT NULL DEFAULT 0,
  completed_at     TEXT,
  reminded_at      TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_co_tasks_assignee ON co_tasks (assignee_user_id, status);
CREATE INDEX IF NOT EXISTS idx_co_tasks_case     ON co_tasks (case_id);
CREATE INDEX IF NOT EXISTS idx_co_tasks_due      ON co_tasks (status, due_at);
CREATE TABLE IF NOT EXISTS co_meetings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT    NOT NULL,
  agenda            TEXT,
  starts_at         TEXT    NOT NULL,
  duration_mins     INTEGER NOT NULL DEFAULT 60,
  location          TEXT,
  organiser_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  organiser_name    TEXT,
  case_id           INTEGER REFERENCES co_cases (id) ON DELETE SET NULL,
  letter_id         INTEGER REFERENCES co_letters (id) ON DELETE SET NULL,
  recurrence        TEXT    NOT NULL DEFAULT 'none',
  recurrence_until  TEXT,
  series_id         INTEGER REFERENCES co_meetings (id) ON DELETE CASCADE,
  is_series         INTEGER NOT NULL DEFAULT 0,
  status            TEXT    NOT NULL DEFAULT 'scheduled',
  minutes           TEXT,
  minutes_by        TEXT,
  minutes_at        TEXT,
  reminded_at       TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_co_meetings_start  ON co_meetings (starts_at);
CREATE INDEX IF NOT EXISTS idx_co_meetings_series ON co_meetings (series_id);
CREATE INDEX IF NOT EXISTS idx_co_meetings_case   ON co_meetings (case_id);
CREATE TABLE IF NOT EXISTS co_meeting_attendees (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES co_meetings (id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users (id) ON DELETE CASCADE,
  party_id   INTEGER REFERENCES co_parties (id) ON DELETE CASCADE,
  name       TEXT,
  email      TEXT,
  response   TEXT    NOT NULL DEFAULT 'invited',
  attended   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_co_attendees_meeting ON co_meeting_attendees (meeting_id);
CREATE TABLE IF NOT EXISTS co_numbering (
  prefix TEXT    NOT NULL,
  year   INTEGER NOT NULL,
  next   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (prefix, year)
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('co_firm_name',            'The Practice'),
  ('co_ref_digits',           '4'),
  ('co_escalation_grace',     '24'),
  ('co_reminder_lead',        '24'),
  ('co_working_days',         '1,2,3,4,5'),
  ('co_default_due_hours',    '72'),
  ('co_sweep_enabled',        '1');
INSERT OR IGNORE INTO co_departments (name, code, sort_order) VALUES
  ('Audit & Assurance',   'AUD', 10),
  ('Tax',                 'TAX', 20),
  ('Payroll',             'PAY', 30),
  ('Advisory',            'ADV', 40),
  ('Company Secretarial', 'SEC', 50),
  ('Administration',      'ADM', 60);
INSERT OR IGNORE INTO co_categories (name, prefix, retention_years, default_due_hours, sort_order) VALUES
  ('Tax — assessments and queries', 'TAX', 6,  72,  10),
  ('Audit — client correspondence', 'AUD', 7,  120, 20),
  ('Audit — confirmations',         'CNF', 7,  240, 30),
  ('Payroll',                       'PAY', 6,  48,  40),
  ('Statutory filings',             'STA', 10, 48,  50),
  ('Engagement and fees',           'ENG', 7,  120, 60),
  ('Regulatory and professional',   'REG', 10, 72,  70),
  ('General',                       NULL,  6,  120, 99);
CREATE INDEX IF NOT EXISTS idx_app_notices_at ON app_notices (id DESC);
CREATE INDEX IF NOT EXISTS idx_users_active ON users (active);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users (email);
INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_recovery_pin', '1');
