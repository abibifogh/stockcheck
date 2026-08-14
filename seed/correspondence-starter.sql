-- Starter content for a new practice: templates and two workflows.
--
-- Optional. The system works perfectly well with none of this — but a firm
-- opening the templates screen to find it empty has to invent six letters
-- before it can send one, and a firm that has never seen a workflow run has no
-- idea what the setup screen is asking for. These are examples to edit, not
-- rules: change the wording, change the steps, delete what you do not send.
--
-- Safe to run more than once. Everything is INSERT OR IGNORE against a unique
-- name, so a second run changes nothing and never duplicates.

-- --------------------------------------------------------------- templates --
--
-- Placeholders are {{double_braced}} and filled in when the template is opened
-- against a client and an engagement. Anything the system cannot fill is left
-- on the page as {{like_this}}, so it reads as a blank to complete rather than
-- quietly going out empty.

INSERT OR IGNORE INTO co_templates (name, type, subject, body, note) VALUES
('Engagement letter', 'outgoing',
 'Engagement letter — {{engagement}} ({{period}})',
 'Dear {{client_contact}},

ENGAGEMENT LETTER — {{engagement}}

Thank you for asking {{firm_name}} to act for {{client_name}} in respect of {{engagement}} for the period {{period}}.

This letter sets out the basis on which we will provide those services, our respective responsibilities, and the basis of our fees. Please confirm your agreement by signing and returning the attached copy.

SCOPE
[Describe the work to be carried out.]

YOUR RESPONSIBILITIES
[Records, information and representations to be provided, and the timetable for them.]

OUR RESPONSIBILITIES
[What we will do, and what our work is not.]

FEES
[Basis of charge, and when invoices fall due.]

We look forward to working with you.

Yours sincerely,

{{signer_name}}
{{firm_name}}',
 'The letter that opens every engagement. Edit the four bracketed sections before sending.'),

('Management letter', 'outgoing',
 'Report to management — {{engagement}} ({{period}})',
 'Dear {{client_contact}},

REPORT TO MANAGEMENT — {{client_name}}, {{period}}

In the course of our work on {{engagement}} we noted the following matters. These are not a comprehensive statement of every weakness that may exist, but of those that came to our attention and that we consider should be brought to your notice.

1. [Observation]
   Implication: [what could go wrong]
   Recommendation: [what to do about it]
   Management response: [to be completed by the client]

We would be pleased to discuss any of the above.

Yours sincerely,

{{signer_name}}
{{firm_name}}',
 'Findings from an audit or review, with a column for the client to respond in.'),

('Audit confirmation request — bank', 'outgoing',
 'Bank confirmation request — {{client_name}} as at {{period_end}}',
 'Dear Sir or Madam,

BANK CONFIRMATION REQUEST — {{client_name}} (TIN {{client_tin}})

We are the auditors of {{client_name}} and are conducting the audit for the period ended {{period_end}}.

Our client has authorised you to provide us directly with the following as at {{period_end}}:

  1. Balances on all accounts, whether in credit or overdrawn, with account numbers.
  2. Details of loans, overdrafts and other facilities, with terms and security held.
  3. Details of any guarantees, indemnities or other contingent liabilities.
  4. Details of any assets held as security or for safe custody.
  5. Any other banking relationship not covered above.

Please reply directly to us at the address above, quoting {{engagement_ref}}.

Yours faithfully,

{{signer_name}}
{{firm_name}}',
 'Third-party confirmation. Send under the client''s written authority.'),

('Fee note covering letter', 'outgoing',
 'Fee note — {{engagement}}',
 'Dear {{client_contact}},

Please find enclosed our fee note in respect of {{engagement}} for the period {{period}}.

Our fee has been calculated on the basis set out in our engagement letter. Payment is due within 30 days of the date of this letter.

If any part of the fee note is unclear, please contact us before the due date and we will be glad to go through it with you.

Yours sincerely,

{{signer_name}}
{{firm_name}}',
 'Goes out with the invoice itself as an attachment.'),

('Filing deadline reminder', 'outgoing',
 'Reminder — {{engagement}} falls due on {{statutory_due}}',
 'Dear {{client_contact}},

We write to remind you that the filing deadline for {{engagement}} is {{statutory_due}}.

To meet it we still need the following from you:

  - [Item]
  - [Item]

Please let us have these by [date] so that we have time to complete the work and file on your behalf. Filing late carries a penalty which we would rather you did not incur.

Yours sincerely,

{{signer_name}}
{{firm_name}}',
 'Send well before the date, not the week of it.'),

('Response to a Revenue query', 'outgoing',
 'Response to your query — {{client_name}} (TIN {{client_tin}})',
 'Dear Sir or Madam,

Your reference: {{their_ref}}
Our reference: {{engagement_ref}}

We act for {{client_name}} (TIN {{client_tin}}) and write in response to your letter regarding the above.

[Set out the response, point by point, in the order the query raised them.]

We enclose the supporting documentation referred to above. Should you require anything further, please contact the writer directly.

Yours faithfully,

{{signer_name}}
{{firm_name}}',
 'Answer in the order the query asked. Attach the documents you cite.'),

('Internal memo', 'memo',
 '{{engagement}} — [subject]',
 'To:      [names]
From:    {{signer_name}}
Date:    {{today}}
Subject: [subject]

[Body.]

Action required:
  - [who] to [what] by [when]',
 'Short internal note. The action lines become action points when you record them.');

-- --------------------------------------------------------------- workflows --
--
-- Two, both deliberately short. A workflow with nine steps is a workflow people
-- route around; these are the shapes that actually get used.

INSERT OR IGNORE INTO co_workflows (name, description, applies_type, applies_category_id) VALUES
('Incoming tax correspondence',
 'Anything from the Revenue Authority: acknowledged by Tax, then seen by the engagement partner.',
 NULL,
 (SELECT id FROM co_categories WHERE name = 'Tax — assessments and queries')),
('Outgoing letter — review and sign',
 'A letter the firm is sending: reviewed by a manager, then signed by a partner before it goes out.',
 'outgoing',
 NULL);

INSERT OR IGNORE INTO co_workflow_steps
  (workflow_id, seq, name, action, to_department_id, to_permission, sla_hours, instruction)
VALUES
((SELECT id FROM co_workflows WHERE name = 'Incoming tax correspondence'), 1,
 'Tax to deal with it', 'action',
 (SELECT id FROM co_departments WHERE code = 'TAX'), NULL, 48,
 'Read it, work out what it asks for, and draft the response.'),
((SELECT id FROM co_workflows WHERE name = 'Incoming tax correspondence'), 2,
 'Partner to see it', 'information',
 NULL, 'co_oversight', 72,
 'For your information — no reply needed unless something looks wrong.'),

((SELECT id FROM co_workflows WHERE name = 'Outgoing letter — review and sign'), 1,
 'Manager review', 'review',
 NULL, 'co_approve', 24,
 'Check the figures, the dates and the client''s name before it goes any further.'),
((SELECT id FROM co_workflows WHERE name = 'Outgoing letter — review and sign'), 2,
 'Partner signature', 'sign',
 NULL, 'co_oversight', 48,
 'Sign if you are content. Signing seals the document — after that its text cannot change.');

-- ------------------------------------------------------------------ parties --
--
-- Two examples so the register has something to point at on the first day.
-- Delete them once the real client list is in.

INSERT OR IGNORE INTO co_parties (name, kind, client_code, note) VALUES
('Ghana Revenue Authority', 'authority', NULL, 'Tax assessments, queries and filings.'),
('Registrar-General''s Department', 'authority', NULL, 'Annual returns and company filings.');
