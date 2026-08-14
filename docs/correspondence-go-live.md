# Taking the correspondence system live

A runbook, in the order the work actually has to happen. Each step says what to
do, what to type, and **how to know it worked** before you move on — because the
failures that hurt on a go-live are the ones you find out about three steps
later.

[docs/correspondence-deployment.md](correspondence-deployment.md) is the
reference: what runs where, why the domain works the way it does, what the
platform will and will not do. This file is the sequence. Where the reference
explains something properly, this one points at it rather than saying it worse.

> **Not technical?** Then this is the wrong file. Read
> [correspondence-setup-plain-english.md](correspondence-setup-plain-english.md)
> instead — same job, no command line, every click written out.

**Total hands-on time: about four hours.** Spread over two weeks, because two of
the waits — DNS propagation and mail-domain verification — are not yours to
hurry.

---

## Before anything: the shape of it

| Day | What happens | Waiting on |
| --- | --- | --- |
| −10 | Accounts, keys, database, first deploy on a `workers.dev` address | Nothing — do it all in one sitting |
| −9 | Copy the DNS records, turn DNSSEC off at the registrar | An hour after DNSSEC is off |
| −8 | Move nameservers to Cloudflare | Minutes to 48 hours |
| −7 | Attach the real hostname, verify the mail domain | Minutes to a few hours |
| −6 | Lock it down, configure the practice, load people | Nothing |
| −5 | Load clients, engagements, templates | An afternoon of typing |
| −4 to −1 | Pilot: two real letters and one real signature request | Your own patience |
| 0 | The firm starts using it | — |
| +1 week | The first review | — |

You can compress everything except the two waits.

---

## Stage 1 — Accounts and keys

### 1.1 What you need in front of you

- Node.js 22 and npm.
- A Cloudflare account. Free is enough to start; **Workers Paid at $5/month**
  is what you actually want (see the reference, §11) — CPU limits and D1
  point-in-time recovery both come with it.
