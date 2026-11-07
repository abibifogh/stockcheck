-- A manager approves a storeroom request before it is issued.
--
-- A request now goes waiting → approved → issued. "Waiting" means waiting for
-- a manager; the storeroom issues only what has been approved. Who approved,
-- and when, is kept on the request beside who issued it.
--
-- It is a setting (store_approval) rather than a rule, because a property with
-- no manager on the early shift needs to be able to switch it off and let the
-- storeroom issue straight from the request, as before.
ALTER TABLE store_requests ADD COLUMN approved_by TEXT;
ALTER TABLE store_requests ADD COLUMN approved_at TEXT;

INSERT OR IGNORE INTO settings (key, value) VALUES ('store_approval', '1');

-- Requests already waiting when this runs were asked for under the old rule,
-- where waiting meant "for the storeroom". They are let through as approved,
-- so switching this on does not hold up a morning's requests already in the
-- queue.
UPDATE store_requests
   SET status = 'approved', approved_by = 'Before approvals began', approved_at = datetime('now')
 WHERE status = 'waiting';
