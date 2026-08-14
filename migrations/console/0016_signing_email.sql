ALTER TABLE co_envelope_recipients ADD COLUMN token_sealed TEXT;
ALTER TABLE co_envelope_recipients ADD COLUMN invite_sent_at TEXT;
ALTER TABLE co_envelope_recipients ADD COLUMN last_email_error TEXT;
INSERT OR IGNORE INTO settings (key, value) VALUES
        ('co_email_recipients', '1'),
      ('co_email_staff', '1'),
      ('co_email_sender_name', ''),
      ('co_email_reply_to', '');
