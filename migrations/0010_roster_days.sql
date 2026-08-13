-- The roster becomes a record per night, instead of one live value per bed.
--
-- Bookings change through the day: a cancellation frees a bed at noon, a walk-in
-- fills one at six. A single "tonight the roster says" column could hold only
-- the latest answer, which meant this morning's check was judged against a
-- roster written after it — and the bed a guest legitimately vacated at ten
-- looked like a bed found empty when somebody was booked into it.
--
-- So a roster row is a night. `hk_roster` for day D says who should be in each
-- bed on the night of D, which is what both the evening check of D and the
-- morning check of D+1 are looking at.
--
-- `confirmed_at` is the moment that night stopped being a plan and became the
-- record: the person writing today's roster first says how last night actually
-- ended. After that the day is settled and its findings cannot move.

CREATE TABLE IF NOT EXISTS hk_roster (
  day            TEXT NOT NULL,
  bed_id         INTEGER NOT NULL REFERENCES hk_beds (id) ON DELETE CASCADE,
  expected_state TEXT,
  expected_note  TEXT,
  set_by         TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at   TEXT,
  confirmed_by   TEXT,
  PRIMARY KEY (day, bed_id)
);

CREATE INDEX IF NOT EXISTS idx_hk_roster_day ON hk_roster (day);

-- Carry the standing roster over as last night and tonight, so the first check
-- after this upgrade has something to be judged against rather than starting
-- from "nobody is tracked". `hk_beds.expected_state` is not read after this;
-- the column stays because dropping one costs a table rebuild, and it does no
-- harm sitting there.
INSERT OR IGNORE INTO hk_roster (day, bed_id, expected_state, expected_note, set_by)
SELECT date('now', '-1 day'), id, expected_state, expected_note, 'carried over'
FROM hk_beds WHERE expected_state IS NOT NULL;

INSERT OR IGNORE INTO hk_roster (day, bed_id, expected_state, expected_note, set_by)
SELECT date('now'), id, expected_state, expected_note, 'carried over'
FROM hk_beds WHERE expected_state IS NOT NULL;
