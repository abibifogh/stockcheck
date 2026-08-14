# Setting the system up — the plain English version

Written for somebody who is not technical. Everything here is done by
**clicking in a web browser**. You do not need to install anything, and you do
not need to type any commands.

Read a step, do it, check the "**You'll know it worked when**" line, then move
on. If a step does not do what it says, stop there and read *"When something
looks wrong"* at the bottom rather than pressing on.

Take it slowly. Nothing here is urgent, and every step is reversible except the
two marked **⚠ CAREFUL** — those two touch your firm's live website and email,
and I say exactly what to do before you start them.

---

## First, what you are actually building

Your system needs four things, and each one lives with a different company:

| The thing | Which company | What it is, in plain words |
| --- | --- | --- |
| **The code** | GitHub | The instructions that make the system work. Already written. It just sits there |
| **The running system** | Cloudflare | The computer that actually runs it and shows the screens to your staff |
| **The filing cabinet** | Cloudflare | Where letters, clients and signatures are stored |
| **The post room** | Resend | The service that sends emails to clients |

You will make an account with each, and then spend most of your time clicking
between two tabs: **GitHub** and **Cloudflare**.

### Six words that keep coming up

- **Deploy** — to publish. When you "deploy", the newest version of the system
  goes live for everyone. It takes about two minutes and happens by itself.
- **Database** — the filing cabinet. Everything the firm types in is kept there.
- **Bucket** — where uploaded files (scanned letters) are kept. A different
  cabinet, for a different kind of thing.
- **Secret** — a very long password that the system uses. You create these; you
  will never type them again after the first time.
- **Domain** — your web address, e.g. `yourfirm.com`.
- **DNS** — the phone book of the internet. It says "when somebody asks for
  yourfirm.com, send them here." Changing it is what Part 8 is about.

### How long this takes

About **four hours of your own clicking**, but spread over about two weeks,
because twice you have to press a button and then wait for the internet to catch
up. Those waits are marked.

---

# PART 1 — Make the accounts

### 1.1 Cloudflare

1. Go to **cloudflare.com** and click **Sign up**.
2. Use a firm email address that more than one person can get into. Not a
   personal one, and not one belonging to a person who might leave.
3. Confirm the email they send you.
4. Once you are in, click your account name (top right) and find **Account ID**.
   It is a long line of letters and numbers. **Copy it into a note** — you need
   it in Part 4.

**Do this too:** add a payment card. Cloudflare's free level is generous, but
the file storage in Part 2 will not switch on without a card on file. You are
looking at roughly **$5 a month**, and a few pennies for storage.

### 1.2 GitHub

You already have the code in GitHub. You just need to be able to get into it.

1. Go to **github.com** and sign in.
2. Open your repository — the page whose address ends in `/stockcheck`.
3. Check that when you look at the file list, you can see a **pencil icon** when
   you open a file. That means you can edit. If you cannot, you do not have
   permission, and whoever set the repository up needs to give it to you.

### 1.3 Resend (the post room)

1. Go to **resend.com** and click **Sign up**. Free.
2. Do not do anything else here yet. Part 9 comes back to it.

---

# PART 2 — Build the filing cabinets

Both of these are in Cloudflare. You are just creating two empty containers;
nothing goes into them yet.

### 2.1 The database

1. In Cloudflare, look down the **left-hand menu** for **D1**. It usually sits
   under a heading like *Storage & Databases*. If you cannot find it, use the
   **search box at the top** of the Cloudflare page and type `D1`.
2. Click **Create database** (or *Create*).
3. In the name box type exactly this, all lower case:

   ```
   correspondence
   ```

   The spelling matters. Not "Correspondence", not "correspondance".
4. Click **Create**.
5. On the page that appears, find **Database ID**. It is a long line of letters,
   numbers and dashes. **Copy it into your note.** You need it in Part 3.

**You'll know it worked when:** a database called `correspondence` is listed,
and it says it has no tables yet. That is correct — it is empty on purpose.

### 2.2 The bucket, for scanned letters

1. In the left-hand menu find **R2**. Same idea — search for `R2` if you cannot
   see it.
2. If it asks you to add a payment card, do it. There is a free allowance; the
   card is just so they can bill you if you exceed it, and you will not.
