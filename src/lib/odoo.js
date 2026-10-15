/**
 * Purchase orders, read from Odoo.
 *
 * Ported from the insight application's Odoo connector (attendance/bi/src/
 * connectors/odoo.js), so the two systems talk to the same Odoo the same way:
 * the JSON-2 API, a bearer API key, and nothing but `search_read`.
 *
 *   POST https://<host>/json/2/<model>/<method>
 *   Authorization: bearer <api key>
 *   X-Odoo-Database: <db>        (only where one domain serves several)
 *
 * Read-only by construction. `search_read` is the only method called anywhere
 * in this file and there is no code path that writes to Odoo — importing a PO
 * here can never change it there.
 *
 * JSON-2 is Odoo 19's API and replaces /jsonrpc and /xmlrpc/2, which Odoo has
 * scheduled for removal. Written against the endpoint that will still exist.
 */

/** Large enough to be few round trips, small enough for a Worker's memory. */
const PAGE = 500;
const MAX_PAGES = 20;

/** How many PO numbers one request may ask for. Enough for a week of orders. */
export const MAX_ORDERS = 50;

/**
 * Only these can be imported. An RFQ in 'draft' or 'sent' has not been agreed
 * with anybody, and importing one would put stock on the shelf that may never
 * arrive; a cancelled order never will.
 */
export const IMPORTABLE_STATES = new Set(['purchase', 'done']);

const STATE_WORDS = {
  draft: 'still a request for quotation',
  sent: 'a quotation sent to the supplier, not yet confirmed',
  'to approve': 'waiting for approval in Odoo',
  purchase: 'confirmed',
  done: 'locked',
  cancel: 'cancelled',
};

export function describeState(state) {
  return STATE_WORDS[state] ?? state ?? 'unknown';
}

/**
 * A PO number as Odoo names it: `2433` and `p2433` are both `P02433`.
 *
 * The same rule the insight application uses, so a number typed into either
 * system means the same order. People type the digits off a printout; Odoo
 * stores the padded name.
 */
export function poName(raw) {
  const text = String(raw ?? '').trim().toUpperCase();
  if (/^\d+$/.test(text)) return `P${text.padStart(5, '0')}`;
  if (/^P\d+$/.test(text)) return `P${text.slice(1).padStart(5, '0')}`;
  return text;
}

/**
 * Every PO number in whatever was pasted, normalised and de-duplicated.
 *
 * Split on anything that is not part of a name, so a column copied out of a
 * spreadsheet, a comma list and one-per-line all work the same.
 */
