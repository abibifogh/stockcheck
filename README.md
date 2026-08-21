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
served by a second Worker from this same code but its own database — separate
deployments, so neither site can take the other down, and it is not carried on
the breakfast site at all. See *The housekeeping site* under Setup.

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

**Its own site, at `housekeeping.niceoperation.com`.** Not a section of the
breakfast site: its own Worker, its own database, its own people. The breakfast
site does not carry it — no menu, no guide chapter, no permissions to hand out,
and its API answers 404 there. See [§6b](#6b-the-housekeeping-site-housekeepingniceoperationcom).

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
| **Approving counts** | A physical count in either store is a claim about the shelf; accepting it is what corrects the book. Whoever counts is never whoever decides. |
| **Approving corrections** | In the parts store, changing or removing an issue or a delivery is a request rather than an act — it moves nothing until an administrator accepts it. Recording a *new* one stays immediate. Closes the way round a count: an agreed figure could otherwise be undone by deleting the delivery behind it. |
| **Rejections are reversible** | A rejection usually means "not yet" rather than "never", so a turned-down request stays on the same screen and can be accepted later — keeping who asked, when and why, instead of making somebody re-file it. Blocked only where a newer request is open on the same entry. |
| **Email alerts** | A summary of each submitted day sheet, and of each submitted bed check, to whichever addresses you choose — two separate lists, one sender. |
| **Erase a period** | Delete everything recorded between two dates, with a typed confirmation. The panel counts what falls inside the dates first — so many checks, so many beds answered for — and that count comes from the same columns the delete uses, so it cannot promise one thing and do another. Only activity goes: people, settings, the ingredient list and the dorm layout are never touched by a period. |

### For the bakery — a link, and nothing else

Bread baked on the premises is stock arriving; the only difference from a
delivery is that no money changed hands. Without somewhere to record it, the
morning sheet deducts loaves the system never saw arrive and the figure goes
negative every week.

| Feature | What it does |
|---|---|
| **A link** | An administrator issues one per bakery or per phone. It opens a single form listing only what you bake — no account, no PIN, nothing to remember. It shows no costs and reaches nothing else in the system. |
| **Nothing to fill in** | The date is today unless changed, and the link itself says which bakery sent it — so the quantities are all anybody types. |
| **Breakfast and bistro** | A second box, on the items the bistro actually takes and no others — ticked per ingredient under Setup. What the bistro took is recorded, and lands nowhere in breakfast: not on the shelf, not in cost per guest. |
| **Sending again replaces** | A second report for a day replaces the first rather than adding to it, so a wrong number is fixed by sending the day again, and a double tap costs nothing. Scoped per link, so two bakeries never overwrite each other. |
| **Straight into stock** | Production enters the ledger exactly as a delivery does, valued at what a unit costs you to make. It is kept out of Purchases, which is money that actually went to suppliers. |
| **Revocable** | Only a fingerprint of the token is stored, so a link cannot be looked up later. Lost one? Revoke and reissue; what it already sent is untouched. |

There is also a `baker` role for somebody who would rather sign in, and
managers hold the same permission for covering a shift.

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

### 8. Signing in from the group hub (optional)

If the group runs **Insight** — the reporting site that reads this database
alongside attendance, the restaurant and the laundry — somebody who has signed
in there can click through to this site and arrive already signed in.

Nothing needs pasting. Insight's own repository has a workflow that sets both
ends, because both Workers are on the same Cloudflare account:

> **abibifogh/attendance → Actions → Set Insight's secrets → Run workflow**,
> with Insight's address filled in.

It generates a shared secret, puts it on Insight as `SSO_SECRET_BREAKFAST` and
on this Worker as `INSIGHT_SSO_SECRET`, and tells this Worker where to redeem.
Nobody ever reads the value, including that workflow's log.

Then, in Insight under **Accounts → Where each system lives**, set this site's
sign-in address to `https://breakfast.niceoperation.com/sso` and tick the
hand-off.

What arrives is a code, not a person. This site calls Insight back, server to
server, and asks who the code was for. Three rules it follows, which are the
whole reason the arrangement is safe:

- **It never trusts the address bar.** The code carries no identity.
- **It never creates an account.** If Insight names somebody who has no account
  here, they are refused and told so by name. Otherwise whoever controls the hub
  could mint themselves an account in the kitchen's records.
- **It never widens anybody.** The role Insight sends is ignored. What somebody
  may do here is what their row in this database says, exactly as before.

Only accounts with an **email address** can be handed over — the address is the
one identifier the two systems share. The kitchen's PIN accounts have none, and
that is the right answer: a PIN is shared knowledge in a kitchen, and a
hand-off is one person.

Setting these two by hand instead, if you would rather:

```bash
wrangler secret put INSIGHT_SSO_URL      # https://insight.niceoperation.com/api/sso/redeem
wrangler secret put INSIGHT_SSO_SECRET   # the same value as SSO_SECRET_BREAKFAST on Insight
```

The housekeeping deployment redeems as `housekeeping` rather than `breakfast`,
derived from its own `APP_SITE`, so the two need separate secrets and separate
grants and neither can use the other's code.

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
    ledger.js         Weighted-average costing and book stock, shared by both stores
    analytics.js      Breakfast: daily / weekly / monthly / stock analysis
    maintenance.js    Parts store: cost by room and area
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
