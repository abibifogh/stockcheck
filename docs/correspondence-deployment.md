# Running the correspondence system on GitHub and Cloudflare

Everything the practice needs runs on two accounts: GitHub holds the code and
runs the tests, Cloudflare runs the application, the database, the files and the
scheduled sweep. There is no server to patch, no container to keep alive, and
nothing that stops working when a laptop is closed.

This guide takes a fresh Cloudflare account to a working system on your own
domain, including the part most people get stuck on — connecting a domain bought
through Wix.

---

## 1. What runs where

| Piece | Where | What it is |
| --- | --- | --- |
| Application and API | **Cloudflare Workers** | `src/` — one Worker serving both the API and the screens |
| Screens | **Workers static assets** | `public/` — plain HTML, CSS and ES modules; nothing to build |
| Database | **Cloudflare D1** | SQLite. The register, engagements, action points, meetings, the audit trail |
| Attachments | **Cloudflare R2** | Scanned letters and working papers, AES-GCM encrypted before they are written |
| Reminders and escalation | **Workers Cron Triggers** | Hourly sweep — reminders, escalations, recurring meetings |
| Email (optional) | **Resend** over HTTPS | Workers cannot open an SMTP socket; mail goes out over an HTTP API |
| Source, review, CI/CD | **GitHub** | Tests on every pull request; deploy on merge to `main` |
| DNS, TLS, WAF | **Cloudflare** | Certificates are issued and renewed for you |

The practice is its own Worker with its own database, deployed from
`wrangler.correspondence.toml`. Deploying it cannot touch the other two sites
built from this repository, and their databases are entirely separate.

---

## 2. Before you start

You need:

- Node.js 22 and npm, locally.
- A Cloudflare account (the free plan is enough to start; see §10).
- A GitHub account with this repository.
- Your domain. If it is at Wix, read §6 before you do anything to it.

Sign in to Cloudflare from your machine once:

```sh
npm install
npx wrangler login
```

---

## 3. Create the database and the bucket

```sh
npm run co:db:create        # creates the D1 database called "correspondence"
npm run co:bucket:create    # creates the R2 bucket "practice-documents"
```

`co:db:create` prints a `database_id`. Put it into `wrangler.correspondence.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "correspondence"
database_id = "paste-the-id-here"
```

Then build the schema:

```sh
npm run co:db:migrate       # the tables
npm run co:db:seed          # optional: example templates and two workflows
```

Both files are written to be safe to run again. `co:db:migrate` runs on every
deploy from GitHub, which is what keeps a new deployment from meeting an old
database.

> **R2 is optional.** Without it everything works except uploading files, and
> the upload button says so in plain words. Add it whenever you like — nothing
> already registered has to change.

---

## 4. Set the secrets

Three secrets, none of which belong in the repository:

```sh
npx wrangler secret put SESSION_SECRET  -c wrangler.correspondence.toml
npx wrangler secret put DOC_SECRET      -c wrangler.correspondence.toml
npx wrangler secret put MANAGER_PIN     -c wrangler.correspondence.toml   # optional
npx wrangler secret put RESEND_API_KEY  -c wrangler.correspondence.toml   # optional
```

- **`SESSION_SECRET`** — a long random string. It signs the session cookie.
  Changing it signs everybody out, which is exactly what you want if a laptop
  is lost.
- **`DOC_SECRET`** — the key behind every document seal, every signature and
  every attachment's encryption. **Set it once and never change it.** Rotating
  it invalidates every existing signature and makes every stored file
  undecryptable. It is deliberately a separate variable from `SESSION_SECRET`
  so that rotating the session key — a routine thing — cannot take the
  documents with it.
- **`MANAGER_PIN`** — the break-glass way back in if the last administrator
  locks themselves out.
- **`RESEND_API_KEY`** — only if you want email as well as the in-app bell.

Generate them with something you trust:

```sh
openssl rand -base64 48
```