3. Click **Create bucket**.
4. Name it exactly:

   ```
   practice-documents
   ```
5. Leave every other setting alone and click **Create bucket**.

**You'll know it worked when:** an empty bucket called `practice-documents` is
listed.

---

# PART 3 — Tell the code where its filing cabinet is

The code does not yet know which database is yours. You are going to paste the
Database ID from step 2.1 into one file, in the browser.

1. In GitHub, open your repository.
2. In the list of files, click **`wrangler.correspondence.toml`**. (A `.toml`
   file is just a settings file. You are changing one line in it.)
3. Click the **pencil icon** (top right of the file) to edit it.
4. Find this line — it is about a third of the way down:

   ```
   database_id = "REPLACE_WITH_YOUR_DATABASE_ID"
   ```
5. Select the words `REPLACE_WITH_YOUR_DATABASE_ID` — **but not the quote marks
   around them** — and paste your Database ID over them. It should end up
   looking like:

   ```
   database_id = "8f2c1e44-91ab-4c0d-9e77-2a5b6c8d1f30"
   ```

   (That is an example. Yours will be different.)

6. **Now a second change, on the same page.** Scroll down and find these three
   lines:

   ```
   [[routes]]
   pattern = "cms.example.com"
   custom_domain = true
   ```

   Put a `#` and a space at the start of each of those three lines, so they
   become:

   ```
   # [[routes]]
   # pattern = "cms.example.com"
   # custom_domain = true
   ```

   **Why:** a `#` means "ignore this line". Those lines name your future web
   address, which does not exist yet. If you leave them switched on, publishing
   fails with a confusing error. You will switch them back on in Part 8, once
   the address is real.

7. Scroll to the bottom, and in the **Commit changes** box write something like
   `Point at our database`. Leave "Commit directly to the branch" selected.
   Click **Commit changes**.

**You'll know it worked when:** you can open `wrangler.correspondence.toml`
again and see your own long ID in it, and three lines starting with `#`.

---

# PART 4 — Give GitHub permission to publish

Right now GitHub holds the code but is not allowed to put it onto Cloudflare.
You are going to give it a key.

### 4.1 Make the key in Cloudflare

1. In Cloudflare, click your **profile icon** (top right) → **API Tokens**.
   (If you cannot find it, search the dashboard for `API Tokens`.)
2. Click **Create Token**.
3. Find the template called **Edit Cloudflare Workers** and click **Use
   template**.
4. It will ask which account and which zones. Choose **your account**, and for
   zones choose **All zones** (or your domain, if it is already listed).
5. Scroll through the permissions list. Make sure these three are there — add
   any that are missing using **Add more**:

   | Type | What | Level |
   | --- | --- | --- |
   | Account | Workers Scripts | Edit |
   | Account | D1 | Edit |
   | Account | Workers R2 Storage | Edit |

6. Click **Continue to summary**, then **Create Token**.
7. **The token is shown once and never again.** Copy it now into your note. If
   you lose it, you delete it and make another; no harm done, just annoying.

### 4.2 Give the key to GitHub

1. In GitHub, open your repository.
2. Click **Settings** (along the top of the repository, not your own profile
   settings).
3. In the left menu: **Secrets and variables** → **Actions**.
4. Click **New repository secret**.
5. Name it exactly `CLOUDFLARE_API_TOKEN` — capital letters and underscores,
   exactly like that. Paste the token as the value. Click **Add secret**.
6. Click **New repository secret** again. Name it exactly
   `CLOUDFLARE_ACCOUNT_ID`, and paste the Account ID you noted in step 1.1.
   Click **Add secret**.

**You'll know it worked when:** the page lists two secrets by name. You will not
be able to see their contents ever again, which is the point.

---

# PART 5 — Switch it on

The system publishes itself whenever the code on the **main** branch changes. A
"branch" is just a version of the code; the finished work is currently on a
different one, and needs joining to main.

1. In GitHub, open your repository. Near the top left there is a button showing
   a branch name — probably `main`. Click it and check whether you can see a
   branch whose name starts with `claude/`.
2. If you can, GitHub will usually show a yellow banner offering to **Compare &
   pull request**. Click it, then **Create pull request**, then **Merge pull
   request**, then **Confirm merge**.
