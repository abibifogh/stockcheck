CREATE TABLE IF NOT EXISTS co_envelopes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT    NOT NULL UNIQUE,
  letter_id       INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  subject         TEXT    NOT NULL,
  message         TEXT,
  routing         TEXT    NOT NULL DEFAULT 'sequential',
  status          TEXT    NOT NULL DEFAULT 'draft',
  content_hash    TEXT,
  expires_at      TEXT,
  reminder_days   INTEGER NOT NULL DEFAULT 3,
  last_reminded_at TEXT,
  created_by      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT,
  completed_at    TEXT,
  closed_reason   TEXT
);
CREATE INDEX IF NOT EXISTS idx_co_envelopes_letter ON co_envelopes (letter_id);
CREATE INDEX IF NOT EXISTS idx_co_envelopes_status ON co_envelopes (status);
CREATE TABLE IF NOT EXISTS co_envelope_recipients (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id      INTEGER NOT NULL REFERENCES co_envelopes (id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL DEFAULT 1,
  role             TEXT    NOT NULL DEFAULT 'signer',
  name             TEXT    NOT NULL,
  email            TEXT,
  title            TEXT,
  party_id         INTEGER REFERENCES co_parties (id) ON DELETE SET NULL,
  token_hash       TEXT    NOT NULL UNIQUE,
  access_code_hash TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending',
  invited_at       TEXT,
  first_viewed_at  TEXT,
  completed_at     TEXT,
  decline_reason   TEXT,
  reminded_at      TEXT,
  signed_name      TEXT,
  method           TEXT,
  signature_image  TEXT,
  content_hash     TEXT,
  seal             TEXT,
  ip               TEXT,
  user_agent       TEXT,
  consented_at     TEXT,
  UNIQUE (envelope_id, seq, name)
);
CREATE INDEX IF NOT EXISTS idx_co_recipients_envelope ON co_envelope_recipients (envelope_id, seq);
CREATE INDEX IF NOT EXISTS idx_co_recipients_status   ON co_envelope_recipients (status);
CREATE TABLE IF NOT EXISTS co_envelope_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id  INTEGER NOT NULL REFERENCES co_envelopes (id) ON DELETE CASCADE,
  recipient_id INTEGER REFERENCES co_envelope_recipients (id) ON DELETE SET NULL,
  at           TEXT    NOT NULL DEFAULT (datetime('now')),
  actor        TEXT    NOT NULL,
  action       TEXT    NOT NULL,
  detail       TEXT,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_co_envelope_events ON co_envelope_events (envelope_id, id);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('co_envelope_expiry_days',   '30'),
  ('co_envelope_reminder_days', '3'),
  ('co_signing_disclosure',
   'By signing electronically you agree that your electronic signature is the '
   || 'legal equivalent of your handwritten signature, and that you have read '
   || 'and understood the document above. A record of this signature — the time, '
   || 'your network address and the browser used — is kept with the document.');
ALTER TABLE co_staff ADD COLUMN signature_image TEXT;
ALTER TABLE co_staff ADD COLUMN signature_method TEXT;
ALTER TABLE co_signatures ADD COLUMN envelope_id INTEGER;
ALTER TABLE co_signatures ADD COLUMN recipient_id INTEGER;
ALTER TABLE co_signatures ADD COLUMN email TEXT;
ALTER TABLE co_signatures ADD COLUMN external INTEGER NOT NULL DEFAULT 0;
ALTER TABLE co_envelope_recipients ADD COLUMN token_sealed TEXT;
ALTER TABLE co_envelope_recipients ADD COLUMN invite_sent_at TEXT;
ALTER TABLE co_envelope_recipients ADD COLUMN last_email_error TEXT;
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('co_email_recipients', '1'),
  ('co_email_staff', '1'),
  ('co_email_sender_name', ''),
  ('co_email_reply_to', '');