**Back `DOC_SECRET` up somewhere a fire cannot reach.** Losing it does not lose
the register — the letters, the trail and the routing are all in D1 — but it
loses the ability to read attachments and to verify signatures.

---

## 5. First deploy, before the domain exists

Comment out the `[[routes]]` block in `wrangler.correspondence.toml` — a deploy
naming a hostname Cloudflare does not yet serve fails outright — and deploy:

```sh
npm run deploy:correspondence
```

You get a `https://practice-correspondence.<your-subdomain>.workers.dev`
address. Sign in with the `MANAGER_PIN` you set, create a real administrator
account under **Users & data**, and stop using the recovery PIN.

Set the firm's name, working days and escalation timings under
**Practice setup**.

---

## 6. Connecting a Wix domain

This is the part with real constraints in it, so it is worth being precise.

### The constraint

A Cloudflare Worker can serve a custom hostname only if **Cloudflare is the
authoritative DNS for that zone**. Cloudflare has to terminate TLS for the
hostname, and it will only do that for a zone it answers for. Pointing a CNAME
at a Worker from somebody else's DNS does not work. (Cloudflare's partial
"CNAME setup" exists but needs a Business plan, and is not worth buying for
this.)

Wix is a **registrar as well as a host**. That distinction is the whole answer:
you do not have to move the registration, and you do not have to give up the
Wix site. You only have to move **where the domain's DNS is answered from**.

### The recommended route: keep Wix as registrar, move DNS to Cloudflare

**Before you touch anything, write down every DNS record Wix currently holds.**
Wix → *Domains* → your domain → *DNS Records*. Copy all of it — particularly:

- `MX` records, if you have email on the domain (Google Workspace, Wix Mail,
  anything). **Miss these and email stops arriving.**
- `TXT` records for SPF, DKIM and DMARC.
- Any `CNAME` for verification (Google, Microsoft, a payment provider).
- The `A` and `CNAME` records serving the Wix site itself.

Then:

1. **Turn DNSSEC off at Wix**, if it is on. Changing nameservers while DNSSEC is
   enabled makes the domain fail to resolve entirely — not slowly, not
   partially, completely. Wait an hour after disabling before continuing.
2. In Cloudflare: **Add a site**, enter your domain, choose the Free plan.
   Cloudflare scans your existing DNS and imports what it can find. **Check the
   import against the list you wrote down** — the scan is best-effort and misses
   records regularly.
3. Cloudflare gives you two nameservers, e.g. `ana.ns.cloudflare.com` and
   `bob.ns.cloudflare.com`.
4. In Wix: *Domains* → your domain → **Advanced** → **Name Servers** → choose to
   use external / another provider's nameservers, and enter Cloudflare's two.
   Save.
5. Wait. Propagation is usually minutes and occasionally 24–48 hours. Cloudflare
   emails you when the zone goes active.
6. Once the zone is active, put the `[[routes]]` block back in
   `wrangler.correspondence.toml` with your hostname, and deploy:

   ```toml
   [[routes]]
   pattern = "cms.yourfirm.com"
   custom_domain = true
   ```

   ```sh
   npm run deploy:correspondence
   ```

   Cloudflare creates the DNS record and issues the certificate itself. There is
   nothing to configure and no certificate to renew.

The domain stays registered at Wix. You keep paying Wix for it, you renew it at
Wix, and the WHOIS record does not change.

### Keeping the Wix site as well

This is the usual arrangement, and it works: the marketing site stays on Wix at
`yourfirm.com` and `www.yourfirm.com`, and the correspondence system lives at
`cms.yourfirm.com`.

Once Cloudflare is answering for the zone, recreate Wix's own pointing records
in Cloudflare DNS. Wix publishes the current values under *Domains* → your
domain → *Connect via pointing* — **copy them from there rather than from any
guide, including this one**, because Wix changes them. It will be an `A` record
at the root and a `CNAME` for `www`.

Two things matter:

