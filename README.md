# Breakfast Control

Ingredient usage tracking and consumption analytics for a hotel breakfast unit.

Cooks record what was used each morning in under a minute. Everything else —
cost per guest, week-on-week comparisons, monthly reporting, stock levels and
reorder lists — is derived from that one sheet plus the delivery log.

Runs entirely on Cloudflare: a single Worker serves both the app and the API,
with a D1 (SQLite) database behind it. Deploys from GitHub on every push to
`main`.

---

## What it does

### For the kitchen — one screen, a few taps

- **Guest count first.** In-house and outside (paying) guests are counted
  separately, because the analysis and the economics differ.
- **Everyday items only** by default. Occasional items sit behind "All items",
  so the daily screen stays short.
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
| **Day** | What this morning cost, how it compares with a normal day *of the same weekday*, and which items moved the number. |
| **Week** | This week against last, weekday patterns, biggest risers and fallers, portioning consistency. |
| **Month** | Full report: cost per guest trend, category mix, outsider economics, store movement, best/worst days, projection. |
| **Approvals** | Corrections to days already submitted, shown as a before/after list to accept or reject. |
| **Stock** | Book stock, days of cover, reorder list, physical-count variances. |
| **Purchases** | Delivery log — multi-line, supplier picked from a list, unit costs pre-filled from the last price paid. |

### For the administrator

| Feature | What it does |
|---|---|
| **People** | Individual accounts with their own list of sections they can open, enforced on the server rather than just hidden in the menu. Administrators sign in with an email address and password; cooks and managers use a PIN. |
| **Closed periods** | Lock a date range once it has been reported on. Nothing inside it can be added, changed or deleted — by anyone, including an administrator, until it is reopened. |
| **Bulk entry** | Download a spreadsheet template, fill in a backlog, upload it. Always previews before it writes. |
| **Daily email** | A summary of each submitted day, with the analysis, to whichever addresses you choose. |
| **Erase data** | Clear a trial run before going live, with a typed confirmation. Keeps people, settings and the ingredient list. |

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

### 4b. Turning on the daily email (optional)

Email goes out through [Resend](https://resend.com), which is free at this
volume. Three steps:

1. Create a Resend account and add `niceoperation.com` as a domain. It gives
   you DNS records to add — since the domain is already on Cloudflare, that is
   a few copy-pastes in the Cloudflare DNS screen.
2. Create an API key and give it to the Worker:

   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```

3. In the app, go to **Users & data → Daily email**, set the "from" address to
   something at your verified domain, add the recipients, and press **Send a
   test now**. The result appears in the log underneath.

Without this the app works perfectly; it simply does not send email, and says
so on that screen.

### 5. First deploy

```bash
npm run deploy
```

If the custom domain is not ready yet, comment out the `[[routes]]` block in
`wrangler.toml` for this first deploy — Cloudflare rejects a route for a
hostname it cannot resolve yet. You will get a `*.workers.dev` URL to test on.

### 6. Point the domain at it

The `[[routes]]` block in `wrangler.toml` claims `breakfast.niceoperation.com`.
With the zone already on Cloudflare, deploying creates the DNS record and the
certificate automatically — no manual CNAME needed.

To use a different hostname (say the apex, or `kitchen.niceoperation.com`), edit
the `pattern` in `wrangler.toml` and redeploy.

### 7. Automatic deploys from GitHub

Add two repository secrets under **Settings → Secrets and variables →
Actions**:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → *Edit Cloudflare Workers* template. It needs D1 edit permission too. |
| `CLOUDFLARE_ACCOUNT_ID` | Right-hand sidebar of the Workers section of the dashboard. |

After that, every push to `main` runs the tests and — only if they pass —
applies migrations and deploys.

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
    ledger.js         Weighted-average costing and book stock
    analytics.js      Daily / weekly / monthly / stock analysis
    auth.js           PIN login, signed session cookies
    http.js           JSON responses, input validation
  routes/             API handlers
  util/               Date and statistics helpers
public/               Frontend — plain ES modules, no build step
migrations/           Database schema
test/                 Analytics tests
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
  removed, so past reports stay correct.
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
