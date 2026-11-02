/**
 * The storeroom.
 *
 * Deliveries land here; departments ask for things; the storekeeper issues
 * them. Its stock is simple arithmetic rather than a ledger: what was on the
 * shelf when tracking began, plus what was delivered into it, less what was
 * issued. The cost of each issue is fixed when it is issued, so the
 * storeroom's own figure is a quantity and the money lives on the issue.
 */

/** Statuses in which an issue has left the shelf. */
export const ISSUED_STATUSES = ['issued', 'received'];

/** After this long an issue nobody confirmed is taken as received. */
export const AUTO_RECEIVE_HOURS = 24;

/** When something is needed, in the words the screens use. */
export const NEEDED = {
  now: 'Now',
  today: 'Today',
  tomorrow: 'Tomorrow morning',
};

/**
 * The departments that may ask, in the order an administrator gave them.
 *
 * One per line or comma separated. Never empty: a storeroom with nobody to
 * issue to is a configuration mistake, and "Kitchen" is what it was before.
 */
export function departmentsOf(settings) {
  const list = String(settings?.store_departments ?? '')
    .split(/[\n,]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  const unique = [...new Set(list)];
  return unique.length ? unique : ['Kitchen'];
}

/**
 * The breakfast kitchen: the first department.
 *
 * What it receives is breakfast stock and appears in the cost per guest. What
 * the others receive left the storeroom and is theirs.
 */
export function kitchenDepartment(settings) {
  return departmentsOf(settings)[0];
}

/** Where a new delivery lands. 'kitchen' until the storeroom migration has run. */
export function deliveriesTo(settings) {
  return settings?.deliveries_to === 'store' ? 'store' : 'kitchen';
}

const round = (n, places = 4) => {
  const f = 10 ** places;
  return Math.round(Number(n) * f) / f;
};

/**
 * Every item's storeroom stock, as of now.
 *
 * Items are the catalogue's, food and supplies both. `lastCost` is what was
 * last paid for the item anywhere — the same figure an issue is valued at.
 */
export async function storeStock(db) {
  const [items, delivered, issued, lastPaid] = await Promise.all([
    db.prepare(
      `SELECT i.id, i.name, i.unit, i.kind, i.active, i.requestable, i.store_opening, i.store_par,
              i.default_unit_cost, c.name AS category_name
         FROM ingredients i JOIN categories c ON c.id = i.category_id
        ORDER BY c.sort_order, c.name, i.sort_order, i.name`,
    ).all(),
    db.prepare(
      `SELECT ingredient_id, SUM(qty) AS qty FROM purchases
        WHERE location = 'store' GROUP BY ingredient_id`,
    ).all(),
    db.prepare(
      `SELECT l.ingredient_id, SUM(l.issued) AS qty
         FROM store_request_lines l JOIN store_requests r ON r.id = l.request_id
        WHERE r.status IN ('issued', 'received') AND l.issued > 0
        GROUP BY l.ingredient_id`,
    ).all(),
    lastCosts(db),
  ]);

  const inById = new Map((delivered.results ?? []).map((r) => [r.ingredient_id, Number(r.qty) || 0]));
  const outById = new Map((issued.results ?? []).map((r) => [r.ingredient_id, Number(r.qty) || 0]));

  return (items.results ?? []).map((i) => {
    const opening = Number(i.store_opening) || 0;
    const inQty = inById.get(i.id) ?? 0;
    const outQty = outById.get(i.id) ?? 0;
    const stock = round(opening + inQty - outQty);
    const par = Number(i.store_par) || 0;
    const unitCost = lastPaid.get(i.id) ?? (Number(i.default_unit_cost) || 0);
    return {
      id: i.id,
      name: i.name,
      unit: i.unit,
      kind: i.kind ?? 'food',
      category: i.category_name,
      active: Boolean(i.active),
      requestable: Boolean(i.requestable),
      opening,
      delivered: round(inQty),
      issued: round(outQty),
      stock,
      par,
      low: par > 0 ? stock < par : stock <= 0,
      unitCost,
      value: Math.round(Math.max(stock, 0) * unitCost * 100) / 100,
    };
  });
}

/**
 * What was last paid for each item, wherever it was delivered.
 *
 * The figure an issue is valued at. The last price rather than an average:
 * it is the number the storekeeper and the kitchen would both quote, and
 * the one the delivery form already pre-fills.
 */
export async function lastCosts(db) {
  const rows = await db.prepare(
    `SELECT p.ingredient_id, p.unit_cost
       FROM purchases p
       JOIN (
         SELECT ingredient_id, MAX(day || '-' || printf('%08d', id)) AS newest
           FROM purchases GROUP BY ingredient_id
       ) latest
         ON latest.ingredient_id = p.ingredient_id
        AND latest.newest = p.day || '-' || printf('%08d', p.id)`,
  ).all();
  return new Map((rows.results ?? []).map((r) => [r.ingredient_id, Number(r.unit_cost) || 0]));
}

/**
 * Take as received whatever was issued long enough ago and never confirmed.
 *
 * Run whenever the requests are read, rather than on a timer: this Worker has
 * no schedule, and nothing depends on the exact minute. Marked as automatic,
 * so the manager can see which ones nobody actually checked.
 */
export async function autoReceive(db) {
  return db.prepare(
    `UPDATE store_requests
        SET status = 'received', received_auto = 1, received_at = datetime('now'),
            received_by = 'Nobody — taken as received after ${AUTO_RECEIVE_HOURS} hours'
      WHERE status = 'issued' AND issued_at <= datetime('now', '-${AUTO_RECEIVE_HOURS} hours')`,
  ).run();
}

/**
 * Where a delivery being recorded lands.
 *
 * What the person chose, if they chose; otherwise the setting. `null` before
 * the storeroom migration has run, which tells the caller to write the row as
 * it always did — with no location column to write to.
 */
export async function deliveryLocation(db, requested) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'deliveries_to'").first().catch(() => null);
  if (!row) return null;
  if (requested === 'store' || requested === 'kitchen') return requested;
  return row.value === 'kitchen' ? 'kitchen' : 'store';
}
