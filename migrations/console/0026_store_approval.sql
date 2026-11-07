ALTER TABLE store_requests ADD COLUMN approved_by TEXT;
ALTER TABLE store_requests ADD COLUMN approved_at TEXT;
INSERT OR IGNORE INTO settings (key, value) VALUES ('store_approval', '1');
UPDATE store_requests
   SET status = 'approved', approved_by = 'Before approvals began', approved_at = datetime('now')
 WHERE status = 'waiting';
