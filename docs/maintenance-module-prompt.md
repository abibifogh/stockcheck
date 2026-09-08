# Prompt: build a hotel maintenance store

Paste everything below the line into Claude Code, in the repository you want
this built in.

---

Build a **maintenance parts store, tool store and reporting module** into this
existing system. Everything below is a specification, not a diff to copy —
match this repository's own stack, conventions, file layout, naming, auth and
test framework. Where my description conflicts with how this codebase already
does something, follow the codebase and tell me where you diverged and why.

Before writing anything, read enough of this repo to answer: how are routes
declared, how are permissions checked, how are database migrations applied,
how are tables/forms/modals built, and how are tests written. Then propose a
short plan and wait for me to approve it.

## What it is for

A hotel's technicians take parts from a store and fit them in rooms. The
questions the system exists to answer are:

1. What did each room or area cost, so a room eating four times its share of
   bulbs can be found and looked at.
2. What is on the shelf, what needs ordering, what has not moved in months.
3. Where each tool is, who has it, and what has not come back.

It is used **mostly on a phone**, by somebody holding a screwdriver in the
other hand. Anything that needs typing will be done "later", which means
never, and the store drifts out of truth within a fortnight. Design for three
taps, not for completeness.

## Domain model

Use whatever types and naming this repo uses. The shape is what matters. I
have written the columns in SQL because that is unambiguous; translate as
needed.

### Places, parts, and what happened

```
categories      id, name (unique), sort_order

areas           id, name (unique), kind ('room' | 'area'), block, sort_order, active
                -- "block" is a floor, wing or building. Rooms and areas are the
                -- same table because a corridor and a room both consume parts.

items           id, category_id, name (unique), unit, par_level, opening_stock,
                default_unit_cost, is_common, active, note, attributes,
                product_id, variant
                -- par_level: what you want on the shelf; below it raises a
                --   restock alert.
                -- is_common: shown on the issue screen without searching. The
                --   handful of things that go out weekly; the rest hide behind
                --   "All items".
                -- attributes: free-form key/value detail (wattage, size,
                --   colour) as JSON. Searchable, and shown on the tile — it is
                --   what tells two similar parts apart on a shelf.

issues          id, day, at, item_id, area_id, qty, job_ref, note, issued_by
                -- area_id is nullable: "it went to the workshop" is a real
                -- answer, and refusing it would mean not recording the issue.

purchases       id, day, item_id, qty, unit_cost, supplier, note, created_at

counts          id, day, item_id, counted_qty, note,
                status ('pending' | 'approved' | 'rejected'),
                counted_by, reviewed_by, reviewed_at, review_note
                UNIQUE (day, item_id)
```

**Stock on hand is derived, never stored**: `opening_stock + purchases -
issues`, with an approved count resetting the baseline from its date. Do not
add a `quantity` column that writes keep in step — it will drift, and the
drift is invisible.

### Products and variants

A bulb kept in 40W warm, 40W white and 60W is **three parts, not one**. They
sit in different boxes and run out on different days, so a single figure for
all three tells nobody when to order any of them.

```
products        id, name (unique), category_id, note, active, created_at
```

`items.product_id` and `items.variant` hang the parts off the heading.