3. If you cannot see that banner: click the **Pull requests** tab → **New pull
   request** → set "base: main" and "compare:" to the `claude/…` branch →
   **Create pull request** → **Merge pull request** → **Confirm merge**.

*(A "pull request" sounds technical and is not. It means: take the work from
over there and put it into the main version.)*

### Watch it publish

1. Click the **Actions** tab at the top of the repository.
2. You will see a job running with a **yellow dot** next to it. It takes three
   to five minutes.
3. Wait for the dot to turn into a **green tick**.

**You'll know it worked when:** the tick is green, and in Cloudflare under
**Workers & Pages** there is now something called **practice-correspondence**.

**If it turns into a red cross**, click into it and read the last few red lines.
Nine times out of ten it is one of: the Database ID pasted wrongly, the three
`#` lines in Part 3 not done, or a secret name in Part 4 typed slightly wrong.
All three are quick to fix — go back and check them, then click **Re-run jobs**.

### 5.1 Load the example letters and workflows

Your departments and categories arrived by themselves. The **example letter
templates, the two example workflows and two example clients did not** — they
are optional, because a firm that has written its own should not have the
examples put back on top every time the system updates.

You almost certainly want them as a starting point. To load them, once:

1. Still in the **Actions** tab, click **Correspondence · Test & Deploy** in the
   left-hand list.
2. On the right there is a **Run workflow** button. Click it.
3. A small panel opens with two tick boxes. Tick **"Also load the starter
   templates and workflows"**. Leave the other one alone.
4. Click the green **Run workflow** button in the panel.
5. Wait for the green tick again.

*(Do this once. Running it again is harmless — it skips anything already there —
but if you have since rewritten a template, it will not overwrite your version.)*

**Leave the second tick box alone**, always. It is labelled as an upgrade for
older databases and does nothing useful on a new one.

---

# PART 6 — Set the three passwords

The system needs three long passwords of its own. You will type these once and
then never again.

### 6.1 Make them up

You need two very long random ones and one short number.

For the two long ones, use a password manager's "generate password" button, set
to 40+ characters. If you have no password manager, mash the keyboard for a
while — genuinely, a long ugly string is fine. They must be **different from
each other**.

For the third, choose a **six-digit number** that is not `123456` and not
anybody's birthday.

**Write all three down somewhere safe before you continue.**

### 6.2 Put them in

1. In Cloudflare: **Workers & Pages** → click **practice-correspondence**.
2. Click **Settings**, then find **Variables and Secrets** (it may be called
   *Variables*).
3. Click **Add**, and add each of these three. For each one, set the type to
   **Secret** (sometimes shown as *Encrypt*) — **not** plain text.

   | Name — type exactly | Value |
   | --- | --- |
   | `SESSION_SECRET` | your first long random string |
   | `DOC_SECRET` | your second long random string |
   | `MANAGER_PIN` | your six-digit number |

4. Click **Deploy** or **Save** when it offers.

### ⚠ The one that cannot be replaced

**`DOC_SECRET` is not like a normal password.** It is the key to every signature
and every uploaded file. If it is lost, every signature in the system stops
being verifiable and every scanned letter becomes unreadable — permanently.
Nobody, including Cloudflare, can recover it.

So, today, before there is anything in the system to lose:

- [ ] Put it in the firm's password manager.
- [ ] **Write it on paper and put it in the safe.**
- [ ] Tell one other partner where it is.

Do not change it later. Ever.

**You'll know it worked when:** three secrets are listed by name, each showing
as hidden or encrypted.

---

# PART 7 — Get in for the first time

1. In Cloudflare: **Workers & Pages** → **practice-correspondence**. Near the
   top is a web address ending in **`.workers.dev`**. Click it.
2. You get a sign-in screen with a number keypad.
3. Type the six-digit `MANAGER_PIN` from Part 6.

You are in. The account you are using is called **Recovery access**, and it is
only meant for emergencies — so the very first thing to do is make yourself a
proper one.

### 7.1 Make yourself a real account

1. In the menu, click **Users & data**.
2. Click to add somebody. Fill in:
   - Your name
   - **Your email address**
   - Role: **Administrator**
   - A password you will remember
