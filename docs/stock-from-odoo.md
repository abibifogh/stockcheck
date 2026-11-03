# Stock from Odoo, through Insight

Insight reads every confirmed Odoo purchase order every 15 minutes and offers
each line to the breakfast app first. This app decides what the line is here,
using the same Odoo product map the **Import from Odoo** box uses. Insight
never counts or prices anything itself. This page covers the breakfast side
of that agreement.

## The endpoint

`POST /api/link/stock`, signed exactly like `/api/link/report`: headers
`X-Till-At` and `X-Till-Sig`, an HMAC-SHA256 over `till-link`, the time, the
path and the body, with the secret this Worker holds as `INSIGHT_SSO_SECRET`
(Insight calls it `SSO_SECRET_BREAKFAST`). A request more than five minutes
old, or one whose body was changed, gets a 401. Bad input gets a 400. Either
way the answer is `{ ok: false, error }`.

| `action` | What it does |
|---|---|
| `offer` | `{ mode, lines }`, at most 200 lines. `confirmed` (and `odoo`) record each line as a purchase now. `store` puts it **on its way**. |
| `status` | `{ lineIds }` → `expected`, `received` (with the qty they said, by whom, when), `recorded`, `cancelled` or `missing`. |
| `cancel` | `{ lineIds }`: the PO was cancelled. On its way → `removed`. In stock → its purchase row is deleted (`removed`), unless its day is in a closed period (`kept`, with the reason). |
| `items` | The active ingredients (not baked ones): `{ id, name, unit, group }`, where `group` is the category, plus `kind`. |
| `map` | `{ productId, uomId, itemId | newItem, factor, ignore }`. It writes `odoo_product_map`, the table the hand import reads. |

Each offered line is converted by the map exactly as the hand import does
(`classifyLine`): qty × factor, unit cost = price ÷ factor to four places.

- **recorded / expected**: the map knows the product as an active item.
- **ignored**: the map says "not breakfast".
- **unknown**: the map does not know it, or its item has been retired.
- **already**: the line is in purchases or in `odoo_expected` already; `current`
  says what it is now.
- **refused**: only in `confirmed` mode, when both the confirmation day and
  today are in a closed period. The `reason` says which.

A recorded line goes on the day Odoo confirmed it, or today if that day is
closed, into wherever `deliveries_to` says deliveries go.

`newItem { name, unit }` makes an ingredient in the category named by `group`
if one exists, otherwise in **From Odoo**. It is not an everyday item, so it
stays off the kitchen's quick sheet. `kind: "supply"` is optional. If an active
ingredient already has that name, that ingredient is used instead.

## In the app

**Purchases → On its way from Odoo** shows one block per PO. Each line is filled
in with what was ordered, in the ingredient's own unit. There is one
**Received** button per PO. Change a number if the delivery is short, or set it
to 0 if the item never came. Received records the purchase rows today, with
`po_ref` and `odoo_line_id`, and marks the lines received by that person at
that time. **Added from Odoo today** lists what came in, with any shortfall.

Anyone with the *Purchases* permission can receive. When new lines arrive,
those people get a notice on the bell and, if they turned alerts on, on their
phone.

The hand import by PO number still works. A line that is on its way shows as
"on its way" there and is not imported. `odoo_line_id` stays unique, so no
line is recorded twice, whichever way it came in.

## Database

Migration `0025_odoo_expected.sql` adds the `odoo_expected` table, keyed by
Odoo line id. To run it, go to **Actions → Breakfast database → Run workflow**,
choose `0025_odoo_expected.sql`, type `breakfast` and press Run. Until it has
run, `/api/link/stock` answers 409 and says so, and the Purchases screen
behaves as it did before.