- **Set the Wix records to "DNS only" — the grey cloud, not the orange one.**
  Proxying a Wix-hosted site through Cloudflare breaks Wix's own certificate
  handling and its site-verification checks. Wix must see the traffic directly.
- **Leave `cms` proxied — orange cloud.** That is the record the Worker uses,
  and proxying is what gives you the WAF, rate limiting and the certificate.

### Limitations, and what to do about each

| What gets in the way | Why | What to do |
| --- | --- | --- |
| Workers custom domains need Cloudflare DNS | Cloudflare must terminate TLS for the hostname | Move nameservers (§6). This is the whole reason for doing it. |
| Changing nameservers breaks Wix email | The `MX` records lived at Wix and do not come with you | Copy every record **before** switching; recreate them in Cloudflare DNS the same day |
| DNSSEC left on during the switch | The old signatures no longer match the new nameservers | Disable DNSSEC at Wix first, wait an hour, then switch. Re-enable in Cloudflare afterwards if you want it. |
| The domain came free with a Wix Premium plan | Wix keeps the free registration tied to an active plan | Nameservers can still usually be changed — check *Domains → Advanced*. If the option is missing, keep the Wix plan running, or buy the domain outright |
| You want to move the registration to Cloudflare too | ICANN locks a domain for 60 days after registration or after a change of registrant contact | Optional and not required. After 60 days: unlock at Wix, get the auth/EPP code, and transfer to Cloudflare Registrar — it charges wholesale cost with no markup. Your DNS does not change, because it is already at Cloudflare |
| A Wix record proxied by accident | Orange-clouding a Wix site breaks its TLS and verification | Grey-cloud everything pointing at Wix |
| You genuinely cannot move nameservers | Some corporate domains are locked by IT policy | Ask for a delegated subdomain instead: have IT create `NS` records for `cms.yourfirm.com` pointing at Cloudflare. Cloudflare then answers for that subdomain only, and the rest of the domain is untouched |

### Checking it worked

```sh
dig +short NS yourfirm.com          # should be the two Cloudflare nameservers
dig +short cms.yourfirm.com         # should resolve to Cloudflare addresses
dig +short MX yourfirm.com          # should be exactly what Wix had
curl -sI https://cms.yourfirm.com | head -3
```

Check the `MX` line even if you think you have no email on the domain. It is the
one that costs you something when it is wrong, and the one nobody notices for
three days.

---

## 7. Deploying from GitHub

Two ways. Pick one.

**Cloudflare Workers Builds (simplest).** In the Cloudflare dashboard: *Workers
& Pages* → your Worker → *Settings* → *Builds* → connect the GitHub repository.
Set the deploy command to `npx wrangler deploy -c wrangler.correspondence.toml`.
Cloudflare builds and deploys on every push to `main`. The workflow in this
repository notices there are no credentials and skips its own deploy step
quietly, so you do not get a red build for a healthy setup.

**GitHub Actions (more control).** Add two repository secrets under *Settings →
Secrets and variables → Actions*:

- `CLOUDFLARE_API_TOKEN` — a token with **Workers Scripts: Edit**, **D1: Edit**
  and **Workers R2 Storage: Edit** on your account. Use a scoped token, not the
  Global API Key.
- `CLOUDFLARE_ACCOUNT_ID` — from the Cloudflare dashboard sidebar.

`.github/workflows/correspondence.yml` then runs the tests on every pull
request, and on merge to `main` applies the schema, deploys the Worker, and
prints what the database looks like afterwards.

The schema goes on **before** the code, so new code never meets an old database.

---

## 8. Locking it down

A correspondence register holds client tax affairs and audit findings. It is
worth spending twenty minutes on this.

- **Cloudflare Access (Zero Trust).** Put the whole hostname behind Access and
  require a Google or Microsoft sign-in from your firm's own domain, plus a
  second factor, *before* a request reaches the application at all. Free for up
  to 50 users. This is the single highest-value thing on the list.