3. Save.
4. Sign out (top right).
5. Sign in again — but this time click the **Email & password** tab, and use the
   email and password you just set.

**You'll know it worked when:** you are signed in as yourself, and the menu
shows **My desk**, **The register**, **Clients**, **Engagements**, **Practice
setup** and so on. If you see anything about breakfast, bedrooms or a bakery,
something is wrong — stop and ask.

From now on, only use the `MANAGER_PIN` if you are locked out.

### 7.2 Have a look round

Nothing is live yet and nobody else can reach it. Click everything. Register a
pretend letter. Delete it. Get a feel for it before you set it up properly.

There is a **Help** item in the menu, written for this system. It is genuinely
worth twenty minutes.

---

# PART 8 — ⚠ CAREFUL — put it on your own web address

**Read this whole part before doing any of it.**

Right now the system is on an ugly address ending `.workers.dev`. This part
moves it to `cms.yourfirm.com`.

### What the risk actually is

To do this, control of your domain's **phone book entries** has to move to
Cloudflare. Your domain is registered at Wix, and Wix is also your website
host — so those same phone book entries are what make **your firm's website
load** and **your firm's email arrive**.

Move them carelessly and your website goes down or your email stops. Move them
carefully and nobody notices anything.

**You are not moving the domain itself.** It stays registered at Wix, you keep
paying Wix for it, and the website stays exactly where it is. Only the phone
book moves.

### ⚠ Before you touch anything — write the list

This is the single most important step in this document.

1. In Wix: **Domains** → your domain → **DNS Records**.
2. **Screenshot every single record. All of them. Every tab, every section.**
3. Also copy them into a document, by hand, in a table: Type, Name, Value,
   Priority.
4. Pay special attention to anything of type **MX**. Those are your email. If
   an MX record does not come across, your firm's email stops arriving, and
   that is the thing that ruins someone's week.

Do not continue until you have that list saved somewhere that is not the
computer you are working on.

### The steps

1. **Turn DNSSEC off at Wix**, if it is on. It is in the same domain settings
   area. *(DNSSEC is a security feature that makes the phone book tamper-proof.
   If it is on while you move, the domain stops working completely — not
   slowly, completely.)* **Then wait one hour.** Have lunch.

2. **In Cloudflare**, click **Add a site**, type your domain (just
   `yourfirm.com`, no `www`, no `https`), and choose the **Free** plan.

3. Cloudflare will scan and show you the records it found. **Compare that list
   against your screenshots, line by line.** The scan misses things regularly.
   Add anything missing by hand with **Add record**. Get the MX records right.

4. Cloudflare then shows you **two nameservers** — they look like
   `ana.ns.cloudflare.com` and `bob.ns.cloudflare.com`. Copy them.

5. **In Wix:** Domains → your domain → **Advanced** → **Name Servers**. Choose
   the option for using another provider's / external nameservers. Delete what
   is there, enter Cloudflare's two, and save.

6. **Wait.** Usually minutes, sometimes up to two days. Cloudflare emails you
   when it is done. Do nothing else until that email arrives.

### While you wait, check nothing broke

Every couple of hours:

- Open your firm's website. It should load exactly as before.
- Send an email to a firm address from your phone. It should arrive.

If either breaks, go to *"When something looks wrong"* at the bottom. Your
screenshots are how you fix it.

### Once Cloudflare says the domain is active

1. Go back to GitHub → `wrangler.correspondence.toml` → pencil icon.
2. Find the three lines you put `#` in front of in Part 3, and **remove the
   `#` and the space** from each.
3. On the middle line, replace `cms.example.com` with your real address:

   ```
   [[routes]]
   pattern = "cms.yourfirm.com"
   custom_domain = true
   ```
4. Commit the change. Go to the **Actions** tab and wait for the green tick.

**You'll know it worked when:** you can type `cms.yourfirm.com` into a browser
and get the sign-in screen, with a padlock showing in the address bar. Your
firm's website still loads. Your firm's email still arrives.

---

# PART 9 — Let it send emails

Without this, the system works but stays silent — you would have to send every
signing link by hand. With it, clients are invited, chased and thanked
automatically.

### 9.1 Prove the domain is yours

