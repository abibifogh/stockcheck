# Breakfast Control

Ingredient usage tracking and consumption analytics for a hotel breakfast unit.

Cooks record what was used each morning in under a minute. Everything else —
cost per guest, week-on-week comparisons, monthly reporting, stock levels and
reorder lists — is derived from that one sheet plus the delivery log.

Alongside it are two other rounds that work the same way — a few taps from
somebody with no time, and the analysis derived from them: a **maintenance
parts store**, and a **dorm bed check** for hostel rooms. Each has its own
screens and its own permissions, so a housekeeper's PIN opens the bed check and
nothing else.

Runs entirely on Cloudflare: a Worker serves both the app and the API, with a
D1 (SQLite) database behind it. Deploys from GitHub on every push to `main`.

The dorm bed check has its own address, **housekeeping.niceoperation.com**,
served by a second Worker from this same code and the same database — separate
deployments, so neither site can take the other down. See *The housekeeping
site* under Setup.

A third deployment built on the same foundations serves a different business
entirely: a **correspondence management system for an accounting practice** —
the register of letters in and out, engagements, action points and meetings.
It shares only what every deployment needs (signing in, people, notifications)
and has its own database, its own hostname and its own permissions. See
[*The correspondence system*](#the-correspondence-system) below, and
[docs/correspondence-deployment.md](docs/correspondence-deployment.md) for
setting it up on your own domain.

---

## What it does

### For the kitchen — one screen, a few taps

- **Guest count first.** In-house and outside (paying) guests are counted
  separately, because the analysis and the economics differ.
- **Everyday items only** by default. Occasional items sit behind "All items",
  so the daily screen stays short — and an administrator can remove that switch
  entirely for cooks, leaving a short fixed list. Anything already recorded
  stays visible either way, so turning it on never hides a figure somebody
  entered.
- **"Usual" hints.** Each item shows what it normally takes for *today's*
  headcount, learned from the last 28 service days. One tap accepts it.
- **⚡ Fill usual** fills every habitual item at once; the cook adjusts only what
  differed. Nothing is pre-filled silently — a form that arrives pre-answered
  gets rubber-stamped, and the data stops meaning anything.
- **Autosaves** as you go, and falls back to the device's own storage if the
  connection drops, syncing when it returns.

A submission must be **complete**: every everyday item needs a figure before
the day can be sent. Zero is a perfectly good answer — the cook is asked to
confirm any zeros out loud — but a blank is not, because a blank is
indistinguishable from "we forgot" and silently drags every average down.

### For the manager — day, week, month

| View | Answers |
|---|---|
| **Overview** | Where we stand today, and what needs a decision. |
| *(every report)* | **Save as PDF** through the browser's own print dialog — the charts are SVG, so they come out as vector rather than a screenshot. |
| **Day** | What this morning cost, how it compares with a normal day *of the same weekday*, and which items moved the number. |
| **Week** | This week against last, weekday patterns, biggest risers and fallers, portioning consistency. |
| **Month** | Full report: cost per guest trend, category mix, outsider economics, store movement, best/worst days, projection. |
| **Approvals** | Corrections to days already submitted, shown as a before/after list to accept or reject. |
| **Stock** | Book stock, days of cover, reorder list, physical-count variances. Filter the page to one category, or band every table by category. |
| **Purchases** | Delivery log — multi-line, supplier picked from a list, unit costs pre-filled from the last price paid. |

### For housekeeping — the dorm bed check

A separate round, with its own screens, its own permissions and its own email.
It answers one question the breakfast side cannot: **is every occupied bed in
the dorms labelled, and is anything occupied that should not be?**

- **Three checks a day, each its own report.** Reception check when they open
  up, housekeeping check again while the rooms are being done, and reception
  check once more before closing. Each is submitted and emailed on its own, by
  the people who did it. The screen opens on whichever check the clock is in.
- **Two questions per bed.** The person checking opens a room, taps **Free** or
  **Occupied** for each bed, and — only for an occupied bed — answers **does it
  have a name tag?** Any bed can carry a note. Nothing else is asked, and
  nothing is typed unless there is something to say.
- **One tap for an empty room.** "All free" answers every bed in a dorm at
  once; correct the ones that differ.
- **Answers save themselves** as they are given, retry on their own when the
  signal drops in a stairwell, and are pushed if the phone is locked mid-round.
  The round is finished with one **Submit** at the end, which is what sends the
  email.
- **Shared while it runs.** Two people can fill in different parts of the same
  check at once; every bed records who answered for it.
- **An occupied bed is not saved until the tag question is answered.** It stays
  highlighted and is counted in the bar at the foot of the screen, because "we
  did not finish this bed" and "this bed was fine" must never look alike.

The manager's side is built around the findings rather than the activity:

| View | Answers |
|---|---|
| **Dorms** | Where the property stands today: which of the three checks are in, rooms as coloured chips, what is still outstanding, and the last 30 days. |
| **Found and fixed** | Whether a finding survived its day. Checking three times only pays if somebody acts in between, and this is the panel that says whether they did. |
| **Report** | A period, against the period before it — untagged beds, tag compliance, unexpected occupancy, coverage, and who walked what. Exports to CSV. |
| **Every room, every day** | A room-by-day grid, one square per room per day, coloured by the worst thing found. Grey means nobody checked, which is treated as loudly as red. |
| **A room's own page** | Every check ever made in one dorm, bed by bed, with its notes and its history. |
| **Roster** | Tonight's expectation for every bed on one page, saved in one press. Its own permission, so the front desk can keep it without being able to rename or delete a dorm. |
| **Setup** | The rooms and their beds, and the roster alongside them. |

**The roster** is what turns "this bed is occupied" into "this bed should have
been empty". Each bed is marked *should be free*, *should be occupied* or *not
tracked*; a bed left untracked is still checked and still needs a name tag, it
simply raises no surprise either way. It is never shown to the person doing the
round — somebody who knows the expected answer before they look is not checking
— and every check keeps its own copy of what was expected at the time, so
editing tonight's roster cannot rewrite what last Tuesday found.

Keeping the roster and building the dorms are **separate permissions**. The
front desk knows tonight's bookings, and that is no reason to hand them the
screen that renames and deletes rooms; *The roster* on its own gives them the
Roster page and nothing else, and anybody with housekeeping setup holds it
already. Neither walking role gets it by default — that is the whole point of a
blind check — so it is granted per person on the People screen.

**The email** goes out the moment a check is submitted — three times a day,
named for the check it reports — to its own list of recipients. It leads with
every untagged bed by room and bed name, because a count is not something
anybody can act on, then the unexpected occupancy, the rooms with gaps, and
whatever was written down. Underneath it shows the day's other two checks and
what is still outstanding after the last one to look.

**Two ways of being told.** Every submitted check sends its email *and* records
a notice in the app — the 🔔 in the top bar, with an unread count, the headline
number, and a link to that day. They exist together on purpose: an email
reaches somebody who is not looking at the system, and the bell reaches
somebody who is. It also survives what email does not. A wrong sending domain,
an expired key or an empty recipient list is otherwise invisible until somebody
asks why they never heard about Tuesday; the bell says so at the time, naming
the reason, and says plainly that the check itself is safe.

**Why three, and what the system does with them.** A bed found untagged at
eight and tagged by ten was dealt with; the same bed untagged at eight, at
noon and at ten at night was not. Only the second kind is worth anybody's
morning, so every report separates them — and a finding made by the day's
*last* check is never counted against anyone, because nobody had the chance.
Silence is not a fix either: a bed no later check looked at again stays
unresolved rather than quietly clearing itself.

### For the administrator

| Feature | What it does |
|---|---|
| **People** | Individual accounts with their own list of sections they can open, enforced on the server rather than just hidden in the menu. Administrators sign in with an email address and password; cooks and managers use a PIN. |
| **Closed periods** | Lock a date range once it has been reported on. Nothing inside it can be added, changed or deleted — by anyone, including an administrator, until it is reopened. |
| **Bulk entry** | Download a spreadsheet template, fill in a backlog, upload it. Always previews before it writes. |
| **Daily email** | A summary of each submitted day, with the analysis, to whichever addresses you choose. |
| **Erase data** | Clear a trial run before going live, with a typed confirmation. Keeps people, settings and the ingredient list. |
| **Approving counts** | A physical count in any of the three stores is a claim about the shelf; accepting it is what corrects the book. Whoever counts is never whoever decides. |

### For the bakery — a link, and nothing else

Bread baked on the premises is stock arriving; the only difference from a
delivery is that no money changed hands. Without somewhere to record it, the
morning sheet deducts loaves the system never saw arrive and the figure goes
negative every week.

| Feature | What it does |
|---|---|
| **A link** | An administrator issues one per bakery or per phone. It opens a single form listing only what you bake — no account, no PIN, nothing to remember. It shows no costs and reaches nothing else in the system. |
| **Per cycle** | Several reports a day is the normal case. The cycle is guessed from the time and is one tap to change. "Already sent" shows what has gone in today, so a run never gets reported twice. |
| **Straight into stock** | Production enters the ledger exactly as a delivery does, valued at what a unit costs you to make. It is kept out of Purchases, which is money that actually went to suppliers. |
| **Revocable** | Only a fingerprint of the token is stored, so a link cannot be looked up later. Lost one? Revoke and reissue; what it already sent is untouched. |

There is also a `baker` role for somebody who would rather sign in, and
managers hold the same permission for covering a shift.

### For the craft shop — a till

The third store, and the only one that takes money. Cash or card; nothing else
is offered, because nothing else is accepted.

| Feature | What it does |
|---|---|
| **Till** | Tap the goods, choose cash or card, type what the customer handed over and the change appears. A receipt follows the sale, printable from the browser. Prices come from the server, never from the browser. |
| **Voiding** | A wrong sale is voided, never deleted — it stays on the list with who voided it and why, stops counting towards takings, and the stock goes back on the shelf. |
| **Takings** | Revenue and margin together on every screen. Cash and card are separated, because only one of the two can be short at the end of a day. |
| **Stock** | The same weighted-average ledger as the other two stores, plus what the shelf would fetch at today's prices. Dead stock gets as much room as shortages: in a craft shop that is where the money goes. |
| **Staff** | `shop_assistant` opens the till and nothing else in the whole system — and never sees what anything cost the hotel. `shop_manager` runs the shop. |

A product with no selling price cannot be sold: the till greys it out and the
server refuses it. A price of zero is almost always something nobody got round
to pricing, and letting it through means giving stock away at the counter.
| **Email alerts** | A summary of each submitted day sheet, and of each submitted bed check, to whichever addresses you choose — two separate lists, one sender. |
| **Erase a period** | Delete everything recorded between two dates, with a typed confirmation. The panel counts what falls inside the dates first — so many checks, so many beds answered for — and that count comes from the same columns the delete uses, so it cannot promise one thing and do another. Only activity goes: people, settings, the ingredient list and the dorm layout are never touched by a period. |

---

## The correspondence system

A different business on the same foundations: an accounting practice's register
of everything it sends and receives, and the work that hangs off it. Its own
Worker, its own database, its own hostname. The hotel screens are not hidden
there behind a permission — they are absent, and their API answers 404.

Deployed with `npm run deploy:correspondence`. Setting it up, including
connecting a domain bought through Wix, is
[docs/correspondence-deployment.md](docs/correspondence-deployment.md).

### The register

Every letter, memo and circular gets a reference the moment it reaches the desk
— `TAX-2026-0007` — issued from a counter row rather than `MAX(ref) + 1`. A
deleted letter takes its number with it. A gap in a register is a question with
an answer; a repeated number is two letters filed as one.

| Feature | What it does |
|---|---|
| **Registration** | Incoming, outgoing, internal memo, circular. Client, engagement, category, department, channel, their reference, the date on the letter and the date it arrived. The deadline is filled in from the category and can be overridden. |
| **The register** | Filters that compose and live in the URL — overdue, with me, a client, a category, a date range, free text over reference, subject, summary and client name. Paste the URL to a colleague and they see the same list. |
| **Threads** | A letter can be linked to another as a reply, a follow-up or simply related. Held both ways round, so a thread reads from either end. |
| **Archive and retention** | Each category carries a keeping period. Nothing is deleted automatically — a retention policy says how long something must be kept, not how quickly it must be destroyed. The screen lists what is past its period; a person decides. |

### Routing and workflow

"Who has this?" is answered by the routes attached to a letter, not by a status
field. Several can be open at once, which is how correspondence actually moves:
a tax assessment goes to the tax manager for action, the engagement partner for
information, and the managing partner for approval, each with its own deadline
and its own outcome.

| Feature | What it does |
|---|---|
| **Ask for something specific** | For action, for review, for approval, for signature, for information. Approval and signature *block dispatch* — a letter cannot be marked as sent while either is open, which is the whole reason those routes exist. |
| **Pools** | A route can go to a department, or to anyone holding a permission. It stays one route, and the first person to acknowledge it has their name written against it. One route per person in Tax would mean five people each thinking the other four had it. |
| **Acknowledge, complete, return, pass on** | Passing a letter on does not discharge it — the original stays open until you report back. A letter that could be discharged by forwarding would go round the firm until everybody thought somebody else had it. |
| **Workflows** | An ordered list of steps held in the database, not in code. Each step names who it goes to, what is asked, how long they have, and who hears about it if that runs out. A category with a workflow attached starts it on registration, with nothing to press. |
| **Rejection** | Stops the run where it stands and sends the letter back to whoever wrote it — the only person who can act on "no". A rejection must say why; the server refuses one that does not. |
| **Deadlines in working hours** | 24 hours from Friday afternoon is Monday afternoon, not Saturday. Working days are a setting. |
| **Escalation** | Overdue past a grace period and the head of department is told — the step's named person, then the department head, then the late person's own head. It **never reassigns**: moving late work to a partner's queue is how a partner ends up with forty items and the person who was late ends up with none. |
| **Cover** | Somebody away names a delegate. The delegate sees their work and hears about it going late. Nothing is reassigned; the work stays theirs. |
| **The hourly sweep** | Reminders, escalations, action points falling due, meeting reminders, and rolling recurring meetings forward. Everything it does is stamped and idempotent, so a cron that fires twice cannot send the same reminder twice. There is a button in Setup to run it now. |

### Security

| Feature | What it does |
|---|---|
| **Restricted files** | Three levels: normal, confidential, restricted. A restricted letter is **absent** from everybody else's register — not greyed out, not "you may not see this". A row saying a file exists is itself the disclosure, for exactly the letters that get marked restricted. Opening one directly answers 404, the same answer as a letter that does not exist. Only a partner can mark something restricted. |
| **Tamper-evident trail** | Every action against a letter is one row, chained by keyed hash: each entry commits to the one before it. A row edited or deleted in a database console breaks the chain, and *Verify this record* says whether the break is the entry itself or its ancestry, and where it starts. |
| **Signatures** | Four ways: the one you saved, drawn there and then, an uploaded photograph of your real signature, or your name typed. Signing seals the subject, the text and every attachment as they stand, and the letter can no longer be edited — a follow-up is registered instead. The seal is a keyed digest held against `DOC_SECRET`, which lives in the Worker and not in the database, so a stolen copy of the database cannot mint one. |
| **A signature you keep** | Draw it once or upload a scan, and from then on signing is one tap. Held on the person, so replacing it changes what they sign with next time and changes nothing already signed. Everybody has one, not just partners. |
| **Verification tells you two things separately** | *Is the seal genuine* and *has the document moved since it was signed* fail for different reasons and need different answers. Swapping the scanned page behind a signed letter changes nothing in the letters table and is caught anyway, because attachment fingerprints are folded into the digest. |
| **Encrypted attachments** | Files are AES-GCM encrypted inside the Worker before they reach R2, with a key derived per object. The bucket holds ciphertext; one leaked object cannot open the rest. Downloads stream back through the Worker so the confidentiality check runs on every fetch. |
| **Templates** | Engagement letters, management letters, confirmation requests, fee notes, filing reminders. Placeholders are filled from the client and the engagement; anything the system cannot fill is **left on the page** as `{{like_this}}`, because a blank is a letter that goes out with a hole in it. |

### Getting people outside the firm to sign

A client will not create an account in an accounting firm's correspondence
system, and asking them to is how a signed engagement letter turns into a
printed page, a wet signature and a photograph taken on a phone. So a document
goes out in a **request** — one document, a list of people, and the order they
act in — and each person gets a link that is theirs alone.

| Feature | What it does |
|---|---|
| **No account, ever** | The recipient opens a link, reads the document and its attachments, agrees to sign electronically, and signs. There is nothing to install, no password, and no way from that page to anything else in the system. |
| **Three things you can ask** | *Signs* — the request is not finished without them. *Approves* — their agreement is recorded, no signature placed. *Copy only* — sent for information, and nothing ever waits on them. |
| **In order, or all at once** | Sequential is right for a countersigned agreement: the second person cannot sign until the first has. Their link still opens, so they can read what is coming. Parallel is right for four directors in four countries signing one resolution. |
| **Sending freezes the document** | Its text and attachments cannot change while a request is out, and every signature is sealed against the digest taken at the moment of sending. That is what makes four signatures collected over three weeks signatures on *one* document. |
| **Emailed, and shown on screen** | Each recipient is emailed their own link the moment the request is sent. The links also appear in the browser with a copy button, so a firm that has not set email up — or a recipient with no address — is not stuck. |
| **A link that goes astray is reissued** | Which kills the old one on the spot. What is stored is a fingerprint for lookup plus a copy sealed with a key held in the Worker and not in the database, so that a reminder can repeat the link the first email carried instead of breaking it. A database export on its own is not a working set of signatures; an export together with the key would be, and the deployment guide says so rather than leaving you to find out. |
| **Access codes** | Optional per recipient, given to them by some other route. A forwarded email is then not on its own enough to sign. Asked for before the subject line is shown, because "Settlement of the disputed assessment" tells the wrong reader plenty. |
| **Declining** | Requires a reason, ends the request for everybody, and tells the firm immediately. A refusal with no reason leaves nobody able to act. |
| **Chasing without anybody remembering** | Anyone who has not opened, or has opened and not signed, is emailed again on the reminder interval — the same link, so the first email keeps working — with the message saying how long it has been waiting. Links expire, thirty days by default, and an expired request is reported rather than quietly forgotten. |
| **When a send fails, somebody is told** | An unverified domain or a mistyped address is written against that recipient on the letter, in red, and into the email log. A recipient with no address at all is marked *not emailed — send them the link yourself* rather than being silently dropped. |
| **Receipts** | When the last person signs, every signer is emailed a receipt with the sealed document's fingerprint, and the firm is told. |
| **The certificate** | Who was asked, when each of them opened it, from what address and on what browser, what they signed with, and the fingerprint of the exact document. Printable, because the day anybody wants it is the day somebody has asked for evidence. |
| **Withdrawing** | Kills every outstanding link at once, and anybody who opens one is shown the reason — better than a link that silently stops working. |

### Email that goes out on its own

Mail goes over an HTTP API — [Resend](https://resend.com) — because a Worker
cannot open an SMTP socket. Set `RESEND_API_KEY` as a Worker secret, verify the
sending domain, and fill in the **Email** card under *Practice setup*: the from
address, the sender name a client sees, a reply-to that a person actually reads,
and the site address every link is built from. There is a **Send a test to
myself** button that names what is missing rather than reporting success and
sending nothing.

After that, without anybody remembering to: signature requests reach each
recipient as their turn comes round; anyone who has not opened or not signed is
chased on the reminder interval; signers get a receipt when the last signature
lands; a letter routed to a named person, an overdue deadline, a declined or
expired request, and a newly assigned action point all reach the right inbox.

Two switches, deliberately separate — *clients and signers* and *the firm's own
people* — so a practice can have clients chased automatically without filling
its staff's inboxes. A route to a **pool** emails nobody: one route should not
mail an entire department. It still shows on the queue and rings the bell.

Configure none of it and nothing breaks. Nothing is sent, nothing is recorded as
having failed, the in-app bell works as it always did, and every signing link is
still on screen with a copy button. What the system will not do is claim to have
sent something it did not.

### Engagements, action points and meetings

| Feature | What it does |
|---|---|
| **Engagements** | Audit, tax, payroll, bookkeeping, advisory, company secretarial. Client, period, partner, manager, budget hours and fee. The board is sorted by statutory deadline and nothing else — every other ordering is a way of looking at a list; this one is the order in which the firm gets into trouble. |
| **Two deadlines, deliberately** | The statutory deadline is separate from the internal target. Missing your own costs a conversation; missing the Registrar's costs a penalty, and the two should never be the same field. |
| **Action points** | Raised by hand, by a letter, or written straight out of a meeting's minutes. Assignee, deadline, priority, hours. Reminded before they fall due. |
| **Meetings** | One-off or recurring. A recurring meeting is stored once as the rule; the diary holds only the next occurrence, and the sweep adds the one after it as each passes. Generating a year in advance leaves fifty wrong rows behind the first time the time changes. |
| **Minutes make work** | Minutes and action points are recorded in the same dialog. "Ama to write to the Registrar by Friday" typed into a minutes box is a sentence; typed into the rows below it is a thing with a name, a date and a reminder attached. |

### Dashboards and reporting

Turnaround is measured from registration to close, over letters that actually
closed. Averaging in the ones still open would make a growing backlog look like
fast work.

- **Overview** — open, overdue, due within a week, unclaimed pool routes,
  average and worst turnaround, twelve months of volume with incoming against
  outgoing, department load, action-point progress, and the statutory deadline
  board.
- **Productivity** — per person: registered, received, completed, clearance
  rate, average hours to complete, open now, late now, escalated, action points
  done, hours. Hedged on the page itself, because the numbers are easy to
  misread: it is here so a partner asking "is anything stuck with anyone" has
  somewhere to look, not because it is a performance score.
- **Activity** — busiest clients, categories, how correspondence arrived,
  closure rate.
- **Exports** — the register, the engagement board, and the whole audit trail
  with entry hashes, for an inspection visit.

### Who sees what

| Role | Gets |
|---|---|
| **Registry clerk** | Logs the post in and out and sends it on. No client file, no reports. |
| **Professional staff** | Acts on what is sent to them, keeps action points, attends meetings. |
| **Manager** | The register, the client file, approvals and the numbers. |
| **Partner** | All of that, plus restricted files, practice setup and the audit-trail check. |

---

## How the numbers are worked out

Worth reading once, because it determines what the reports mean.

**Costing is weighted moving average.** Each delivery re-blends an ingredient's
unit cost against what was already in the store. A kitchen restocks the same
items constantly and nobody tracks which crate a tomato came from, so an average
is both cheaper to compute and closer to how a chef reasons. A day's cost is
that day's quantity at the average cost in force *on that day* — so a price rise
mid-month shows up when it actually happened.

**Book stock** = opening stock + purchases − recorded usage. It can go negative,
and the system deliberately does not hide that: a negative balance means a
delivery was never keyed in, which is worth knowing.

**"Expected" usage** is the *median* rate per guest over the last 28 service
days, scaled to today's headcount. Median, not mean, so one blow-out morning
does not move the yardstick. Scaling by headcount is what makes a busy Sunday
comparable with a quiet Tuesday.

**Deviations** are flagged only when an item is both more than 25% away from
expectation *and* statistically unusual against its own history — measured with
a median-absolute-deviation z-score, which a single freak day cannot blunt.
Items whose history is essentially constant (always ten loaves) have no usable
spread, so there the percentage alone decides. Items with less than about a
week of history are never flagged; there is not yet enough to compare against.

**Partial periods are compared like for like.** A week in progress is compared
against the same number of elapsed days of the previous week, never against a
full one — otherwise every Tuesday would report a 70% collapse in spend. The
same applies to month-to-date.

**Missing comparisons stay missing.** Where there is no history to compare
against, the reports say so rather than printing a confident "0% change".

**A recorded day does not change quietly.** Once a day has been submitted, a
cook re-submitting it does not overwrite anything — the proposal is parked and
somebody with the Approvals permission compares the two and decides. Managers
and administrators editing directly are trusted to do so.

**Outsider economics.** Outside guests eat the same food, so their attributable
cost is the per-guest food cost times their headcount. Contribution counts food
only — labour, gas and overheads are already being paid for the in-house
service, which is what makes selling the spare covers worthwhile, but the fee
still has to clear the plate cost. The month view states the break-even fee
explicitly.

---

## Setup

Everything below is done once. Budget about twenty minutes.

### 1. Prerequisites

- A Cloudflare account with `niceoperation.com` already on it.
- Node 22+ locally.

```bash
git clone https://github.com/abibifogh/stockcheck.git
cd stockcheck
npm install
npx wrangler login
```

### 2. Create the database

```bash
npm run db:create
```

Copy the `database_id` it prints into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

### 3. Create the schema

```bash
npm run db:migrate          # creates the tables
npm run db:seed             # optional: a starter breakfast catalogue
```

The seed is a reasonable starting catalogue for a Ghanaian hotel breakfast.
Delete what you don't buy and correct the units and par levels in **Setup →
Ingredients** — it is meant as a head start, not a prescription.

**Applying a migration by hand.** If you are pasting into the Cloudflare D1
console rather than running wrangler, use the copies in
[`migrations/console/`](migrations/console/) — not the originals. The console
rejects a paste that begins with a comment (*"Requests without any query are not
supported"*), and every migration here opens with one. Those copies are the same
SQL with the comments stripped; regenerate them with `npm run sql:console` after
adding or editing a migration.

### 4. Set the PINs and session key

Three secrets. The session key should be long and random; the PINs are what
people actually type.

```bash
# A long random string. Rotating it signs everyone out.
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET

npx wrangler secret put COOK_PIN       # kitchen tablet — reports stay hidden
npx wrangler secret put MANAGER_PIN    # reports, purchases, setup
```

Cooks stay signed in for 60 days so the kitchen tablet isn't logging in every
morning; managers re-authenticate every 12 hours.

To change a PIN later, run `wrangler secret put` again with the same name.

Once you add real people under **Users & data**, everyone signs in as
themselves and the shared `COOK_PIN` stops working.

`MANAGER_PIN` keeps working as an emergency way back in. Treat it as the spare
key, not a daily login — and **make it long** (8–10 digits, not `1234`), since
it reaches everything. Once you have an administrator account with an email
address and password, you can switch the recovery PIN off entirely under
**Setup → Emergency access**.

### 4b. Turning on email (optional)

Email goes out through [Resend](https://resend.com), which is free at this
volume. Three steps:

1. Create a Resend account and add `niceoperation.com` as a domain. It gives
   you DNS records to add — since the domain is already on Cloudflare, that is
   a few copy-pastes in the Cloudflare DNS screen.
2. Create an API key and give it to the Worker:

   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```

3. In the app, go to **Users & data → Email alerts**, set the "from" address to
   something at your verified domain, add the recipients, and press **Send a
   test now**. The result appears in the log underneath. The dorm bed check has
   its own recipient list on the same panel; leave it empty and its findings go
   to the same people as the morning sheet.

Without this the app works perfectly; it simply does not send email, and says
so on that screen.

### 5. First deploy

```bash
npm run deploy
```

If the custom domain is not ready yet, comment out the `[[routes]]` block in
`wrangler.toml` for this first deploy — Cloudflare rejects a route for a
hostname it cannot resolve yet. You will get a `*.workers.dev` URL to test on.

Deploying also registers the Cron Trigger in `wrangler.toml` (`0 6 * * *`).
That daily tick is what notices a scheduled maintenance stock count has come
round and tells the people asked to do it. Cron Triggers are included on the
free plan. If it is ever removed or fails, nothing is lost: opening the parts
screen or the maintenance setup screen also notices an overdue count and
announces it then.

### 6. Point the domain at it

The `[[routes]]` block in `wrangler.toml` claims `breakfast.niceoperation.com`.
With the zone already on Cloudflare, deploying creates the DNS record and the
certificate automatically — no manual CNAME needed.

To use a different hostname (say the apex, or `kitchen.niceoperation.com`), edit
the `pattern` in `wrangler.toml` and redeploy.

### 6b. The housekeeping site (housekeeping.niceoperation.com)

The dorm bed check runs at its own address, from a **separate Worker** built
from this same code. Deploying it cannot disturb the breakfast site: different
Worker, different deployment, its own config in `wrangler.housekeeping.toml`.
`wrangler.toml` is not involved and never needs re-deploying for it.

The two share **one database**, so people, PINs, permissions and settings are
entered once and work on both. They do **not** share secrets — every Worker
holds its own — so this one needs its own:

```bash
# Its own session key. Different from the breakfast site's; the two sites are
# different hostnames, so a cookie was never going to cross between them anyway.
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET -c wrangler.housekeeping.toml

# Optional but wise: the emergency way back in, if every account is locked out.
npx wrangler secret put MANAGER_PIN -c wrangler.housekeeping.toml

# Only if the bed check should email its findings.
npx wrangler secret put RESEND_API_KEY -c wrangler.housekeeping.toml
```

Then deploy it:

```bash
npm run db:migrate            # once, if 0007 has not been applied yet
npm run deploy:housekeeping
```

**Without a terminal**, the same two steps are done in the dashboard: paste
`seed/housekeeping-tables.sql` into **D1 → breakfast → Console** to create the
tables, and create the Worker through **Workers → Create → Import a repository**
with the deploy command `npx wrangler deploy -c wrangler.housekeeping.toml`.
That SQL file is the migration with every comment stripped out, because the D1
console rejects a paste it reads as comments alone — it is otherwise identical,
and safe to run twice.

**Running one without pasting anything.** Actions → *Housekeeping database* →
**Run workflow**, pick the file, type `housekeeping` to confirm. It needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the repository secrets,
with D1 edit permission on the token; it runs on nobody's schedule, only when
somebody presses it, and it prints the state of the database afterwards so a
schema change is never something you have to take on trust.

**Which file for which job.** `housekeeping-database.sql` builds a database
from nothing. The `-upgrade-` files move one that already exists, in order:
`housekeeping-upgrade-rounds.sql` (one check a day to three, run once) then
`housekeeping-upgrade-notices.sql` (the in-app bell, safe to repeat).
`test/seed.test.js` asserts that applying every upgrade in turn lands a database
exactly where a fresh one starts, so a new migration that forgets its upgrade
file is caught rather than discovered.

**Setting it up, or upgrading it.** `seed/housekeeping-database.sql` builds a
database from nothing; it skips whatever already exists, which makes it safe to
paste twice but useless for a database part-way along. Moving one that already
holds a check a day to three uses `seed/housekeeping-upgrade-rounds.sql`
instead, which is migration 0008 verbatim and keeps every check already
recorded. Running the schema file at a database of the older shape fails with
"no such column: slot", and `test/seed.test.js` asserts that it does — so the
day it stops being true, the note above has to change with it.

Four things bite when setting this up through the dashboard, all of them once:

- **Root directory** means the folder inside the repository, and the answer is
  `/`. It is not where the branch name goes; a branch name there fails the build
  with "root directory not found".
- **The deploy command must keep its `-c wrangler.housekeeping.toml`.** Without
  it, `wrangler deploy` reads `wrangler.toml` and deploys the *breakfast* Worker
  instead — a build that succeeds while doing the wrong thing, which is worse
  than one that fails.
- **The import form does not ask which branch to build**, so it takes the
  repository's default. If the config file lives on another branch, set the
  branch under Settings → Build first.
- **"Retry build" replays the same snapshot**, so it cannot pick up a branch you
  changed afterwards. Start a fresh build, or push a commit, and check the build
  is labelled with the branch you meant.

Deploying creates `housekeeping.niceoperation.com`, its DNS record and its
certificate, the zone already being on Cloudflare. If the hostname is not ready,
comment out the `[[routes]]` block in `wrangler.housekeeping.toml` for the first
deploy and test on the `*.workers.dev` address it prints.

Both sites serve the same screens and the same permissions decide what anybody
can open; what the housekeeping address changes is what it calls itself. It is
titled **Bed Check**, carries a 🛏 rather than a 🍳, installs to a phone's home
screen under its own name and icon, and opens on the bed check rather than the
breakfast overview. A housekeeper never has to know the other site exists.

### The two sites are independent

They share no database and no secrets. The housekeeping site has its own D1
database, so its own people, its own settings and its own history: deleting a
housekeeper there cannot affect the breakfast site, and the two lists of staff
never have to agree.

`APP_SITE = "housekeeping"` is what makes that deployment housekeeping-only.
The breakfast and maintenance screens are absent from its menu, absent from its
guide, absent from the roles you can hand out on it — and their API answers 404
there rather than quietly operating on an empty database. `test/site.test.js`
holds that line.

To set up its database, paste `seed/housekeeping-database.sql` into the new
database's console. It is every migration that site needs, comments stripped,
without the parts store it does not serve — and safe to run twice.

### 7. Automatic deploys from GitHub

Add two repository secrets under **Settings → Secrets and variables →
Actions**:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → *Edit Cloudflare Workers* template. It needs D1 edit permission too. |
| `CLOUDFLARE_ACCOUNT_ID` | Right-hand sidebar of the Workers section of the dashboard. |

After that, every push to `main` runs the tests and — only if they pass —
applies migrations and deploys.

The workflow deploys the **breakfast** Worker only. The housekeeping site is
deployed with `npm run deploy:housekeeping` when its code changes, which is
deliberate: the two are separate deployments precisely so one cannot take the
other down. Add a second `deploy` step with
`command: deploy -c wrangler.housekeeping.toml` if you would rather both went
out together.

---

## Day-to-day use

**Every morning, the kitchen:** opens the site, taps the guest counts, taps
**Fill usual**, corrects anything that differed, taps **Submit day**.

**Weekly, whoever buys:** records deliveries on the **Purchases** screen. This
is the one habit that matters most — without it, unit costs drift and every
money figure slowly becomes fiction.

**Monthly:** do a physical count on the **Stock** screen. The variance against
book stock is the honest measure of waste, over-portioning and loss. Nothing
else in the system can tell you that, because everything else is derived from
what people *said* they used.

### Getting the data out

Every view exports CSV. Or hit the API directly:

```
/api/export?type=daily&from=2026-07-01&to=2026-07-31
/api/export?type=usage|purchases|stock&from=…&to=…
```

---

## Development

```bash
npm test                    # analytics test suite
npm run dev                 # local server on :8787

# Local database, entirely separate from production:
npm run db:migrate:local
npm run db:seed:local
```

Local development needs a `.dev.vars` file (git-ignored):

```
SESSION_SECRET=anything-for-local-use
COOK_PIN=1111
MANAGER_PIN=9999
```

### Layout

```
src/
  index.js            Worker entry: routing, auth endpoints
  lib/
    ledger.js         Weighted-average costing and book stock, shared by all three stores
    analytics.js      Breakfast: daily / weekly / monthly / stock analysis
    maintenance.js    Parts store: cost by room and area
    shop.js           Craft shop: takings, margin and what is not selling
    auth.js           PIN login, signed session cookies
    http.js           JSON responses, input validation
    housekeeping.js   The dorm bed check: findings, coverage, room-by-day
  routes/             API handlers
  util/               Date and statistics helpers
public/               Frontend — plain ES modules, no build step
migrations/           Database schema
wrangler.toml         The breakfast site
wrangler.housekeeping.toml
                      The housekeeping site: same code, own Worker and hostname
test/                 Analytics and route tests
```

There is no frontend build step and no runtime dependencies. The charts are
hand-written SVG, so the app makes no external requests and nothing can break
in CI over a bumped chart library.

### Adding an analysis

The analytics layer is pure functions over a loaded dataset — `loadDataset(db)`
reads the history once, and `dailyInsights` / `weeklyInsights` /
`monthlyInsights` / `stockReport` derive everything from it. They can be tested
without a database, which is what `test/analytics.test.js` does.

---

## Notes and limits

- **Usage is self-reported.** The system checks it for internal consistency and
  flags what looks wrong, but only a physical stock count can confirm it. Count
  monthly.
- **Costs are only as good as the purchase log.** Ingredients with no recorded
  delivery fall back to the "fallback unit cost" set in Setup.
- **Timezone matters.** The `timezone` setting decides which calendar day a
  morning belongs to. Set it in Setup before the kitchen starts recording.
- **Retired, not deleted.** An ingredient with history is retired rather than
  removed, so past reports stay correct. The same applies to a dorm room or a
  bed that has ever been checked.
- **A free bed is never a missing name tag.** The tag question is only asked of
  an occupied bed, and its absence is stored as "not asked" rather than "no".
  Tag compliance is therefore measured against occupied beds, never against
  every bed — otherwise an empty week would look like a triumph.
- **Not checked is not the same as clean.** A bed nobody answered for, or a room
  nobody opened, is reported as a gap in its own right and shown in grey on the
  room-by-day grid. Coverage sits beside every other figure so a spotless week
  on a quarter of the beds cannot be mistaken for a spotless week.
- **The roster is snapshotted onto each check.** Editing tonight's expected
  occupancy cannot change which of last week's beds counted as a surprise.
- **Two ways to sign in, chosen by role.** A PIN is right for a cook at a
  tablet with flour on their hands. It is not right for an account that can see
  every cost, manage people and erase data, so administrators use an email
  address and a password. An administrator cannot sign in with a PIN even if
  one was set earlier — promoting somebody retires their PIN.
- **Password stretching happens in the browser, not on the server.** A Worker
  gets 10ms of CPU per request on Cloudflare's free plan; 600,000 PBKDF2 rounds
  costs roughly 90ms. Doing it server-side means either a login that fails
  outright or a work factor too low to be worth having. So the browser derives
  a key (PBKDF2-SHA256, 600k rounds, per-password salt) and the server keeps a
  peppered HMAC of that key, which costs microseconds. An attacker with the
  whole database still has to run the full 600,000 rounds for every guess,
  which is where the protection actually comes from — and the raw password
  never leaves the browser.
- **Everyone changes their own credentials** under "My account". A credential
  only an administrator can change is a credential nobody ever changes.
- **A user PIN can never match the server's recovery PIN.** It would shadow it
  and quietly destroy the owner's way back in. The refusal is worded exactly
  like "a colleague already has that PIN", so nobody can probe for it.
- **Every save is attributed.** Day sheets, deliveries, approvals and deletions
  all record who did them. The audit log under Users & data is the full trail.
- **Locks beat everyone.** A closed period cannot be written to by any role.
  This is deliberate: the point of closing a month is that its numbers stop
  moving. Reopening is possible, and is itself recorded.
- **Imports always preview.** A bulk import shows exactly which days it will
  create, replace or skip before it writes anything.