export function parsePoNumbers(text) {
  const seen = new Set();
  const out = [];
  for (const piece of String(text ?? '').split(/[\s,;]+/)) {
    const name = poName(piece);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** The configuration this needs, read out of the settings rows and the env. */
export function odooConfig(settings, env) {
  return {
    base: String(settings?.odoo_base ?? '').trim().replace(/\/+$/, ''),
    db: String(settings?.odoo_db ?? '').trim(),
    key: env?.ODOO_API_KEY ?? '',
  };
}

/** Whether there is enough here to try — said before a request, not after. */
export function configProblem(config) {
  if (!config.base) return 'No Odoo address is set. Add it under Setup → Odoo.';
  if (!/^https:\/\//i.test(config.base)) return 'The Odoo address must start with https://.';
  if (!config.key) {
    return 'No Odoo API key is set on this Worker. An administrator adds it as the '
      + 'ODOO_API_KEY secret — see the README.';
  }
  return null;
}

/**
 * One call.
 *
 * Errors become sentences rather than status codes: this runs behind a screen
 * somebody is looking at, and "401" is not something a person can act on where
 * "the API key was refused" is.
 */
async function call(config, model, method, body, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const problem = configProblem(config);
  if (problem) throw new OdooError(problem);

  const headers = {
    Authorization: `bearer ${config.key}`,
    'Content-Type': 'application/json; charset=utf-8',
  };
  // Only where one domain serves several databases. Sending it always is
  // harmless on Odoo Online but wrong on some self-hosted setups.
  if (config.db) headers['X-Odoo-Database'] = config.db;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${config.base}/json/2/${model}/${method}`, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new OdooError(`Odoo did not answer in time reading ${model}.`);
    throw new OdooError(`Odoo could not be reached: ${String(err?.message ?? err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new OdooError('Odoo refused the API key. Check it, and that the user it belongs to may read purchases.');
  }
  if (response.status === 404) {
    throw new OdooError(`Odoo has no ${model} model, or the address is wrong. Check the Odoo address under Setup.`);
  }
  if (!response.ok) {
    let detail = '';
    try { detail = JSON.stringify(await response.json()).slice(0, 300); } catch { /* body already gone */ }
    throw new OdooError(`Odoo answered ${response.status} reading ${model}. ${detail}`.trim());
  }

  try {
    return await response.json();
  } catch {
    throw new OdooError(`Odoo answered with something unreadable reading ${model}.`);
  }
}

/** An error worth showing a person as it is, as opposed to a bug. */
export class OdooError extends Error {}

/**
 * Every record matching a domain, a page at a time, ordered by id.
 *
 * A stable order is what makes paging correct: ordering by a date with ties
 * means a record can appear on two pages or on none.
 */
async function searchRead(config, model, domain, fields, opts = {}) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await call(config, model, 'search_read', {
      domain, fields, limit: PAGE, offset: page * PAGE, order: 'id',
    }, opts);
    const list = Array.isArray(rows) ? rows : (rows?.records ?? []);
    out.push(...list);
    if (list.length < PAGE) return out;
  }
  return out;
}

/**
 * Odoo returns a many2one as `[id, "Display Name"]`, or `false` when unset —
 * and `false` is falsy, so `row.partner_id[0]` on an unset field throws.
 */
const refId = (value) => (Array.isArray(value) ? value[0] : null);
const refName = (value) => (Array.isArray(value) ? String(value[1] ?? '') : '');

const LINE_FIELDS = ['id', 'order_id', 'product_id', 'name', 'product_qty', 'qty_received',
  'price_unit', 'price_subtotal', 'display_type'];

/**
 * The order lines, asking for the unit of measure by whichever name this Odoo
 * uses for it.
 *
 * Odoo 19 calls it `product_uom_id`; earlier versions call it `product_uom`.
 * Odoo refuses a request naming a field it does not have, so asking for both
 * is not an option — this asks for the new name and falls back to the old one
 * only when Odoo says the new one does not exist.
 */
async function readLines(config, orderIds, opts) {
  const domain = [['order_id', 'in', orderIds]];
  try {
    const rows = await searchRead(config, 'purchase.order.line', domain, [...LINE_FIELDS, 'product_uom_id'], opts);
    return rows.map((r) => ({ ...r, uom: r.product_uom_id }));
  } catch (err) {
    if (!/product_uom_id/.test(String(err?.message))) throw err;
    const rows = await searchRead(config, 'purchase.order.line', domain, [...LINE_FIELDS, 'product_uom'], opts);
    return rows.map((r) => ({ ...r, uom: r.product_uom }));
  }
}

/** Money to the cent, as the rest of this system stores it. */
const cents = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * Purchase orders by name, with their lines.
 *
 * Returns the orders Odoo knows, and separately the names it does not — so a
 * typo in a PO number is said out loud rather than read as "nothing to import".
 */
export async function readOrders(config, names, { fetchImpl = fetch } = {}) {
  const wanted = [...new Set((names || []).map(poName).filter(Boolean))];
  if (!wanted.length) return { orders: [], unknown: [] };
  if (wanted.length > MAX_ORDERS) {
    throw new OdooError(`That is ${wanted.length} purchase orders. Import up to ${MAX_ORDERS} at a time.`);
  }

  const raw = await searchRead(config, 'purchase.order', [['name', 'in', wanted]],
    ['id', 'name', 'partner_id', 'state', 'date_order', 'date_approve', 'amount_untaxed', 'amount_total'],
    { fetchImpl });

  const lines = raw.length ? await readLines(config, raw.map((o) => o.id), { fetchImpl }) : [];
  const byOrder = new Map(raw.map((o) => [o.id, []]));

  for (const r of lines) {
    // Section headings and free-text notes on the order are lines too, with
    // no product. They carry nothing to stock.
    if (r.display_type) continue;
    const productId = refId(r.product_id);
    if (!productId) continue;
    const qty = Number(r.product_qty || 0);
    if (!(qty > 0)) continue;

    byOrder.get(refId(r.order_id))?.push({
      lineId: r.id,
      productId,
      product: refName(r.product_id) || String(r.name || ''),
      uomId: refId(r.uom) ?? 0,
      uom: refName(r.uom) || '',
      qty,
      received: Number(r.qty_received || 0),
      // The price actually paid per unit: the subtotal over the quantity, so a
      // discount on the line is in it. Excludes tax, which is the basis the
      // insight application compares on as well.
      unitPrice: cents(Number(r.price_subtotal ?? r.price_unit * qty) / qty),
      subtotal: cents(r.price_subtotal ?? r.price_unit * qty),
    });
  }

  const orders = raw.map((o) => ({
    id: o.id,
    name: String(o.name || ''),
    vendor: refName(o.partner_id),
    state: String(o.state || ''),
    stateText: describeState(o.state),
    importable: IMPORTABLE_STATES.has(String(o.state || '')),
    orderedOn: o.date_order ? String(o.date_order).slice(0, 10) : null,
    approvedOn: o.date_approve ? String(o.date_approve).slice(0, 10) : null,
    untaxed: cents(o.amount_untaxed),
    total: cents(o.amount_total),
    lines: byOrder.get(o.id) ?? [],
  }));

  // In the order they were typed, which is the order somebody will read them.
  orders.sort((a, b) => wanted.indexOf(a.name) - wanted.indexOf(b.name));
  const found = new Set(orders.map((o) => o.name.toUpperCase()));
  return { orders, unknown: wanted.filter((n) => !found.has(n.toUpperCase())) };
}