1. Sign in to **resend.com**.
2. Go to **Domains** → **Add Domain**. Type `yourfirm.com`.
3. Resend shows you a handful of records to add. Keep that page open.
4. In **another tab**, go to Cloudflare → your domain → **DNS** → **Records**.
5. For each record Resend shows you, click **Add record** in Cloudflare and copy
   it across — type, name and value, exactly. There is usually one `TXT`, a
   couple of `DKIM` ones, and sometimes an `MX`.

   *If a value is long, copy and paste it. Do not retype it.*

6. Back in Resend, click **Verify**. It may take a few minutes. Refresh until it
   goes green.

**Do not skip this.** An unverified domain means every email you send lands in
spam. A client who never sees your engagement letter looks exactly like a client
who is ignoring you, and you will not be able to tell which.

### 9.2 Get the key

1. In Resend: **API Keys** → **Create API Key**. Name it `correspondence`.
2. Copy the key it shows you. **Shown once only.**
3. In Cloudflare: **Workers & Pages** → **practice-correspondence** →
   **Settings** → **Variables and Secrets** → **Add**.
4. Name it exactly `RESEND_API_KEY`, paste the key, set the type to **Secret**,
   and save.
5. **Now publish again**, or it will not take effect: in GitHub, click
   **Actions** → the most recent run → **Re-run all jobs**. Wait for green.

### 9.3 Fill in the details

Sign in to your system → **Practice setup** → the **Email** card.

| Box | What to put |
| --- | --- |
| From address | `practice@yourfirm.com` — must be your verified domain |
| Sender name | Your firm's name, as a client should see it in their inbox |
| Reply-to | The office address a real person reads |
| Site address | `https://cms.yourfirm.com` — **every link is built from this** |
| Email clients and signers | **On** |
| Email staff | **On** |

Save.

### 9.4 Prove it properly

First, click **Send a test to myself**. It goes only to you. If something is
missing it tells you which thing.

Then — and this matters more — **do the real thing**:

1. Register a letter. Any letter, marked outgoing.
2. Send it for signature to your own **personal** email address (a Gmail or
   similar, not a firm one).
3. Check it arrives. Check it does not land in spam.
4. **Open it on your phone.** Read it. Sign it.
5. Check the receipt arrives.

A signature request that works at your desk and not on a client's phone is the
most expensive thing to find out about late. Fifteen minutes here saves an
embarrassing week later.

---

# PART 10 — Lock the door

### 10.1 Put a lock in front of the staff screens

1. In Cloudflare, find **Zero Trust** in the left menu.
2. Go to **Access** → **Applications** → **Add an application** →
   **Self-hosted**.
3. Give it a name, and for the address put `cms.yourfirm.com`.
4. Add a policy that allows **emails ending in `@yourfirm.com`** and nobody
   else.

This means someone has to prove who they are before they even reach your
sign-in screen. It is free up to 50 people and it is the single most valuable
twenty minutes on this list.

### 10.2 ⚠ Then let clients back in

Clients have no account with you, so the lock above would shut them out of their
own signing links.

In the same Access application, add a **Bypass** policy covering these two
addresses:

```
cms.yourfirm.com/sign
cms.yourfirm.com/api/co/sign/*
```

**Test it:** open a signing link in a **private/incognito window**, or on your
phone with wifi off. If you are asked to sign in with a firm email, the bypass
is not right and every client will hit the same wall.

### 10.3 Take a backup, monthly

1. Cloudflare → **D1** → `correspondence`.
2. Look for an **Export** option and download the file.
3. Put it somewhere that is **not** Cloudflare — a firm drive, an encrypted
   disk.

**Keep the backup and the `DOC_SECRET` paper in different places.** Together
they are everything. Apart, neither is enough on its own.

---

# PART 11 — Set the practice up

All under **Practice setup**. Do them in this order, because each one depends on
the one above.

1. **Departments.** Tax, Audit, Payroll, whatever you have. **Give every one a
   head.** That is the person who gets told when something goes overdue. A
   department with no head tells nobody, silently.

2. **Categories.** Eight are supplied. For each, set:
   - a short prefix — it becomes the reference number, e.g. `TAX` gives you
     `TAX-2026-0007`
   - a default deadline in hours
   - how many years it must be kept

3. **Working days and timings.** Which days count as working days, and how late
   something has to be before it escalates. This is why "48 hours" from Friday
   afternoon means Tuesday, not Sunday.