- A GitHub account with this repository.
- Your domain, and the sign-in for wherever it is registered.
- A [Resend](https://resend.com) account, if the system is to send email — and
  it should.

```sh
git clone <your fork of this repository>
cd stockcheck
npm install
npx wrangler login
npm test
```

**Know it worked:** `npm test` ends with `pass 363` and `fail 0`. If it does not
pass on your machine it will not pass in CI, and you want to know that now
rather than at the end.

### 1.2 Decide the hostname now

Write it down and do not change it later. The whole guide assumes
`cms.yourfirm.com`.

Use a **subdomain**, not the bare domain. The firm's marketing site keeps the
apex; the register sits beside it. Putting the register on the apex means the
day you change website provider you are also moving the register.

---

## Stage 2 — Database, bucket, secrets

### 2.1 Create the database and the bucket

```sh
npm run co:db:create        # D1 database "correspondence"
npm run co:bucket:create    # R2 bucket "practice-documents"
```

`co:db:create` prints a `database_id`. Paste it into
`wrangler.correspondence.toml`, replacing `REPLACE_WITH_YOUR_DATABASE_ID`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "correspondence"
database_id = "the-id-it-just-printed"
```

Commit that. It is not a secret — it names a database only your account can
reach.

### 2.2 Build the schema

```sh
npm run co:db:migrate
```

**Know it worked:**

```sh
npx wrangler d1 execute correspondence --remote -c wrangler.correspondence.toml \
  --command "SELECT COUNT(*) AS tables FROM sqlite_master WHERE type='table' AND name LIKE 'co_%'"
```

You want **23**. Fewer means the file did not finish; run it again — it is
written to be safe to repeat.

### 2.3 Set the secrets

```sh
openssl rand -base64 48    # run this twice, keep both, they are different keys
```

```sh
npx wrangler secret put SESSION_SECRET -c wrangler.correspondence.toml
npx wrangler secret put DOC_SECRET     -c wrangler.correspondence.toml
npx wrangler secret put MANAGER_PIN    -c wrangler.correspondence.toml
```

`MANAGER_PIN` is digits — six of them, not `123456` — and it is the break-glass
way back in if the last administrator locks themselves out.

> **`DOC_SECRET` is the one that cannot be replaced.** It is behind every
> document seal, every signature, every access code, the sealed copy of each
> signing link, and every attachment's encryption. Rotating it invalidates every
> signature in the register and makes every stored file unreadable. Put it in
> the firm's password manager **and** on paper in the safe, today, before there
> is anything to lose. The reference guide, §4, says the same thing at more
> length; it is worth reading twice.

### 2.4 First deploy, before the domain exists

Comment out the `[[routes]]` block in `wrangler.correspondence.toml` — a deploy
naming a hostname Cloudflare does not yet serve fails outright:

```toml
# [[routes]]
# pattern = "cms.example.com"
# custom_domain = true
```

```sh
npm run deploy:correspondence
```

**Know it worked:** open the
`https://practice-correspondence.<your-subdomain>.workers.dev` address it
printed. You get a sign-in screen. Enter the `MANAGER_PIN` and you are in as
*Recovery access*.

### 2.5 Make yourself a real administrator, immediately

**Users & data → Add somebody.** Name, email address, role **Administrator**,
and a password. Sign out of the recovery session and back in with the email and
password.

From here on, recovery is for emergencies. Everybody else in the firm signs in
with a PIN; administrators use email and password.

**Know it worked:** you can reach **Practice setup**, and the menu shows
Correspondence screens and nothing about a hotel or a bakery. If you see those,
`APP_SITE` is wrong in your config.

---

## Stage 3 — The domain

This is the stage with real constraints in it, and the reference guide covers it
properly at §6 — including the specific case of a domain registered at Wix,
which is a registrar **and** a host, and needs its nameservers moved rather than
its records edited. Read that section before you touch anything.

The order that matters:

1. **Write down every DNS record that exists today.** All of it. Especially
   `MX` — miss those and the firm's email stops arriving, and you will be
   diagnosing that instead of going live.
2. **Turn DNSSEC off at the registrar.** Changing nameservers with DNSSEC on
   makes the domain stop resolving completely. Wait an hour.
3. **Add the site to Cloudflare**, Free plan. Check its imported records against
   your list. The scan is best-effort and misses records regularly.
4. **Point the registrar at Cloudflare's two nameservers.**
5. **Wait.** Usually minutes, occasionally 48 hours. Cloudflare emails you.
6. **Put the `[[routes]]` block back**, with your hostname, and deploy:

   ```toml
   [[routes]]
   pattern = "cms.yourfirm.com"
   custom_domain = true
   ```

   ```sh
   npm run deploy:correspondence
   ```

**Know it worked:**

```sh
curl -sI https://cms.yourfirm.com | head -3
dig +short MX yourfirm.com          # the firm's mail still resolves
```

A `200`, a valid certificate, and your `MX` records still answering. Check the
firm's website still loads too. Then send yourself a test email at the firm
address and confirm it arrives — the point at which people discover broken `MX`
records is otherwise a Monday morning.

---

## Stage 4 — Email

Full detail is in the reference guide, §7. The sequence:

### 4.1 Verify the sending domain

In Resend, add `yourfirm.com` and put the `TXT`, `DKIM` and `MX` records it
gives you into Cloudflare DNS. Verification takes minutes.

**Do not skip this.** An unverified domain means every message bounces or lands
in spam, and a client who never sees a signature request is indistinguishable
from a client who is ignoring you.

### 4.2 Give the Worker the key

```sh
npx wrangler secret put RESEND_API_KEY -c wrangler.correspondence.toml
npm run deploy:correspondence
```

A secret added after a deploy needs a deploy to take effect.

### 4.3 Fill in the Email card

**Practice setup → Email:**

| Field | Put in |
| --- | --- |
| From address | `practice@yourfirm.com` — on the verified domain |
| Sender name | The firm's name, as a client should see it in their inbox |
| Reply-to | The office address a person actually reads |
| Site address | `https://cms.yourfirm.com` — **every link is built from this** |
| Email clients and signers | On |
| Email staff | On |

### 4.4 Prove it

Press **Send a test to myself**. It goes to your address and nowhere else. If
anything is missing it names the missing thing rather than reporting success and
sending nothing.

**Then prove the part that matters**, which the test button does not cover:

1. Register a throwaway outgoing letter.
2. Send it for signature to your own personal email address, outside the firm.
3. Check it arrives, the link opens, and the document reads correctly on a
   phone.
4. Sign it. Check the receipt arrives.
5. Withdraw a second one and confirm the link then explains itself rather than
   simply failing.

A signature request that works from your desk and not from a client's phone is
the single most expensive thing to discover late.

---

## Stage 5 — Locking it down

The reference guide's §9 is the full list. Three of them are not optional for a
system holding client tax affairs:

### 5.1 Cloudflare Access in front of the firm's screens

Zero Trust → Access → Applications → add `cms.yourfirm.com`, require a Google or
Microsoft sign-in on your own domain plus a second factor. Free up to 50 users.
This is the highest-value twenty minutes on the list: it stops a request
reaching the application at all.

**Then exclude the two paths a client uses**, with a bypass policy:

```
/sign
/api/co/sign/*
```

Miss this and every signature request becomes a support call, because the client
has no account to sign in with. Test it from a browser you have never signed in
on.

### 5.2 Two WAF rate limits

| Path | Rule |
| --- | --- |
| `/api/auth/login` | more than 20 requests from one IP per minute → block 1 hour |
| `/api/co/sign/*` | more than 30 requests from one IP per minute → challenge |

The application throttles in-process too, but a Worker isolate is short-lived
and Cloudflare's counter is not.

### 5.3 A backup that is not in the same account

```sh
npx wrangler d1 export correspondence --remote \
  -c wrangler.correspondence.toml --output "co-$(date +%F).sql"
```

Put it somewhere else — a different account, a different provider, an encrypted
drive. D1's point-in-time recovery is useful and it is **not** a backup, because
it lives inside the account that is the thing most likely to be lost.

Keep the backup and `DOC_SECRET` in **different places**. Together they are
everything; apart, neither is enough. Reference §10.

---

## Stage 6 — Setting the practice up

**Practice setup**, in this order, because each step depends on the one above.

1. **Departments.** Give every one a **head** — that is who overdue work
   escalates to. A department with no head escalates to nobody, silently.
2. **Categories.** The eight supplied are a starting point. On each: a prefix
   (it becomes the reference — `TAX-2026-0007`), a default deadline in hours,
   and a retention period in years.
3. **Working days and timings.** Which days count, the default deadline, how far
   ahead of a deadline a reminder goes, and how late something must be before it
   escalates.
4. **Workflows.** Edit the two supplied or write your own, then attach one to a
   category so it starts by itself when a letter in that category is registered.
5. **Templates.** The letters the firm writes over and over. Seven are supplied;
   rewrite them in the firm's own words, on the firm's own terms of business.
   **Have whoever signs the engagement letters read them before go-live.**
6. **People.** Department, title, what appears under their signature, and who
   covers them when they are away.

### 6.1 Add everybody, with their email address

**Users & data.** For each person: name, **email address**, role, PIN.

| Role | For |
| --- | --- |
| Registry clerk | Logs the post in and out and sends it on. No client file, no reports |
| Professional staff | Acts on what is sent to them, keeps action points, attends meetings |
| Manager | The register, the client file, approvals, the numbers |
| Partner | All of that, plus restricted files, practice setup, audit-trail check |
| Administrator | Everything, including managing people |

The email address is not decoration: it is where routing, escalations, task
assignments and receipts go. Somebody without one still sees everything on
screen and still gets the in-app bell, and gets no email.

Give out **partner** sparingly. It is the role that can see restricted files.

### 6.2 Everybody sets their signature

Each person, once, on **My desk → My signature**: draw it, or upload a scan of
their real one. After that, signing anything is one tap. Do this before go-live,
in the same session where you show people the system, or it never happens.

### 6.3 Prove the sweep

**Practice setup → Run the sweep now.** It proves reminders, escalation and
recurring meetings work without waiting for the hour to turn. Everything it does
is safe to repeat.

**Know it worked:** the sweep reports what it did.

Then confirm the *scheduled* one is attached, which is a different question. The
`npm run deploy:correspondence` output lists the schedules it registered — look
for `0 * * * *` in it. Or check the dashboard: *Workers & Pages* →
`practice-correspondence` → *Settings* → *Trigger Events*, which should show one
cron trigger, hourly on the hour.

If it is missing, the `[triggers]` block in `wrangler.correspondence.toml` did
not survive an edit. Deploy again with it back in place. Nothing else in the
system chases anybody, so a missing cron is a register that silently stops
reminding people.

---

## Stage 7 — The data

### 7.1 Clients

**Clients → Add.** By hand. A practice of a hundred clients is one afternoon,
once. Name, type, contact, email, address, tax reference.

Do this properly. A client list with three spellings of the same company is a
register you cannot search.

### 7.2 Engagements

For each live job: client, type (audit, tax, payroll, bookkeeping, advisory,
company secretarial), period, partner, manager, budget hours, fee, and **both
deadlines** — the statutory one and the firm's internal target. They are
separate fields on purpose. Missing your own costs a conversation; missing the
Registrar's costs a penalty.

### 7.3 Do not import history

The temptation is to load last year's correspondence. Resist it. The register
earns its keep going forward; back-filling produces a year of letters with no
routes, no deadlines and no trail, which makes every report wrong and every
number meaningless.

Start from a date. Everything before it stays where it is.

---

## Stage 8 — The pilot

**One week, one department, real work.** Not a test client — a real one, with
one partner and two staff who agreed to it.

Cover all four in the week:

- [ ] A letter registered incoming, routed for action, completed and closed.
- [ ] A letter registered outgoing, sent for approval, approved, marked sent.
- [ ] A **real signature request to a real client**, chased at least once by the
      system, signed, and the certificate printed.
- [ ] A deadline deliberately missed, so escalation fires and the right person
      hears about it.

Then ask the three of them one question: *what did you have to do twice?* That
answer is worth more than any amount of planning, and it is cheap to act on
before forty people are in the system.

**Fix what the pilot found before Stage 9.** A go-live that carries known
friction teaches the firm the system is annoying, and that belief outlives the
fix by about a year.

---

## Stage 9 — Go live

### 9.1 The morning

- [ ] Everybody signs in once and changes their PIN.
- [ ] Everybody sets their signature, if they have not.
- [ ] The registry clerk logs the day's post in the system, and only there.
- [ ] Announce the date the paper register stops. Not "we're moving to the new
      system" — a date, and a person who is answerable for it.

### 9.2 Thirty minutes of training, and no more

Three groups, and each one only needs its own part:

| Group | Show them |
| --- | --- |
| Registry | Registering the post, and sending it on |
| Staff | My desk, acknowledging, completing, action points |
| Managers and partners | Approving, signing, sending for signature, the Overview |

Point everybody at **Help** in the menu. It is written for this system, it knows
who is reading it, and it is the answer to most questions somebody would
otherwise ask you.

### 9.3 The first week

Look at **Overview** every morning:

- Anything unclaimed in a pool for more than a day means nobody has taken it and
  everybody thinks somebody has.
- Anything overdue in week one is usually a deadline set too tight in a
  category, not a person being slow. Fix the category.
- Any signature request emailed but never opened after three days: ring the
  client. The link is fine; the email is in their spam, and you want to know
  that about your sending domain in week one.

Check **Users & data → email log** on day two. Every failure that is going to
happen has happened by then.

---

## Stage 10 — Deploys from here on

Two ways, pick one. The reference guide, §8, has the detail.

**Cloudflare Workers Builds** — connect the repository in the dashboard, deploy
command `npx wrangler deploy -c wrangler.correspondence.toml`. Simplest.

**GitHub Actions** — add `CLOUDFLARE_API_TOKEN` (scoped: Workers Scripts Edit,
D1 Edit, Workers R2 Storage Edit) and `CLOUDFLARE_ACCOUNT_ID` as repository
secrets. `.github/workflows/correspondence.yml` then runs the tests on every
pull request and, on merge to `main`, applies the schema, deploys, and prints
what the database looks like afterwards.

The schema goes on **before** the code, so new code never meets an old database.

**One rule worth keeping:** never deploy on a Friday afternoon, and never deploy
while a signature request is mid-flight with a client who is about to sign.

---

## Ongoing

| How often | What |
| --- | --- |
| Daily, week one | Overview, and the email log |
| Weekly | Unclaimed pool routes; overdue by department |
| Monthly | `wrangler d1 export` to somewhere outside Cloudflare |
| Quarterly | Retention screen — what is past its period, and a person decides |
| Quarterly | Users & data — remove leavers. A leaver with a live PIN is the most common way in |
| Yearly | Re-read the templates. Terms of business change and nobody remembers the template quotes them |

---

## When something is wrong

| Symptom | Almost always |
| --- | --- |
| Site does not resolve | DNSSEC still on at the registrar, or nameservers not propagated yet |
| Deploy fails on an unknown route | The zone is not active on Cloudflare yet. Comment out `[[routes]]`, deploy, put it back once it is |
| Signing links go nowhere | **Site address** is empty or wrong under Practice setup → Email |
| No emails at all | No `RESEND_API_KEY`, or added without a deploy after it. The Email card's banner says which |
| Emails send but land in spam | Sending domain not verified, or SPF/DKIM records missing from Cloudflare DNS |
| A client cannot open their link | Cloudflare Access is in front of `/sign`. Add the bypass policy |
| Uploads refused | No R2 bucket bound. `npm run co:bucket:create`, then deploy |
| Nothing is being chased | The sweep is switched off in Practice setup, or the routes have no deadlines |
| "This cannot be marked as sent" | An approval or signature route is still open. That refusal is why those routes exist |
| Firm's email stopped | An `MX` record did not come across in the nameserver move. Recreate it from the list you wrote down |

Live logs, while you are watching something fail:

```sh
npx wrangler tail -c wrangler.correspondence.toml
```

---

## The go-live checklist

Print this.

**Built**
- [ ] Tests pass locally
- [ ] D1 created, `database_id` committed, 23 `co_` tables present
- [ ] R2 bucket created
- [ ] `SESSION_SECRET`, `DOC_SECRET`, `MANAGER_PIN` set
- [ ] **`DOC_SECRET` backed up in two places, one of them offline**
- [ ] Deployed, reachable, real administrator created, recovery PIN retired

**Connected**
- [ ] Every old DNS record written down before anything changed
- [ ] DNSSEC off, nameservers moved, zone active
- [ ] Hostname serving, certificate valid
- [ ] **Firm's own email still arriving**

**Sending**
- [ ] Mail domain verified
- [ ] `RESEND_API_KEY` set, and deployed after setting it
- [ ] From address, sender name, reply-to, **site address** filled in
- [ ] Test to self arrives
- [ ] **A real signature request opened, and signed, on a phone outside the firm**

**Locked**
- [ ] Access in front of the firm's screens, `/sign` and `/api/co/sign/*` bypassed
- [ ] Both rate limits in place
- [ ] First backup taken, stored outside Cloudflare, apart from `DOC_SECRET`

**Configured**
- [ ] Departments, each with a head
- [ ] Categories: prefix, deadline, retention
- [ ] Working days and timings
- [ ] Workflows written and attached
- [ ] **Templates rewritten in the firm's words and read by whoever signs them**
- [ ] Everybody added, with an email address
- [ ] Everybody's signature saved
- [ ] Sweep run by hand, and the hourly one confirmed

**Loaded**
- [ ] Clients
- [ ] Live engagements, with both deadlines
- [ ] A start date agreed, and no history back-filled

**Proven**
- [ ] A week of real work through one department
- [ ] All four pilot paths exercised
- [ ] What the pilot found is fixed

**Live**
- [ ] Everybody signed in and changed their PIN
- [ ] Thirty minutes of training, by group
- [ ] A date the paper register stops, and a person answerable for it
