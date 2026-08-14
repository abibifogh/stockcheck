-- Correspondence, cases, tasks and meetings — the accounting firm's registry.
--
-- Everything an accounting practice sends or receives that somebody has to act
-- on: a letter from the Revenue Authority, a client's query about their VAT
-- return, an engagement letter going out for signature, an internal memo about
-- year-end deadlines. Each one gets a reference number, a person responsible, a
-- date it is due, and a record of every hand it passed through.
--
-- Three ideas run through the whole schema:
--
--   The register is the truth.  A letter exists because it was registered, and
--   its reference number is issued once and never reused. Nothing is deleted;
--   things are closed, archived or cancelled.
--
--   Routing is a list, not a state.  "Who has this?" is answered by the routes
--   attached to a letter, each with its own action, deadline and outcome. That
--   is what lets one letter go to three people at once — for action, for
--   information, for approval — which is how correspondence actually moves.
--
--   The trail is append-only and self-checking.  Every event records the hash
--   of the one before it, so a row edited or removed after the fact breaks the
--   chain and the verification screen says exactly where.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------- the firm --

-- Departments: Audit, Tax, Payroll, Advisory, Company Secretarial, Admin.
--
-- A route can be addressed to a department rather than a person, which is what
-- makes "send this to Tax" work when nobody yet knows who in Tax will take it.
-- The head is who an overdue item escalates to.
CREATE TABLE IF NOT EXISTS co_departments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL UNIQUE,
  code         TEXT    NOT NULL UNIQUE,
  head_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 100
);

-- What a person is, over and above their login.
--
-- Separate from `users` because that table is shared with every other site
-- built on this codebase, and a column added there for one site is a column
-- every site carries. The signature name is what appears under a signed
-- letter — "Ama Serwaa, FCCA, Partner" rather than the login name.
CREATE TABLE IF NOT EXISTS co_staff (
  user_id          INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  department_id    INTEGER REFERENCES co_departments (id) ON DELETE SET NULL,
  title            TEXT,
  signature_name   TEXT,
  -- Out of office. While set, new routes addressed to this person are also
  -- shown to the delegate, and escalation reaches the delegate first. Nothing
  -- is reassigned: the work stays theirs, somebody else can just see it.
  away_until       TEXT,
  delegate_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL
);