- **WAF rate limiting.** One rule: more than 20 requests to `/api/auth/login`
  from one IP in a minute → block for an hour. The application also throttles
  in-process, but a Worker isolate is short-lived and Cloudflare's counter is not.
- **Restricted correspondence.** Anything genuinely sensitive should be marked
  restricted at registration. It is then absent from everybody else's register
  rather than locked — a row saying a file exists is itself the disclosure.
- **Retention.** Set the years on each category. **Practice setup → Categories**
  says what must be kept and for how long; nothing is ever deleted
  automatically, and the retention screen lists what is now past its period so a
  person can decide.
- **Audit trail.** Every letter's history is hash-chained. Use *Verify this
  record* on the letter page after any incident, or export the whole trail for
  an inspection visit from **Productivity → Audit trail**.

---

## 9. Backups

D1 keeps point-in-time recovery for the last 30 days on paid plans. That is
useful and it is not a backup, because it lives in the same account as the thing
it is backing up. Take your own copy somewhere else, monthly:

```sh
npx wrangler d1 export correspondence --remote \
  -c wrangler.correspondence.toml --output backup-$(date +%F).sql
```

R2 objects are not in that export. They are already encrypted, so copying the
bucket somewhere else is safe:

```sh
npx wrangler r2 object get practice-documents/<key> --file ./restore/<key>
```

An attachment restore needs both the bucket **and** `DOC_SECRET`. Keep them
apart, and keep both.

---

## 10. What the platform will and will not do

Worth knowing before you find out the hard way.

| Limit | The number | What it means here |
| --- | --- | --- |
| D1 database size | 10 GB | Text only. A register of a hundred thousand letters is well under a gigabyte. Attachments are in R2 precisely so this is never the constraint |
| Worker CPU per request | 10 ms free, up to 5 min paid | Everything here is a handful of indexed SQL queries. The one heavy operation is encrypting an upload, which is why files are capped at 25 MB |
| Request memory | 128 MB | The reason for the 25 MB file cap: the Worker holds the plaintext and the ciphertext at once |
| Cron granularity | 1 minute | The sweep runs hourly. Deadlines here are measured in hours, so this is not a constraint |
| No SMTP from a Worker | — | Email goes over an HTTP API (Resend). The in-app bell works without any of it, which matters because email needs an account, a verified domain and a key |
| D1 has no long transactions | — | Reference numbers come from a counter row updated with `UPDATE … RETURNING`, which is a single statement. That is what stops two letters getting the same number |
| Free plan Workers | 100k requests/day | A thirty-person practice will not reach it. The Workers Paid plan is $5/month and raises everything |
| R2 storage | $0.015/GB/month, no egress fees | 10 GB of scanned letters is about 15 cents a month |

Realistic monthly cost for a small practice: **$5 for Workers Paid**, pennies for
R2, nothing for D1 at this size, nothing for DNS, nothing for Access under 50
users. The domain stays whatever Wix charges.

---

## 11. Day one

1. **Users & data** — create an account for everybody. Roles: *Registry clerk*
   logs the post, *Professional staff* act on what is sent to them, *Manager*
   runs engagements and approves, *Partner* sees restricted files and can verify
   the audit trail.
2. **Practice setup → People** — put each person in a department, set what
   appears under their signature, and set a head for each department. The head
   is who overdue work escalates to; a department with no head escalates to
   nobody.
3. **Practice setup → Categories** — the eight supplied ones are a starting
   point. Set a retention period and a default deadline on each.
4. **Practice setup → Workflows** — edit the two examples or write your own. A
   workflow attached to a category starts on its own when a letter in that
   category is registered.
5. **Clients** — add the client list. Import is by hand; a practice of a hundred
   clients is an afternoon, once.
6. **Practice setup → Run the sweep now** — proves reminders and escalation
   work without waiting until tomorrow.

Then register the first letter. Everything else follows from there.