4. **Workflows.** A workflow is a list of steps a letter goes through. Two
   examples arrived if you did step 5.1 — edit them into how your firm actually
   works, then attach one to a category so it starts by itself.

5. **Templates.** The letters you write over and over: engagement letters, fee
   notes, filing reminders. Seven examples arrived if you did step 5.1; if the
   list is empty, that is the step you skipped.

   > **Have whoever signs your engagement letters read these before anybody uses
   > them.** They are examples, not your firm's terms of business. Rewrite them
   > in your own words, on your own terms of business, before a single one goes
   > to a client.

6. **People.** For each person: their department, their job title, and what
   appears under their signature.

**You'll know it worked when:** you can register a test letter, pick a category,
and watch it get a proper reference number and a deadline by itself.

---

# PART 12 — Put your people and clients in

### 12.1 People

**Users & data**, one row per person. Name, **email address**, role, and a PIN
they will use to sign in.

| Role | Give it to |
| --- | --- |
| Registry clerk | Whoever opens the post. They log letters and send them on, and see no client files and no reports |
| Professional staff | Everybody else. They act on what is sent to them |
| Manager | Runs jobs: approvals, the client file, the numbers |
| Partner | All of that, plus confidential files and the settings |
| Administrator | You, and one other person. Can manage everybody |

**The email address is not optional.** It is where the system sends people their
work. Somebody without one still sees everything on their screen — they just
get no email.

**Be sparing with Partner.** It is the role that can see restricted files.

### 12.2 Everybody sets their signature

Each person, once: **My desk** → **My signature** → draw it with a finger or
upload a photo of their real one. After that, signing anything is one tap.

Do this in the same session where you show people the system, or it will never
happen.

### 12.3 Clients

**Clients** → add each one. Name, type, contact, email, address, tax reference.
An afternoon for a hundred clients, once.

Do it carefully. A list with three spellings of the same company is a register
nobody can search.

### 12.4 Live jobs

**Engagements** → for each job currently running: client, type, period, partner,
manager, budget, fee, and **both deadlines** — the official one and your own
internal target. They are separate boxes on purpose. Missing your own costs a
conversation; missing the official one costs a penalty.

### 12.5 Do not type in last year's post

It is tempting. Don't. Old letters loaded in have no routing, no deadlines and
no history, which makes every report wrong from day one.

Pick a start date. Everything before it stays in the paper files where it is.

---

# PART 13 — Try it for real, with one small group

**One week. One department. Three people who agreed to it. Real work, not
pretend work.**

Get all four of these to happen during that week:

- [ ] A letter that arrives, gets sent to someone, gets dealt with, gets closed.
- [ ] A letter going out that needs approval before it is sent.
- [ ] **A real signature request, to a real client** — chased at least once by
      the system, signed, and the certificate printed.
- [ ] Something deliberately left to go overdue, so you can watch the right
      person get told.

Then ask those three people one question:

> **What did you have to do twice?**

That answer is worth more than any amount of planning, and it is cheap to fix
now. Fix it before Part 14. A system that annoys people on day one gets a
reputation it keeps for a year.

---

# PART 14 — Go live

### The morning

- [ ] Everybody signs in once and changes their PIN.
- [ ] Everybody saves their signature.
- [ ] The post is logged in the system, and only in the system.
- [ ] **Announce a date the paper register stops.** Not "we're moving to the new
      system" — a date, and one person whose job it is.

### Half an hour of training, split three ways

Nobody needs to know all of it:

| Who | Show them only |
| --- | --- |
| Whoever opens the post | Registering a letter, and sending it on |
| Everybody else | My desk, taking a job, finishing it, action points |
| Managers and partners | Approving, signing, sending for signature, the Overview |

Then point everybody at **Help** in the menu. It is written for this system and
it knows who is reading it.

### The first week

Look at **Overview** every morning:

- Anything sitting unclaimed for more than a day means everybody thinks somebody
  else has it.
- Anything overdue in week one is usually a deadline set too tight in Part 11,
  not a person being slow. Fix the category, not the person.
- A signature request emailed but never opened after three days: **ring the
  client**. The link is fine — it is in their spam, and you want to know that
  about your email in week one, not in month six.