-- Clients, tax authorities, banks, other auditors — anybody outside the firm.
--
-- One table rather than one per kind: the register asks "who is this from" and
-- the answer is the same shape whether it is a client or the Revenue Authority.
CREATE TABLE IF NOT EXISTS co_parties (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL UNIQUE,
  kind         TEXT    NOT NULL DEFAULT 'client', -- client|authority|bank|auditor|supplier|other
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

-- What a letter is about, and how long it has to be kept.
--
-- Retention matters more here than in most systems: an audit file has a
-- statutory keeping period, and a category that carries the number of years is
-- what lets the archive screen say which files are now past it.
CREATE TABLE IF NOT EXISTS co_categories (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL UNIQUE,
  -- Folded into the reference number when set: TAX-2026-0007 rather than
  -- IN-2026-0007, so a reference read down the phone says what it is about.
  prefix           TEXT,
  retention_years  INTEGER NOT NULL DEFAULT 6,
  -- Registering a letter in this category starts this workflow, if it has one.
  workflow_id      INTEGER,
  -- Hours from registration to the deadline, when nobody sets one by hand.
  default_due_hours INTEGER,
  sort_order       INTEGER NOT NULL DEFAULT 100,
  active           INTEGER NOT NULL DEFAULT 1
);

-- --------------------------------------------------------- the register --

-- One row per letter, memo or circular. The reference number is the identity.
CREATE TABLE IF NOT EXISTS co_letters (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT    NOT NULL UNIQUE,
  -- incoming | outgoing | memo | circular
  type            TEXT    NOT NULL,
  subject         TEXT    NOT NULL,
  body            TEXT,
  summary         TEXT,

  party_id        INTEGER REFERENCES co_parties (id) ON DELETE SET NULL,
  case_id         INTEGER REFERENCES co_cases (id) ON DELETE SET NULL,
  category_id     INTEGER REFERENCES co_categories (id) ON DELETE SET NULL,
  department_id   INTEGER REFERENCES co_departments (id) ON DELETE SET NULL,

  -- normal | confidential | restricted.
  --
  -- `restricted` is the one with teeth: the letter is visible only to the
  -- person who registered it, anybody it has been routed to, and holders of
  -- the oversight permission. Everyone else does not see it in the register at
  -- all — not a locked row, no row.
  confidentiality TEXT    NOT NULL DEFAULT 'normal',
  priority        TEXT    NOT NULL DEFAULT 'normal', -- low|normal|high|urgent
  channel         TEXT, -- email|post|courier|hand|fax|portal

  -- Their reference, from their letterhead. What a client quotes back at you.
  their_ref       TEXT,
  -- The date on the document, which is not the date it arrived.
  letter_date     TEXT,
  received_at     TEXT,
  dispatched_at   TEXT,
  due_at          TEXT,

  -- draft | registered | in_progress | awaiting_approval | approved
  -- | dispatched | closed | cancelled
  status          TEXT    NOT NULL DEFAULT 'draft',

  created_by      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_at       TEXT,
  closed_by       TEXT,
  -- Set when the document is sealed: after that the subject and body are
  -- read-only, because the seal is over their exact bytes.
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

-- Who an outgoing letter is addressed to. Incoming letters use `party_id`
-- above; this is the "To / cc" block on something the firm is sending.
CREATE TABLE IF NOT EXISTS co_recipients (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  kind      TEXT    NOT NULL DEFAULT 'to', -- to|cc|bcc
  party_id  INTEGER REFERENCES co_parties (id) ON DELETE SET NULL,
  user_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  name      TEXT,
  email     TEXT
);

CREATE INDEX IF NOT EXISTS idx_co_recipients_letter ON co_recipients (letter_id);

-- A reply, a follow-up, or simply "see also". Held both ways round by the
-- application so a thread reads in either direction.
CREATE TABLE IF NOT EXISTS co_letter_links (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  other_id  INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  kind      TEXT    NOT NULL DEFAULT 'related', -- reply_to|follow_up|related
  at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (letter_id, other_id, kind)
);

-- ------------------------------------------------------------- routing --

-- Where a letter has been sent inside the firm, and what was asked of them.
--
-- Several rows can be open at once. That is the point: a tax assessment goes to
-- the tax manager for action, the engagement partner for information, and the
-- managing partner for approval, and each of those is a different deadline with
-- a different outcome.
CREATE TABLE IF NOT EXISTS co_routes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id        INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL DEFAULT 1,
  from_user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  from_name        TEXT,
  -- Addressed to exactly one of these three. A person is a person; a
  -- department or a permission is a pool, and the first member of it to
  -- acknowledge claims the route by having their id written into `to_user_id`.
  -- That is what makes "send this to Tax" work before anybody knows who in Tax
  -- will take it, while still ending up with a name against the work.
  to_user_id       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  to_department_id INTEGER REFERENCES co_departments (id) ON DELETE SET NULL,
  to_permission    TEXT,
  to_name          TEXT,

  -- action | review | approve | sign | information
  --
  -- `approve` and `sign` are the two that can block: a letter cannot be
  -- dispatched while either is outstanding.
  action           TEXT    NOT NULL DEFAULT 'action',
  instruction      TEXT,
  due_at           TEXT,

  -- pending | acknowledged | completed | returned | forwarded | cancelled
  status           TEXT    NOT NULL DEFAULT 'pending',
  -- approved | rejected | noted, for the ones that carry a decision
  decision         TEXT,
  comment          TEXT,

  acknowledged_at  TEXT,
  completed_at     TEXT,
  completed_by     TEXT,

  -- Escalation writes here rather than moving the route: the work is still
  -- theirs, somebody senior has simply been told it is late.
  escalated_at     TEXT,
  escalated_to     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  reminded_at      TEXT,

  -- Which workflow step produced this route, when a workflow did.
  run_id           INTEGER,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_co_routes_letter ON co_routes (letter_id, seq);
CREATE INDEX IF NOT EXISTS idx_co_routes_to     ON co_routes (to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_co_routes_dept   ON co_routes (to_department_id, status);
CREATE INDEX IF NOT EXISTS idx_co_routes_due    ON co_routes (status, due_at);

-- ------------------------------------------------------- the audit trail --

-- Every action against a letter, in order, chained by hash.
--
-- `prev_hash` is the hash of the previous event for the same letter and `hash`
-- covers this row's own contents together with it. Editing a past row, or
-- removing one, changes a hash that the next row already committed to — so the
-- verification screen can say not just "this has been altered" but which event
-- the alteration starts at.
--
-- It is not proof against somebody who can rewrite the whole chain. It is proof
-- against the realistic case: a single row quietly changed in a console.
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

-- --------------------------------------------------------- attachments --

-- The scanned letter, the signed engagement letter, the working papers.
--
-- The bytes live in R2 under `key`; only the description lives here. `sha256`
-- is over the plaintext, so it can be compared against a file somebody
-- re-uploads and it is what the document seal covers.
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
  -- 1 when the object in R2 is AES-GCM ciphertext rather than the file itself.
  encrypted   INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT,
  at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_co_attachments_letter  ON co_attachments (letter_id);
CREATE INDEX IF NOT EXISTS idx_co_attachments_case    ON co_attachments (case_id);
CREATE INDEX IF NOT EXISTS idx_co_attachments_meeting ON co_attachments (meeting_id);

-- ---------------------------------------------------------- signatures --

-- Who signed what, and a seal that says the document has not moved since.
--
-- `content_hash` is the digest of the subject, body and attachment hashes at
-- the moment of signing. `seal` is an HMAC of that digest keyed with the
-- installation's signing secret — which lives in the Worker, not the database,
-- so a copy of the database alone cannot mint a valid one.
CREATE TABLE IF NOT EXISTS co_signatures (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id    INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  route_id     INTEGER REFERENCES co_routes (id) ON DELETE SET NULL,
  user_id      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  name         TEXT    NOT NULL,
  title        TEXT,
  -- typed | drawn
  method       TEXT    NOT NULL DEFAULT 'typed',
  -- A data URL of the drawn signature, when there is one.
  image        TEXT,
  content_hash TEXT    NOT NULL,
  seal         TEXT    NOT NULL,
  at           TEXT    NOT NULL DEFAULT (datetime('now')),
  ip           TEXT
);

CREATE INDEX IF NOT EXISTS idx_co_signatures_letter ON co_signatures (letter_id);

-- ------------------------------------------------------------ templates --

-- The letters this firm sends over and over: engagement letters, management
-- letters, audit confirmation requests, fee notes, filing reminders.
--
-- Placeholders are {{double_braced}} and filled from the client, case and
-- today's date when the template is opened.
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

-- ------------------------------------------------------------ workflows --

-- A named sequence of steps a letter goes through.
--
-- Kept as data rather than code because the sequence is a firm's own decision
-- and changes: this year the tax manager reviews before the partner signs, next
-- year a second partner reviews first. Nobody should need a deploy for that.
CREATE TABLE IF NOT EXISTS co_workflows (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL UNIQUE,
  description         TEXT,
  -- What starts it automatically on registration. NULL in both means it is
  -- only ever started by hand.
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
  action                TEXT    NOT NULL DEFAULT 'action', -- action|review|approve|sign|information
  -- Who the step goes to. Exactly one of these three is used, checked in this
  -- order: the named person, then the department, then anybody holding the
  -- permission.
  to_user_id            INTEGER REFERENCES users (id) ON DELETE SET NULL,
  to_department_id      INTEGER REFERENCES co_departments (id) ON DELETE SET NULL,
  to_permission         TEXT,
  sla_hours             INTEGER NOT NULL DEFAULT 48,
  escalate_after_hours  INTEGER,
  escalate_to_user_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  instruction           TEXT,
  UNIQUE (workflow_id, seq)
);

-- One letter travelling through one workflow.
CREATE TABLE IF NOT EXISTS co_workflow_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id   INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  workflow_id INTEGER NOT NULL REFERENCES co_workflows (id) ON DELETE CASCADE,
  step_seq    INTEGER NOT NULL DEFAULT 0,
  -- running | completed | rejected | cancelled
  status      TEXT    NOT NULL DEFAULT 'running',
  started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_co_runs_letter ON co_workflow_runs (letter_id);
CREATE INDEX IF NOT EXISTS idx_co_runs_status ON co_workflow_runs (status);

-- ------------------------------------------------- cases and engagements --

-- The work a letter belongs to: the 2026 audit of Kwame Foods, the monthly
-- payroll for Adom Clinic, an advisory piece with no end date.
--
-- `statutory_due` is deliberately separate from the internal deadline. Missing
-- your own target costs a conversation; missing the Registrar's costs a
-- penalty, and the two should never be the same field.
CREATE TABLE IF NOT EXISTS co_cases (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ref              TEXT    NOT NULL UNIQUE,
  party_id         INTEGER REFERENCES co_parties (id) ON DELETE SET NULL,
  title            TEXT    NOT NULL,
  -- audit | tax | payroll | bookkeeping | advisory | secretarial | other
  engagement_type  TEXT    NOT NULL DEFAULT 'other',
  period_label     TEXT,
  period_end       TEXT,
  statutory_due    TEXT,
  target_due       TEXT,
  partner_user_id  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  manager_user_id  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  -- planned | active | review | on_hold | completed | archived
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

-- ---------------------------------------------------------------- tasks --

-- Action points. Raised by hand, by a letter, or by a meeting's minutes.
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
  -- open | in_progress | blocked | done | cancelled
  status           TEXT    NOT NULL DEFAULT 'open',
  hours            REAL    NOT NULL DEFAULT 0,
  completed_at     TEXT,
  reminded_at      TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_co_tasks_assignee ON co_tasks (assignee_user_id, status);
CREATE INDEX IF NOT EXISTS idx_co_tasks_case     ON co_tasks (case_id);
CREATE INDEX IF NOT EXISTS idx_co_tasks_due      ON co_tasks (status, due_at);

-- ------------------------------------------------------------- meetings --

-- One-off and recurring. A recurring meeting is one row — the series — and the
-- occurrences are generated from it, each its own row pointing back at the
-- series. That way the minutes of the 4th March partners' meeting belong to
-- that morning and not to "the partners' meeting" in general.
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

  -- none | daily | weekly | fortnightly | monthly | quarterly | yearly
  recurrence        TEXT    NOT NULL DEFAULT 'none',
  recurrence_until  TEXT,
  -- The series this occurrence came from. NULL on a one-off and on the series
  -- row itself.
  series_id         INTEGER REFERENCES co_meetings (id) ON DELETE CASCADE,
  -- 1 on the row that defines a series. Series rows never appear in a diary;
  -- their occurrences do.
  is_series         INTEGER NOT NULL DEFAULT 0,

  -- scheduled | held | cancelled
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
  -- invited | accepted | declined
  response   TEXT    NOT NULL DEFAULT 'invited',
  attended   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_co_attendees_meeting ON co_meeting_attendees (meeting_id);

-- ------------------------------------------------------------ numbering --

-- The reference register. One row per prefix per year, holding the next number.
--
-- A row rather than `MAX(ref) + 1`: the maximum of a deleted-from table falls,
-- and a reference number that comes round twice is the one thing a register
-- must never do.
CREATE TABLE IF NOT EXISTS co_numbering (
  prefix TEXT    NOT NULL,
  year   INTEGER NOT NULL,
  next   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (prefix, year)
);

-- --------------------------------------------------------------- defaults --

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('co_firm_name',            'The Practice'),
  -- Digits in the sequence part of a reference: 0004 rather than 4.
  ('co_ref_digits',           '4'),
  -- Hours a route may sit unacknowledged past its deadline before the head of
  -- department is told. Zero escalates the moment it is late.
  ('co_escalation_grace',     '24'),
  -- Hours ahead of a deadline that a reminder goes out.
  ('co_reminder_lead',        '24'),
  -- Working days, as ISO weekday numbers. Deadlines set in hours skip the rest.
  ('co_working_days',         '1,2,3,4,5'),
  ('co_default_due_hours',    '72'),
  -- Turn the daily sweep off without removing the cron trigger.
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
