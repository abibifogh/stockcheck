import {
  clearCookie, createToken, getSession, sessionCookie,
  throttleCheck, throttleFail, throttleReset, tokenTtl, userForPin,
} from './lib/auth.js';
import { effectivePermissions } from './lib/permissions.js';
import {
  HttpError, badRequest, forbidden, json, readJson, str, unauthorized,
} from './lib/http.js';
import { deleteDay, getDay, listDays, saveDay } from './routes/day.js';
import * as revisions from './routes/revisions.js';
import * as importing from './routes/importing.js';
import * as catalog from './routes/catalog.js';
import * as insights from './routes/insights.js';
import * as admin from './routes/admin.js';

/**
 * Route table: [method, pattern, permission, handler].
 *
 * The permission is the gate. Hiding a menu item is a courtesy to the person
 * using the app; this table is what actually stops a cook reading the cost
 * reports. `null` means the endpoint is open to anyone signed in, and routes
 * listed before the auth check are public.
 */
const ROUTES = [
  ['POST', '/api/auth/login', 'public', login],
  ['POST', '/api/auth/logout', 'public', logout],
  ['GET', '/api/auth/me', 'public', me],

  ['GET', '/api/bootstrap', null, catalog.bootstrap],

  ['GET', '/api/days', 'entry', listDays],
  ['GET', '/api/days/:day', 'entry', getDay],
  ['PUT', '/api/days/:day', 'entry', saveDay],
  ['DELETE', '/api/days/:day', 'users', deleteDay],

  ['GET', '/api/revisions', 'approvals', revisions.listRevisions],
  ['GET', '/api/revisions/pending-count', null, revisions.pendingCount],
  ['POST', '/api/revisions/:id/review', 'approvals', revisions.reviewRevision],

  ['GET', '/api/import/template', 'entry', importing.importTemplate],
  ['POST', '/api/import/days', 'users', importing.importDays],

  ['GET', '/api/insights/overview', 'reports', insights.overview],
  ['GET', '/api/insights/daily', 'reports', insights.daily],
  ['GET', '/api/insights/weekly', 'reports', insights.weekly],
  ['GET', '/api/insights/monthly', 'reports', insights.monthly],
  ['GET', '/api/export', 'reports', insights.exportCsv],

  ['GET', '/api/insights/stock', 'stock', insights.stock],
  ['POST', '/api/stock-counts', 'stock', catalog.createStockCount],

  ['GET', '/api/purchases', 'purchases', catalog.listPurchases],
  ['GET', '/api/purchases/last-costs', 'purchases', catalog.getLastCosts],
  ['POST', '/api/purchases', 'purchases', catalog.createPurchase],
  ['POST', '/api/deliveries', 'purchases', catalog.createDelivery],
  ['DELETE', '/api/purchases/:id', 'purchases', catalog.deletePurchase],

  ['POST', '/api/categories', 'setup', catalog.createCategory],
  ['PUT', '/api/categories/:id', 'setup', catalog.updateCategory],
  ['DELETE', '/api/categories/:id', 'setup', catalog.deleteCategory],

  ['POST', '/api/ingredients', 'setup', catalog.createIngredient],
  ['PUT', '/api/ingredients/:id', 'setup', catalog.updateIngredient],
  ['DELETE', '/api/ingredients/:id', 'setup', catalog.deleteIngredient],

  ['GET', '/api/suppliers', 'purchases', catalog.listSuppliers],
  ['POST', '/api/suppliers', 'setup', catalog.createSupplier],
  ['PUT', '/api/suppliers/:id', 'setup', catalog.updateSupplier],
  ['DELETE', '/api/suppliers/:id', 'setup', catalog.deleteSupplier],

  ['PUT', '/api/settings', 'setup', catalog.updateSettings],

  ['GET', '/api/users', 'users', admin.listUsers],
  ['POST', '/api/users', 'users', admin.createUser],
  ['PUT', '/api/users/:id', 'users', admin.updateUser],
  ['DELETE', '/api/users/:id', 'users', admin.deleteUser],

  ['GET', '/api/notifications', 'users', admin.getNotifications],
  ['PUT', '/api/notifications', 'users', admin.updateNotifications],
  ['POST', '/api/notifications/test', 'users', admin.testNotification],

  ['GET', '/api/data/summary', 'users', admin.dataSummary],
  ['POST', '/api/data/erase', 'users', admin.eraseData],

  ['GET', '/api/locks', null, admin.listLocks],
  ['POST', '/api/locks', 'users', admin.createLock],
  ['DELETE', '/api/locks/:id', 'users', admin.deleteLock],

  ['GET', '/api/audit', 'users', admin.auditTrail],
];

