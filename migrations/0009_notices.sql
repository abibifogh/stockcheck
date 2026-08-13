-- In-app notifications.
--
-- Every submitted check already sends an email. That is the right thing for a
-- manager who reads their inbox and the wrong thing for one who does not, and
-- an email is also the first thing to fail quietly — a wrong sending domain, a
-- key that expired, a recipient list nobody filled in. When it does, the round
-- was submitted and nobody was told, and nothing on any screen says so.
--
-- So the same events are recorded here as well, where the app itself can show
-- them: a bell with a count, and a list of what has happened since you last
-- looked. It costs one row per submitted check and survives a mail outage.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS app_notices (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  kind    TEXT NOT NULL,                    -- 'hk_round', 'hk_email_failed'
  -- 'info', 'warn' or 'high'. What the row is coloured by, and nothing more:
  -- the reader decides what matters, this only orders the list.
  level   TEXT NOT NULL DEFAULT 'info',
  title   TEXT NOT NULL,
  body    TEXT,
  -- Where the notice goes when tapped, as an in-app route. Held as text rather
  -- than assembled on the way out so a notice always points where it pointed
  -- when it was written.
  link    TEXT,
  day     TEXT,
  slot    TEXT,
  actor   TEXT
);

CREATE INDEX IF NOT EXISTS idx_app_notices_at ON app_notices (id DESC);

-- How far each person has read.
--
-- One row per person rather than one per person per notice: the only question
-- ever asked is "anything new since I last looked", and a table that grows with
-- readers × notices to answer it would be the largest table in the database
-- inside a year.
CREATE TABLE IF NOT EXISTS app_notice_reads (
  user_id INTEGER PRIMARY KEY,
  last_id INTEGER NOT NULL DEFAULT 0,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  -- In-app notices are on unless somebody turns them off; unlike email they
  -- need no address, no domain and no key to work.
  ('notices_enabled', '1');
