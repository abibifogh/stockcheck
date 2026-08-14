-- Sending a document out for signature to people who have no account.
--
-- An engagement letter goes to a client. An audit confirmation goes to a bank.
-- Neither of them is going to create an account in an accounting firm's
-- correspondence system, and asking them to is how a signed engagement letter
-- turns into a printed page, a wet signature and a photograph on a phone.
--
-- So: an envelope. It holds one document, a list of people who have to act on
-- it, and the order they act in. Each person gets a link that is theirs alone.
-- They open it, read what they are signing, sign, and that is the whole
-- interaction — no account, no password, no software.
--
-- Three ideas hold it together:
--
--   The envelope freezes the document.  Its content hash is taken when it is
--   sent, and every signature on it is against that hash. Somebody who signs on
--   Friday has signed exactly what the person who signed on Monday signed.
--
--   The link is the identity, and only its hash is kept.  A copy of the
--   database is not a set of working links. A lost link is not recovered — it
--   is reissued, which invalidates the old one.
--
--   Everything is recorded, including the things that are not actions.  Sent,
--   delivered, opened, signed, declined, reminded, expired — with the address,
--   the time, the network address and the browser. That record is the
--   certificate, and it is what makes the signature worth anything afterwards.
--
-- Safe to run more than once, apart from the four ALTERs at the foot — SQLite
-- has no "ADD COLUMN IF NOT EXISTS", so running those twice reports "duplicate
-- column name", which is harmless and means the work is already done.

CREATE TABLE IF NOT EXISTS co_envelopes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT    NOT NULL UNIQUE,
  letter_id       INTEGER NOT NULL REFERENCES co_letters (id) ON DELETE CASCADE,
  subject         TEXT    NOT NULL,
  -- The covering note the recipient reads before they open the document.
  message         TEXT,

  -- sequential: the next person is only invited once the one before has
  --             finished. This is what a countersigned agreement needs.
  -- parallel:   everybody is invited at once. Right for four directors who all
  --             have to sign the same resolution and are in four countries.
  routing         TEXT    NOT NULL DEFAULT 'sequential',

  -- draft | sent | completed | declined | voided | expired
  status          TEXT    NOT NULL DEFAULT 'draft',

  -- The digest of the letter and its attachments at the moment of sending.
  -- Every signature is sealed against this rather than against the document as
  -- it stands, so a document that moved afterwards is detectable and a document
  -- signed by four people over three weeks is one document, not four.
  content_hash    TEXT,

  expires_at      TEXT,
  -- How often an outstanding recipient is chased. Zero never chases.
  reminder_days   INTEGER NOT NULL DEFAULT 3,
  last_reminded_at TEXT,

  created_by      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT,
  completed_at    TEXT,
  -- Why it ended, when it ended badly: the decline reason, or why it was voided.
  closed_reason   TEXT
);

CREATE INDEX IF NOT EXISTS idx_co_envelopes_letter ON co_envelopes (letter_id);
CREATE INDEX IF NOT EXISTS idx_co_envelopes_status ON co_envelopes (status);

-- Who has to act, in what order, and what they did.
CREATE TABLE IF NOT EXISTS co_envelope_recipients (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id      INTEGER NOT NULL REFERENCES co_envelopes (id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL DEFAULT 1,

  -- signer:   must sign. The envelope is not complete without them.
  -- approver: must agree, and their agreement is recorded, but no signature is
  --           placed. A finance director who authorises but does not execute.
  -- viewer:   receives a copy and is asked for nothing. Recorded as having
  --           opened it, which is occasionally the whole point.
  role             TEXT    NOT NULL DEFAULT 'signer',

  name             TEXT    NOT NULL,
  email            TEXT,
  title            TEXT,
  party_id         INTEGER REFERENCES co_parties (id) ON DELETE SET NULL,

  -- SHA-256 of the link token, never the token. A stolen database is not a
  -- stolen set of signing links, and a link that is lost is reissued rather
  -- than looked up.
  token_hash       TEXT    NOT NULL UNIQUE,
  -- Optional second factor: a short code given to the recipient by some other
  -- route — a phone call, the covering letter — so that a forwarded email is
  -- not on its own enough to sign.
  access_code_hash TEXT,

  -- pending | invited | viewed | signed | declined | cancelled
  --
  -- `pending` means their turn has not come round yet, which only happens on a
  -- sequential envelope. Nothing has been sent to them.
  status           TEXT    NOT NULL DEFAULT 'pending',

  invited_at       TEXT,
  first_viewed_at  TEXT,
  completed_at     TEXT,
  decline_reason   TEXT,
  reminded_at      TEXT,

  -- What they put on it.
  signed_name      TEXT,
  method           TEXT,               -- typed | drawn | uploaded
  signature_image  TEXT,
  -- The envelope's content hash, copied here at the moment of signing. Held
  -- per signature as well as on the envelope so that verifying one signature
  -- never depends on a row somebody could edit afterwards.
  content_hash     TEXT,
  seal             TEXT,
  -- The evidence that makes an electronic signature stand up: where from, on
  -- what, and whether they agreed to sign electronically at all.
  ip               TEXT,
  user_agent       TEXT,
  consented_at     TEXT,

  UNIQUE (envelope_id, seq, name)
);

CREATE INDEX IF NOT EXISTS idx_co_recipients_envelope ON co_envelope_recipients (envelope_id, seq);
CREATE INDEX IF NOT EXISTS idx_co_recipients_status   ON co_envelope_recipients (status);

-- The certificate.
--
-- Separate from `co_events` because the events here belong to people outside
-- the firm and carry evidence — an address, a browser — that has no meaning for
-- an internal action. The letter's own chain still records that an envelope was
-- sent, signed and completed, so the tamper-evident spine covers this too;
-- what lives here is the detail underneath those entries.
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
  -- How long a signing link lives before it stops working. A link that never
  -- expires is a link somebody finds in an inbox in 2031.
  ('co_envelope_expiry_days',   '30'),
  ('co_envelope_reminder_days', '3'),
  -- What a recipient agrees to before they can sign. Editable, because the
  -- right wording is a matter for the firm and its jurisdiction, not for us.
  ('co_signing_disclosure',
   'By signing electronically you agree that your electronic signature is the '
   || 'legal equivalent of your handwritten signature, and that you have read '
   || 'and understood the document above. A record of this signature — the time, '
   || 'your network address and the browser used — is kept with the document.');

-- ---------------------------------------------------------------------------
-- Columns added to tables created in 0014.
--
-- Running these twice reports "duplicate column name". That is harmless and
-- means the work is already done. `seed/correspondence-database.sql` has them
-- folded into the CREATE statements, so a fresh database never runs them.

-- A signature somebody set up once and reuses. Held on the person rather than
-- against each signature, so changing it changes what they sign with next time
-- and changes nothing they have already signed.
ALTER TABLE co_staff ADD COLUMN signature_image TEXT;
ALTER TABLE co_staff ADD COLUMN signature_method TEXT;

-- Signatures can now come from outside the firm, through an envelope.
ALTER TABLE co_signatures ADD COLUMN envelope_id INTEGER;
ALTER TABLE co_signatures ADD COLUMN recipient_id INTEGER;
ALTER TABLE co_signatures ADD COLUMN email TEXT;
ALTER TABLE co_signatures ADD COLUMN external INTEGER NOT NULL DEFAULT 0;
