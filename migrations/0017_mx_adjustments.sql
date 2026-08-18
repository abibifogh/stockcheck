-- Changing something the parts store already recorded.
--
-- A count needs an administrator's signature, and has since 0007: recounting a
-- store is exactly the moment a shortfall could be quietly written off. But the
-- count was the only thing guarded. Deleting an issue put parts back on the
-- shelf immediately, deleting a delivery took them off, and either could be
-- done the day after a count was agreed — which reopens the same hole from the
-- other side, and leaves the agreed figure looking wrong instead.
--
-- So a change to something already recorded is now a request rather than an
-- act. It is written here, the entry itself does not move, and an administrator
-- accepts or rejects it. Adding a new issue or delivery is untouched: a
-- technician handing out parts this morning is not asking anybody's permission,
-- and never was.
--
-- Modelled on day_revisions, which does the same job for the breakfast sheet,
-- down to keeping a copy of the row as it stood when the request was made.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS mx_adjustments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Which book the entry is in: 'issue' or 'purchase'.
  kind         TEXT NOT NULL,
  -- 'edit' or 'delete'.
  action       TEXT NOT NULL,
  target_id    INTEGER NOT NULL,
  -- The proposed values, for an edit. Null for a delete, which proposes
  -- nothing — it proposes an absence.
  payload      TEXT,
  -- The row as it stood when this was asked for, so the reviewer sees what
  -- would change even if something else lands in between. The same reason
  -- day_revisions keeps one.
  previous     TEXT NOT NULL,
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by  TEXT,
  reviewed_at  TEXT,
  review_note  TEXT
);

CREATE INDEX IF NOT EXISTS idx_mx_adjustments_status ON mx_adjustments (status, id DESC);

-- One open request per entry, enforced here rather than in the handler.
--
-- Two people asking to change the same delivery is not a race anybody should
-- have to reason about: the second is told there is already one waiting, and
-- can look at it. A partial index, so decided requests pile up freely and only
-- the undecided one is unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mx_adjustments_open
  ON mx_adjustments (kind, target_id) WHERE status = 'pending';