The decision that makes this cheap: **a variant IS a part**. Every ledger keys
on `items.id`, so a variant already has its own balance, its own count line
and its own restock alert — no query has to learn what a product is. This is
why it is a grouping table and not a `parent_id` on `items`: a row that was
both a heading and a stockable part would raise a question nothing can answer
(what is the heading's own balance?), and attaching an existing part to a
product would mean moving its history to a new row. Here it keeps its id.

- The part's own name is composed: `"{product} — {variant}"`.
- Renaming a product must **re-derive the names of its variants**, or every
  screen keeps printing the old one. Carry only the ones still holding a
  composed name — a part that was attached later, or renamed by hand since,
  is somebody's decision and must be left alone. Report how many you carried.
- Same rule for category: variants filed where the product is move with it;
  one filed elsewhere deliberately stays.
- Creating a product and its variants is all-or-nothing.

### Tools, and their accessories

A part is used up; a tool is borrowed. Tools are **not** on the parts list and
have no quantity — one drill is one drill, and the question is never how many
are left but where this one is.

```
tools           id, name, tag (unique), category_id, note, active, created_at,
                parent_tool_id -> tools(id)
                -- tag is what is stencilled on it. Two identical drills are
                -- two rows; the tag is what tells them apart.

tool_movements  id, tool_id, area_id, issued_to, issued_by, issued_at,
                due_back_at, returned_at, received_by, note, return_note,
                overdue_notified_at,
                with_movement_id -> tool_movements(id)
```

**Each trip is its own row: out on the left, back on the right.** Not a status
column on the tool — a status says where something is *now* and forgets
everything before it. Where a tool is now is simply the journey that has not
come back yet; the history is the rest of them.

**Enforce "a tool cannot be in two places" in the schema, not in a handler:**

```sql
CREATE UNIQUE INDEX idx_tool_out
  ON tool_movements (tool_id) WHERE returned_at IS NULL;
```

(If your database has no partial indexes, use whatever gives the same
guarantee at the storage layer. Do not settle for a check-then-write in the
handler — two people at one counter is an ordinary collision.) The handler's
only job is turning the constraint violation into a sentence naming who has
it.

`due_back_at` is **stored, not computed on read**, so changing the grace
period later cannot retroactively make last month's trips look late.

**An accessory is a tool** — a charger, a case, a set of bits — with
`parent_tool_id` set. Same move as variants, and it buys the same things: its
own journeys, its own history, the same double-issue guard. The point is that
a charger which does not come back with the drill can still be found.

- Issuing a tool offers its accessories as tick boxes, ticked by default.
  Each goes out as its own movement with `with_movement_id` pointing at the
  parent's.
- Insert them **one at a time, not as one transaction**. A transaction is
  all-or-nothing, so a case somebody else already has would refuse the drill
  too. The storeman at the counter would rather hand over three and be told
  about the fourth — so do that, and name the fourth.
- Returning offers to take back what went out on the same trip, ticked by
  default and refusable. Name whatever is deliberately left out.
- **One level deep**, enforced: a tool with accessories cannot become one, an
  accessory cannot take accessories, nothing belongs to itself. That is what
  makes a cycle impossible rather than merely unlikely.
- Retiring a tool **detaches its accessories** rather than leaving them
  pointing at a retired parent — otherwise they are in the database and on no
  screen, which is the one outcome a register must not have.

### Approvals

Two things need a second signature, and the rule behind both is: *whoever does
it is never whoever confirms it.*

**Physical counts.** A count is a claim about the shelf; accepting it is what
corrects the book. Recounting is exactly the moment a shortfall could be
quietly written off.

**Changes to what was already recorded.** Deleting an issue puts parts back on
the shelf; deleting a delivery takes them off. Either could be done the day
after a count was agreed, leaving the agreed figure looking like the mistake.

```
adjustments     id, kind, action ('edit' | 'delete'), target_id,
                payload, previous, reason, status, requested_by, requested_at,
                reviewed_by, reviewed_at, review_note
                -- partial unique index: one open request per (kind, target_id)
```

- Recording a **new** issue or delivery stays immediate. A technician handing
  out parts in a corridor is not asking anybody's permission.
- Store a snapshot of the row as it stood (`previous`), so what would change
  is legible even if something else lands in between.
- **Re-read the target at approval time** rather than trusting the snapshot.
  Another accepted request may have removed the very row this one is about;
  report that as missing rather than counting it as applied.
- The part/item itself is not editable on an entry. An entry against the
  wrong part is a different entry, not a correction — allowing it would move
  stock on two items from one signature.
- A **rejection is reversible**. It usually means "not yet", not "never": the
  technician explains the next morning. A rejected request stays on the same
  screen and can be accepted later, keeping who asked, when and why. Block it
  only where a newer request is open on the same entry — that one is the live
  question.

### Scheduled counts

```
stocktake_schedules  id, name, every_days, next_due, last_done, note, active,
                     created_by, created_at
stocktake_assignees  schedule_id, user_id
stocktake_tasks      id, schedule_id, name, due_day, status ('open'|'done'|
                     'cancelled'), opened_at, completed_at, completed_by,
                     items_counted   UNIQUE (schedule_id, due_day)
```

Interval in **days** (7 / 30 / 90) rather than a calendar rule — no date
library, and no arguing about what "monthly" means in February. A count that
satisfies an open task closes it, rather than making somebody tick it off.

## Permissions

Five keys, so a technician can be given the issue screen and nothing else:

| key | covers |
|---|---|
| `mx_issue` | record parts released to a room or area; issue and return tools |
| `mx_reports` | what each room and area is costing |
| `mx_stock` | parts on hand, restock list, physical counts |
| `mx_purchases` | record parts bought, with cost |
| `mx_setup` | the parts list, the rooms and areas, the tool register |

Two traps, both of which bit this system:

1. **Reading a queue and acting on it are different permissions.** Approving
   needs the general "manage users/approvals" permission; if the *list* is
   gated on `mx_stock` alone, somebody who can accept a request cannot open
   the screen that shows it. Gate the read on either.
2. **Check what an unknown role falls back to.** If your permission resolver
   returns a default for a role it does not recognise, deleting or renaming a
   role silently grants that default. Move affected people to no access and
   let an administrator set it deliberately.

## Screens

Build these; adapt names to this repo's conventions.

**Issue parts** — the screen that decides whether the system gets used.
Tap where, tap what, save. Quantities default to 1 and are adjusted only when
they are not 1. Nothing required but the parts themselves — room, job number
and note are all optional, because a half-recorded issue still tells you the
stock left the shelf. A sticky basket at the bottom holds the lines.

*Phone layout matters here more than anywhere.* Do not stack a full room list
above a full parts list — cap the room chips (about a dozen) behind a "show N
more" and a search, and let each answered step **fold to a one-line summary**
naming what it was answered with. Use the platform's native disclosure control
so keyboards and screen readers get it for free.

**Store** — one screen, not two. What is true *right now* (shelf value, what
needs restocking, what has not moved in 90 days) sits **above** a period
picker; everything below it moves with the dates: totals against the previous
period, a day-by-day chart, the full room-by-room and part-by-part tables,
category split, bought-vs-issued, and what rose and fell.

Resist splitting this into an "overview" and a "full report". They converge on
the same findings in two shapes, and people then read everything twice.

Put anything **waiting on the reader personally** at the top, above the
findings — an analysis can be read tomorrow; an unanswered request is
somebody blocked.

**Parts** — stock on hand with a restock list, and the form for entering a
physical count. Keep typed figures outside any repaint, so sorting or
filtering the list cannot wipe a half-finished count.

**Tools** — what is out, with whom, and where; issue and return; per-tool
history. Order it by that question rather than alphabetically: late first,
then what else is out, then the shelf.

**Bought** — deliveries with cost, so stock value and part cost are real.

**Setup** — rooms and areas, parts (with spreadsheet import), products and
variants, the tool register, scheduled counts. **Put these behind tabs.** Six
full-width cards down one page means scrolling past the parts list to reach
the rooms, every time, and back again after every save. Keep the open tab in
module state so the rebuild after a save returns you where you were.

**Area detail** — everything ever issued to one room, reachable by clicking a
row in the room table.

### Tables

Every column sorts. Put sorting **inside the table component** rather than
wiring it per screen — that is how half of them end up sortable and half do
not, and a column that sorts in one list and not the next reads as a bug.

Long lists also need a **group-by chooser**: rooms by kind, by block, or by
whether they are still in use; products by category or by variant count.
Remember the choice across the rebuild after a save.

**A warning I hit:** if any table wires row clicks by walking the DOM
afterwards and matching rows to data *by position*, sorting silently breaks
it — clicking "Room 214" opens whichever room now sits in that position. Wire
the handler as the row is built.

Likewise, anything whose meaning depends on its position in the list (an
accessory shown indented under its parent, say) becomes a lie once the list
can be reordered. Name the relationship on the row instead.

## Notifications

A tool not back within the grace period (default 24h, a setting, clamped to a
sane range) raises a notice to whoever runs the store.

- **Sweep hourly, not daily.** Checked once a day, a tool issued at 07:00 is
  chased at 18:00 the *following* day — a day and a half.
- **Tell somebody once.** Mark the row as told in the same sweep that reads
  it, and mark it *before* the telling, not after — a notification that throws
  must not leave the row unmarked. Being chased twelve times about one drill
  is how people learn to ignore the bell.
- Requests waiting for approval also raise a notice, addressed to whoever can
  approve.

**If notices are addressed to an audience and filtered per reader, filter
before applying the limit.** Taking the newest twenty rows and *then* filtering
by audience means twenty notices addressed to other people push yours off the
end — and the one that goes quiet that way is the approval nobody knew was
waiting. Count the unread badge over everything addressed to the reader, not
over the page, or the badge disagrees with the list it opens.

## Testing

Match this repo's framework. Weight the tests toward the things that fail
*silently*, because those are the ones nobody reports:

- stock arithmetic across an approved count boundary
- the double-issue guard, and that a partial accessory issue hands over the
  rest and names what it could not
- what a product rename carries and what it deliberately leaves alone
- the overdue sweep: that it marks before telling, and tells once
- approval re-reading its target rather than trusting the snapshot
- notice audience filtering, including that an addressed notice survives a
  flood of unaddressed ones

For anything you are told is a bug, write the test first and **run it against
the unfixed code** to prove it fails. A test that passes both ways is worse
than no test.

## Things to get right that are easy to get wrong

- Stock is derived. Never cache it in a column.
- Retire, never delete, anything with history — deleting takes the history
  with it and quietly rewrites what past months cost. Delete only what has
  never been used, and say which happened.
- An entry against the wrong part is a different entry, not a correction.
- Nullable `area_id` throughout: unrecorded is better than unrecorded *and*
  unissued.
- Cost per issue uses the cost at the time, not today's.

## How to work

Small commits, each one a complete change with a message explaining *why*, not
what. Do not open a pull request unless I ask. Tell me plainly if part of this
does not fit the system — I would rather hear that than have it forced in.