function match(pattern, pathname) {
  const want = pattern.split('/');
  const got = pathname.split('/');
  if (want.length !== got.length) return null;
  const params = [];
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      if (!got[i]) return null;
      params.push(decodeURIComponent(got[i]));
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}

export default {
  async fetch(request, env, executionContext) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await route(request, env, url, executionContext);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message, detail: err.detail ?? null }, { status: err.status });
      }
      console.error('Unhandled error', err);
      return json({ error: 'Something went wrong on the server' }, { status: 500 });
    }
  },
};

async function route(request, env, url, executionContext) {
  if (!env.SESSION_SECRET) {
    return json(
      { error: 'Server not configured: SESSION_SECRET is missing. See the README setup steps.' },
      { status: 503 },
    );
  }
  if (!env.DB) {
    return json({ error: 'Server not configured: no database binding.' }, { status: 503 });
  }

  const method = request.method === 'HEAD' ? 'GET' : request.method;
  let allowedMethods = null;

  for (const [routeMethod, pattern, permission, handler] of ROUTES) {
    const params = match(pattern, url.pathname);
    if (!params) continue;
    if (routeMethod !== method) {
      allowedMethods = allowedMethods || [];
      allowedMethods.push(routeMethod);
      continue;
    }

    const ctx = { request, env, url, db: env.DB, executionContext, session: null };

    if (permission !== 'public') {
      ctx.session = await getSession(request, env, env.DB);
      if (!ctx.session) throw unauthorized();
      if (permission && !ctx.session.permissions.includes(permission)) {
        throw forbidden('You do not have access to that part of the system.');
      }
    }

    return handler(ctx, ...params);
  }

  if (allowedMethods?.length) {
    return json({ error: 'Method not allowed' }, {
      status: 405,
      headers: { Allow: [...new Set(allowedMethods)].join(', ') },
    });
  }
  return json({ error: 'Unknown endpoint' }, { status: 404 });
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

async function login(ctx) {
  const { request, env, url, db } = ctx;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  const gate = throttleCheck(ip);
  if (!gate.allowed) {
    return json(
      { error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.` },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } },
    );
  }

  const body = await readJson(request);
  const pin = str(body.pin, 'PIN', { required: true, max: 64 });

  const user = await userForPin(db, pin, env);
  if (!user) {
    throttleFail(ip);
    // A uniform delay keeps a wrong PIN from being distinguishable by timing.
    await new Promise((resolve) => setTimeout(resolve, 400));
    throw badRequest('That PIN was not recognised');
  }

  throttleReset(ip);

  const now = Math.floor(Date.now() / 1000);
  const token = await createToken(
    {
      uid: user.id,
      role: user.role,
      recovery: user.isRecovery ? 1 : 0,
      iat: now,
      exp: now + tokenTtl(user.role),
    },
    env.SESSION_SECRET,
  );

  if (!user.isRecovery) {
    await db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
      .bind(user.id).run().catch(() => {});
  }

  return json({
    ok: true,
    role: user.role,
    name: user.name,
    permissions: effectivePermissions(user),
  }, {
    headers: { 'Set-Cookie': sessionCookie(token, user.role, url.protocol === 'https:') },
  });
}

async function logout(ctx) {
  return json({ ok: true }, {
    headers: { 'Set-Cookie': clearCookie(ctx.url.protocol === 'https:') },
  });
}

async function me(ctx) {
  const session = await getSession(ctx.request, ctx.env, ctx.db);
  if (!session) return json({ authenticated: false });

  const settings = await ctx.db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('property_name','currency','timezone')",
  ).all();

  return json({
    authenticated: true,
    role: session.user.role,
    name: session.user.name,
    userId: session.user.id,
    permissions: session.permissions,
    settings: Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value])),
  });
}
