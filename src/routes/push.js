import { badRequest, json, readJson, str } from '../lib/http.js';
import {
  getVapidKeys, pingDaySubmitted, renderPing, sendPush,
} from '../lib/push.js';
import { dailyInsights, loadDataset } from '../lib/analytics.js';

/**
 * Turning alerts on is per browser, not per person: permission to show a
 * notification is something a browser grants to a site on one device, and there
 * is no way to carry it to another. Somebody who wants alerts on their phone
 * and on the office computer turns it on twice, which is exactly what the
 * notification permission itself requires.
 */

/** The public half of our signing key, which the browser needs to subscribe. */
export async function publicKey(ctx) {
  const vapid = await getVapidKeys(ctx.db);
  return json({ key: vapid.vapid_public });
}

export async function subscribe(ctx) {
  const body = await readJson(ctx.request);
  const endpoint = str(body.endpoint, 'Endpoint', { required: true, max: 1000 });
  const p256dh = str(body.p256dh, 'Key', { required: true, max: 200 });
  const auth = str(body.auth, 'Auth secret', { required: true, max: 100 });
  const label = str(body.label, 'Device', { max: 100, fallback: '' });

  if (!/^https:\/\//.test(endpoint)) throw badRequest('That is not a valid push address');

  // The same browser re-subscribing replaces its old row rather than piling up
  // duplicates — endpoints are rotated by the push service from time to time.
  await ctx.db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh  = excluded.p256dh,
       auth    = excluded.auth,
       label   = excluded.label`,
    // The emergency recovery sign-in has no row in users, so it subscribes as
    // nobody rather than as a user id that does not exist.
  ).bind(ctx.session.user.id || null, endpoint, p256dh, auth, label || null).run();

  return json({ ok: true });
}

/** An administrator retiring somebody else's device — a lost or replaced phone. */
export async function removeDevice(ctx, id) {
  const result = await ctx.db.prepare('DELETE FROM push_subscriptions WHERE id = ?')
    .bind(Number(id)).run();
  if (!result.meta?.changes) throw badRequest('That device is no longer on the list.');
  return json({ ok: true });
}

export async function unsubscribe(ctx) {
  const body = await readJson(ctx.request);
  const endpoint = str(body.endpoint, 'Endpoint', { required: true, max: 1000 });
  await ctx.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
  return json({ ok: true });
}

/** Whether this particular browser is already set up, and who else is. */
export async function status(ctx) {
  const url = ctx.url.searchParams.get('endpoint');
  const mine = url
    ? await ctx.db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').bind(url).first()
    : null;

  const rows = await ctx.db.prepare(
    `SELECT p.id, p.label, p.created_at, u.name
       FROM push_subscriptions p
       LEFT JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC`,
  ).all();

  const setting = await ctx.db.prepare(
    "SELECT value FROM settings WHERE key = 'push_on_submit'",
  ).first();

  return json({
    enabled: setting?.value === '1',
    subscribedHere: Boolean(mine),
    devices: rows.results ?? [],
  });
}

/** Send a ping to this browser now, so somebody can prove it works. */
export async function test(ctx) {
  const body = await readJson(ctx.request);
  const endpoint = str(body.endpoint, 'Endpoint', { required: true, max: 1000 });

  const sub = await ctx.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?')
    .bind(endpoint).first();
  if (!sub) throw badRequest('This browser is not set up for alerts yet.');

  const settingsRows = await ctx.db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries((settingsRows.results ?? []).map((r) => [r.key, r.value]));

  const latest = await ctx.db.prepare('SELECT day FROM service_days ORDER BY day DESC LIMIT 1').first();

  let message;
  if (latest) {
    const ds = await loadDataset(ctx.db);
    const ping = renderPing({
      insight: dailyInsights(ds, latest.day),
      propertyName: settings.property_name || 'Breakfast Unit',
      submittedBy: `${ctx.session.user.name} (test)`,
      resubmission: false,
    });
    message = JSON.stringify({ ...ping, url: `${settings.site_url || ''}/#/daily?day=${latest.day}` });
  } else {
    message = JSON.stringify({
      title: settings.property_name || 'Breakfast Unit',
      body: 'Test alert. This is what you will see when a day is submitted.',
      url: settings.site_url || '',
    });
  }

  const vapid = await getVapidKeys(ctx.db);
  const subject = settings.email_from && settings.email_from.includes('@')
    ? `mailto:${settings.email_from.replace(/^.*<|>.*$/g, '').trim()}`
    : (settings.site_url || 'https://example.com');

  const result = await sendPush(sub, message, vapid, subject);

  if (!result.ok && result.gone) {
    await ctx.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
    throw badRequest('This browser’s alert permission has expired. Turn alerts off and on again.');
  }
  if (!result.ok) {
    throw badRequest(`The push service refused it (${result.status}). ${result.detail ?? ''}`.trim());
  }

  return json({ ok: true });
}

export { pingDaySubmitted };
