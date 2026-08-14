-- Sending signing links, and chasing the people who have not used them.
--
-- The register could always tell the firm what was outstanding. It could not
-- tell the *client*, because the only moment a signing link existed was the
-- instant it was minted — after that only its fingerprint was kept, and a
-- fingerprint cannot be put in an email.
--
-- So a second copy of the link is kept, encrypted with `DOC_SECRET`, purely so
-- that a reminder three days later can carry the same link the first email did.
-- That matters more than it sounds: a client who goes back to the original
-- message and finds it dead telephones instead of signing.
--
-- The trade, stated plainly: a signing link is now recoverable from the
-- database **plus `DOC_SECRET`**, where before it was recoverable from neither.
-- That is exactly the protection attachments already have. Lookup still goes
-- through the hash and never touches the sealed copy, so a stolen database on
-- its own is still not a set of working links — and `DOC_SECRET` lives in the
-- Worker, which is why the setup guide says to keep it where the database
-- backups are not.
--
-- Safe to run more than once apart from the ALTERs, which report "duplicate
-- column name" the second time — harmless, and means the work is already done.

-- The link, encrypted, so a reminder can repeat it.
ALTER TABLE co_envelope_recipients ADD COLUMN token_sealed TEXT;

-- When the invitation actually left the building, as distinct from when their
-- turn came round. The two differ whenever email is off, misconfigured, or
-- simply failed — and "invited but never told" is the state worth being able
-- to see.
ALTER TABLE co_envelope_recipients ADD COLUMN invite_sent_at TEXT;

-- What went wrong last time, if anything did. Kept on the row rather than only
-- in the log because the person chasing a signature needs it on the screen they
-- are already looking at.
ALTER TABLE co_envelope_recipients ADD COLUMN last_email_error TEXT;

INSERT OR IGNORE INTO settings (key, value) VALUES
  -- Email to people outside the firm: signing invitations, reminders, receipts.
  -- On by default *in intent* — it still does nothing at all until a provider
  -- key and a from-address exist, so this switch is for turning it off again.
  ('co_email_recipients', '1'),
  -- Email to the firm's own people, alongside the in-app bell: work routed to
  -- you, something escalating, a client signing or declining.
  ('co_email_staff', '1'),
  -- The name a client sees in their inbox. The address itself is `email_from`,
  -- which every deployment already shares.
  ('co_email_sender_name', ''),
  -- Where a client's reply goes. Blank sends replies to the from-address, which
  -- is usually a no-reply mailbox nobody watches — so this is worth filling in.
  ('co_email_reply_to', '');