On day two, look at the email log under **Users & data**. Every email problem
that is going to happen has happened by then.

---

# When something looks wrong

| What you see | What it almost always is |
| --- | --- |
| The publishing job shows a red cross | Database ID pasted wrong, or the three `#` lines not done, or a secret name typed slightly wrong. Click into the job and read the last red lines |
| `cms.yourfirm.com` does not load | Either DNSSEC is still on at Wix, or the nameservers have not caught up yet. Wait longer before assuming it is broken |
| Publishing fails saying it does not know a route | The zone is not active on Cloudflare yet. Put the `#` back in front of those three lines, publish, and take them out once Cloudflare emails you |
| **The firm's email has stopped** | An MX record did not come across. Open your screenshots, go to Cloudflare → DNS → Records, and put it back exactly. This is why you took the screenshots |
| **The firm's website has stopped** | Same cause, different record. Compare Cloudflare's DNS list against your screenshots and add back whatever is missing |
| No emails at all | `RESEND_API_KEY` missing, or added without publishing afterwards. The banner on the Email card tells you which |
| Emails arrive in spam | The Resend domain is not verified, or a record was mistyped when you copied it across |
| Signing links go nowhere | **Site address** on the Email card is empty or wrong |
| A client cannot open their link | The Access bypass in step 10.2 is missing or wrong |
| Cannot upload a scanned letter | The bucket in step 2.2 was not created, or was named differently |
| Templates or workflows list is empty | Step 5.1 was skipped. Go to Actions → Run workflow → tick the starter box |
| Nothing is being chased | The sweep is switched off in Practice setup, or the letters have no deadlines |
| "This cannot be marked as sent" | Somebody still has to approve or sign it. That refusal is deliberate — it is the whole reason those steps exist |

### When to stop and ask for help

Stop and get someone technical if:

- The firm's website or email breaks and putting the record back does not fix it
  within an hour.
- The publishing job fails three times and you cannot see why.
- Anything asks you to change `DOC_SECRET`.

None of these are disasters. All of them are much cheaper to fix in the first
hour than in the first week.

---

# The list to print and tick

**Set up**
- [ ] Cloudflare account, card added, Account ID noted
- [ ] Database `correspondence` created, ID noted
- [ ] Bucket `practice-documents` created
- [ ] Database ID pasted into the settings file
- [ ] The three route lines commented out with `#`
- [ ] API token made, both GitHub secrets added
- [ ] Branch merged into main, green tick in Actions
- [ ] Example templates and workflows loaded (the **Run workflow** tick box)
- [ ] Three secrets added in Cloudflare
- [ ] **`DOC_SECRET` in the password manager AND on paper in the safe**
- [ ] Signed in, real administrator account made, recovery PIN put away

**Connected**
- [ ] **Every old DNS record screenshotted before anything changed**
- [ ] DNSSEC off, nameservers changed, Cloudflare says active
- [ ] `cms.yourfirm.com` loads with a padlock
- [ ] **Firm's website still loads. Firm's email still arrives.**
- [ ] Route lines switched back on with the real address

**Sending**
- [ ] Resend domain verified and green
- [ ] `RESEND_API_KEY` added, and published again afterwards
- [ ] Email card filled in, including the site address
- [ ] Test to self arrives
- [ ] **A real signature request opened and signed on a phone, outside the firm**

**Locked**
- [ ] Access in front of the staff screens
- [ ] Bypass for `/sign` — tested in a private window
- [ ] First backup downloaded and stored away from Cloudflare

**Set up for the firm**
- [ ] Departments, each with a head
- [ ] Categories with prefixes, deadlines and retention
- [ ] Working days and timings
- [ ] Workflows written
- [ ] **Templates read and approved by whoever signs them**
- [ ] Everybody added, with email addresses
- [ ] Everybody's signature saved
- [ ] Clients in
- [ ] Live engagements in, with both deadlines
- [ ] A start date agreed, and no old post typed in

**Proved**
- [ ] One week, one department, real work
- [ ] All four things tried
- [ ] What they found is fixed

**Live**
- [ ] Everybody signed in and changed their PIN
- [ ] Half an hour of training, by group
- [ ] A date the paper register stops, and a person answerable for it
