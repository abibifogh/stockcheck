import {
  clearCookie, createToken, getPepper, getSession, hashPin, isReservedPin,
  saltForEmail, sessionCookie, storedPassword, throttleCheck, throttleFail,
  throttleReset, tokenTtl, userForCredentials, userForPin, verifyPasswordKey,
} from './lib/auth.js';
import { allows, effectivePermissions } from './lib/permissions.js';
import { servesPath, siteOf } from './lib/site.js';
import {
  HttpError, badRequest, forbidden, isMissingTable, json, readJson, str, unauthorized,
} from './lib/http.js';
import { deleteDay, getDay, listDays, saveDay } from './routes/day.js';
import * as revisions from './routes/revisions.js';
import * as importing from './routes/importing.js';
import * as catalog from './routes/catalog.js';
import * as insights from './routes/insights.js';
import * as admin from './routes/admin.js';
import * as push from './routes/push.js';
import * as mx from './routes/maintenance.js';
import * as bakery from './routes/bakery.js';
import * as shop from './routes/shop.js';
import * as stocktakes from './routes/stocktakes.js';
import * as hk from './routes/housekeeping.js';
import * as co from './routes/correspondence.js';
import * as coWork from './routes/co-work.js';
import * as coReports from './routes/co-reports.js';
import * as coSetup from './routes/co-setup.js';
import { runSweep } from './lib/co-workflow.js';
import { openDueTasks } from './lib/stocktakes.js';
import { todayIn } from './util/dates.js';
import { PIN_TAKEN } from './routes/admin.js';

/**
 * Route table: [method, pattern, permission, handler].
 *
 * The permission is the gate. Hiding a menu item is a courtesy to the person
 * using the app; this table is what actually stops a cook reading the cost
 * reports. `null` means the endpoint is open to anyone signed in, and routes
 * listed before the auth check are public.
 */
const ROUTES = [
  ['POST', '/api/auth/salt', 'public', passwordSalt],
  ['POST', '/api/auth/login', 'public', login],
  ['POST', '/api/auth/logout', 'public', logout],
  ['GET', '/api/auth/me', 'public', me],
  ['POST', '/api/auth/change-credentials', null, changeCredentials],

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
  ['GET', '/api/insights/compare', 'reports', insights.compare],
  ['GET', '/api/export', 'reports', insights.exportCsv],

  // --------------------------------------------------------------- bakery --
  // The two public routes are the whole point: the bakery reports what came
  // out of the oven without needing an account. The token in the body is the
  // gate, and all it can do is add stock.
  ['POST', '/api/bakery/open', 'public', bakery.open],
  ['POST', '/api/bakery/submit', 'public', bakery.submit],

  ['GET', '/api/bakery/form', 'bakery', bakery.form],
  ['POST', '/api/production', 'bakery', bakery.create],
  ['GET', '/api/production', 'stock', bakery.log],
  ['DELETE', '/api/production/:id', 'stock', bakery.remove],

  ['GET', '/api/bakery/links', 'users', bakery.listLinks],
  ['POST', '/api/bakery/links', 'users', bakery.createLink],
  ['DELETE', '/api/bakery/links/:id', 'users', bakery.revokeLink],

  ['GET', '/api/insights/stock', 'stock', insights.stock],
  ['POST', '/api/stock-counts', 'stock', catalog.createStockCount],
  ['GET', '/api/stock-counts/pending', 'stock', catalog.pendingStockCounts],
  // Accepting a count rewrites the shelf, so it is an administrator's call —
  // never the same person who did the counting.
  ['POST', '/api/stock-counts/review', 'users', catalog.reviewStockCounts],

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

  ['GET', '/api/push/key', null, push.publicKey],
  ['GET', '/api/push/status', null, push.status],
  ['POST', '/api/push/subscribe', null, push.subscribe],
  ['POST', '/api/push/unsubscribe', null, push.unsubscribe],
  ['POST', '/api/push/test', null, push.test],
  ['DELETE', '/api/push/devices/:id', 'users', push.removeDevice],

  ['GET', '/api/notifications', 'users', admin.getNotifications],
  ['PUT', '/api/notifications', 'users', admin.updateNotifications],
  ['POST', '/api/notifications/test', 'users', admin.testNotification],

  ['GET', '/api/data/summary', 'users', admin.dataSummary],
  ['POST', '/api/data/erase', 'users', admin.eraseData],

  ['GET', '/api/locks', null, admin.listLocks],
  ['POST', '/api/locks', 'users', admin.createLock],
  ['DELETE', '/api/locks/:id', 'users', admin.deleteLock],

  ['GET', '/api/audit', 'users', admin.auditTrail],

  // The bell. Open to anyone signed in, and what each person sees is decided
  // inside the query by the permissions they already hold — a housekeeper sees
  // that reception submitted the morning check, and does not see that eight
  // parts are waiting on an administrator.
  ['GET', '/api/notices', null, admin.listNoticesRoute],
  ['POST', '/api/notices/seen', null, admin.markNoticesSeen],

  // ------------------------------------------------------------ maintenance --
  // A separate store with its own permissions, so a technician can be given the
  // issue screen and nothing else.
  ['GET', '/api/mx/bootstrap', 'mx_issue', mx.bootstrap],

  ['GET', '/api/mx/issues', 'mx_issue', mx.listIssues],
  ['POST', '/api/mx/issues', 'mx_issue', mx.createIssue],
  ['DELETE', '/api/mx/issues/:id', 'mx_issue', mx.deleteIssue],

  ['GET', '/api/mx/purchases', 'mx_purchases', mx.listPurchases],
  ['GET', '/api/mx/purchases/last-costs', 'mx_purchases', mx.lastCosts],
  ['POST', '/api/mx/deliveries', 'mx_purchases', mx.createDelivery],
  ['DELETE', '/api/mx/purchases/:id', 'mx_purchases', mx.deletePurchase],

  ['GET', '/api/mx/stock', 'mx_stock', mx.stock],
  ['POST', '/api/mx/counts', 'mx_stock', mx.saveCounts],
  ['GET', '/api/mx/counts/pending', 'mx_stock', mx.pendingCounts],
  ['GET', '/api/mx/counts/history', 'mx_stock', mx.countHistory],
  // Accepting a count rewrites the shelf, so it is an administrator's call —
  // never the same person who did the counting.
  ['POST', '/api/mx/counts/review', 'users', mx.reviewCounts],

  ['GET', '/api/mx/overview', 'mx_reports', mx.overview],
  ['GET', '/api/mx/report', 'mx_reports', mx.report],
  ['GET', '/api/mx/compare', 'mx_reports', mx.compare],
  ['GET', '/api/mx/areas/:id/detail', 'mx_reports', mx.areaDetail],

  ['GET', '/api/mx/areas', 'mx_issue', mx.listAreas],
  ['POST', '/api/mx/areas', 'mx_setup', mx.createArea],
  ['POST', '/api/mx/areas/range', 'mx_setup', mx.createAreaRange],
  ['PUT', '/api/mx/areas/:id', 'mx_setup', mx.updateArea],
  ['DELETE', '/api/mx/areas/:id', 'mx_setup', mx.deleteArea],

  ['POST', '/api/mx/items', 'mx_setup', mx.createItem],
  ['PUT', '/api/mx/items/:id', 'mx_setup', mx.updateItem],
  ['DELETE', '/api/mx/items/:id', 'mx_setup', mx.deleteItem],
  ['POST', '/api/mx/categories', 'mx_setup', mx.createCategory],
  ['GET', '/api/mx/items/template', 'mx_setup', mx.partsTemplate],
  ['POST', '/api/mx/items/import', 'mx_setup', mx.importParts],
  ['POST', '/api/mx/items/remove', 'mx_setup', mx.removeItems],
  ['POST', '/api/mx/areas/remove', 'mx_setup', mx.removeAreas],

  // Scheduled counts. Anybody who can count sees what they have been asked to
  // do; only setup can decide who is asked, and how often.
  ['GET', '/api/mx/stocktakes/mine', 'mx_stock', stocktakes.myTasks],
  ['GET', '/api/mx/stocktakes', 'mx_setup', stocktakes.list],
  ['POST', '/api/mx/stocktakes', 'mx_setup', stocktakes.create],
  ['PUT', '/api/mx/stocktakes/:id', 'mx_setup', stocktakes.update],
  ['DELETE', '/api/mx/stocktakes/:id', 'mx_setup', stocktakes.remove],
  ['POST', '/api/mx/stocktakes/:id/run', 'mx_setup', stocktakes.runNow],
  ['POST', '/api/mx/stocktake-tasks/:id/cancel', 'mx_setup', stocktakes.cancelTask],

  // ------------------------------------------------------------- craft shop --
  // The third store, and the only one that takes money. Its own permissions
  // again, so somebody hired for the till gets the till and nothing else.
  ['GET', '/api/shop/bootstrap', 'shop_sell', shop.bootstrap],

  ['POST', '/api/shop/sales', 'shop_sell', shop.createSale],
  ['GET', '/api/shop/sales', 'shop_sell', shop.listSales],
  ['GET', '/api/shop/sales/:id', 'shop_sell', shop.getSale],
  // Voiding is not deleting, and it is not the assistant's call.
  ['POST', '/api/shop/sales/:id/void', 'shop_reports', shop.voidSale],
  ['GET', '/api/shop/till', 'shop_sell', shop.tillReport],

  ['GET', '/api/shop/purchases', 'shop_purchases', shop.listPurchases],
  ['GET', '/api/shop/purchases/last-costs', 'shop_purchases', shop.lastCosts],
  ['POST', '/api/shop/deliveries', 'shop_purchases', shop.createDelivery],
  ['DELETE', '/api/shop/purchases/:id', 'shop_purchases', shop.deletePurchase],

  ['GET', '/api/shop/stock', 'shop_stock', shop.stock],
  ['POST', '/api/shop/counts', 'shop_stock', shop.saveCounts],
  ['GET', '/api/shop/counts/pending', 'shop_stock', shop.pendingCounts],
  ['POST', '/api/shop/counts/review', 'users', shop.reviewCounts],

  ['GET', '/api/shop/overview', 'shop_reports', shop.overview],
  ['GET', '/api/shop/report', 'shop_reports', shop.report],
  ['GET', '/api/shop/compare', 'shop_reports', shop.compare],
  ['GET', '/api/shop/export', 'shop_reports', shop.exportCsv],

  ['POST', '/api/shop/categories', 'shop_setup', shop.createCategory],
  ['POST', '/api/shop/items', 'shop_setup', shop.createItem],
  ['PUT', '/api/shop/items/:id', 'shop_setup', shop.updateItem],
  ['POST', '/api/shop/items/remove', 'shop_setup', shop.removeItems],
  ['PUT', '/api/shop/settings', 'shop_setup', shop.updateSettings],

  // ----------------------------------------------------------- housekeeping --
  // The dorm bed check. `hk_check` reaches the round and nothing else, so a
  // housekeeper's PIN opens one screen: the beds, and the two questions.
  ['GET', '/api/hk/bootstrap', 'hk_check', hk.bootstrap],
  ['POST', '/api/hk/checks', 'hk_check', hk.saveChecks],
  ['POST', '/api/hk/rounds/:day/:slot/submit', 'hk_check', hk.submitRound],
  ['GET', '/api/hk/rounds', 'hk_reports', hk.listRounds],
  ['GET', '/api/hk/day', 'hk_reports', hk.getDay],

  ['GET', '/api/hk/overview', 'hk_reports', hk.overview],
  ['GET', '/api/hk/report', 'hk_reports', hk.report],
  ['GET', '/api/hk/rooms/:id/detail', 'hk_reports', hk.roomReport],
  ['GET', '/api/hk/export', 'hk_reports', hk.exportCsv],

  ['GET', '/api/hk/rooms', ['hk_roster', 'hk_setup'], hk.listRooms],
  ['POST', '/api/hk/rooms', 'hk_setup', hk.createRoom],
  ['PUT', '/api/hk/rooms/:id', 'hk_setup', hk.updateRoom],
  ['DELETE', '/api/hk/rooms/:id', 'hk_setup', hk.deleteRoom],
  ['POST', '/api/hk/beds', 'hk_setup', hk.createBed],
  ['PUT', '/api/hk/beds/:id', 'hk_setup', hk.updateBed],
  ['DELETE', '/api/hk/beds/:id', 'hk_setup', hk.deleteBed],
  ['POST', '/api/hk/roster', ['hk_roster', 'hk_setup'], hk.saveRoster],
  ['PUT', '/api/hk/settings', 'hk_setup', hk.updateSettings],

  // -------------------------------------------------------- correspondence --
  // The accounting practice's register. Its own permissions again, and the one
  // set where the gate matters most: `co_oversight` is what separates a
  // restricted client file from everybody else in the firm.
  ['GET', '/api/co/bootstrap', null, co.bootstrap],

  ['GET', '/api/co/letters', ['co_register', 'co_route', 'co_reports'], co.listLetters],
  ['POST', '/api/co/letters', 'co_register', co.createLetter],
  ['GET', '/api/co/letters/:id', ['co_register', 'co_route', 'co_reports'], co.getLetter],
  ['PUT', '/api/co/letters/:id', 'co_register', co.updateLetter],
  ['POST', '/api/co/letters/:id/status', 'co_register', co.setStatus],
  ['POST', '/api/co/letters/:id/archive', 'co_register', co.archiveLetter],
  ['POST', '/api/co/letters/:id/links', 'co_register', co.linkLetter],
  ['GET', '/api/co/export', 'co_reports', co.exportRegister],

  // Routing. Acting on what is in front of you is `co_route`; the two decisions
  // that carry weight — approving and signing — need `co_approve` as well, and
  // that is checked inside the handler where the ask is known.
  ['GET', '/api/co/mine', null, co.myWork],
  ['POST', '/api/co/letters/:id/routes', 'co_route', co.createRoute],
  ['POST', '/api/co/routes/:id/act', 'co_route', co.actOnRoute],
  ['POST', '/api/co/routes/:id/cancel', 'co_route', co.cancelRoute],

  ['POST', '/api/co/letters/:id/sign', 'co_approve', co.signLetter],
  ['GET', '/api/co/letters/:id/verify', ['co_oversight', 'co_reports'], co.verifyLetter],

  ['POST', '/api/co/attachments', 'co_register', co.uploadAttachment],
  ['GET', '/api/co/attachments/:id', null, co.downloadAttachment],
  ['DELETE', '/api/co/attachments/:id', 'co_register', co.removeAttachment],

  ['GET', '/api/co/templates', 'co_register', co.listTemplates],
  ['GET', '/api/co/templates/:id/render', 'co_register', co.renderTemplate],

  ['GET', '/api/co/parties', ['co_cases', 'co_register'], coWork.listParties],
  ['POST', '/api/co/parties', 'co_cases', coWork.createParty],
  ['PUT', '/api/co/parties/:id', 'co_cases', coWork.updateParty],

  ['GET', '/api/co/cases', ['co_cases', 'co_reports'], coWork.listCases],
  ['POST', '/api/co/cases', 'co_cases', coWork.createCase],
  ['GET', '/api/co/cases/:id', ['co_cases', 'co_reports'], coWork.getCase],
  ['PUT', '/api/co/cases/:id', 'co_cases', coWork.updateCase],
  ['GET', '/api/co/cases-export', 'co_reports', coWork.exportCases],

  ['GET', '/api/co/tasks', null, coWork.listTasks],
  ['POST', '/api/co/tasks', 'co_tasks', coWork.createTask],
  ['PUT', '/api/co/tasks/:id', null, coWork.updateTask],

  ['GET', '/api/co/meetings', 'co_meetings', coWork.listMeetings],
  ['POST', '/api/co/meetings', 'co_meetings', coWork.createMeeting],
  ['GET', '/api/co/meetings/:id', 'co_meetings', coWork.getMeeting],
  ['PUT', '/api/co/meetings/:id', 'co_meetings', coWork.updateMeeting],
  ['POST', '/api/co/meetings/:id/minutes', 'co_meetings', coWork.recordMinutes],
  ['POST', '/api/co/meetings/:id/attendance', 'co_meetings', coWork.markAttendance],

  ['GET', '/api/co/reports/overview', 'co_reports', coReports.overview],
  ['GET', '/api/co/reports/productivity', 'co_reports', coReports.productivity],
  ['GET', '/api/co/reports/departments', 'co_reports', coReports.byDepartment],
  ['GET', '/api/co/reports/activity', 'co_reports', coReports.activity],
  ['GET', '/api/co/reports/retention', ['co_oversight', 'co_setup'], coReports.retention],
  ['GET', '/api/co/reports/trail-export', ['co_oversight', 'co_reports'], coReports.exportTrail],

  ['GET', '/api/co/setup', 'co_setup', coSetup.setup],
  ['PUT', '/api/co/setup/settings', 'co_setup', coSetup.updateSettings],
  ['POST', '/api/co/setup/departments', 'co_setup', coSetup.createDepartment],
  ['PUT', '/api/co/setup/departments/:id', 'co_setup', coSetup.updateDepartment],
  ['POST', '/api/co/setup/categories', 'co_setup', coSetup.createCategory],
  ['PUT', '/api/co/setup/categories/:id', 'co_setup', coSetup.updateCategory],
  ['POST', '/api/co/setup/templates', 'co_setup', coSetup.createTemplate],
  ['PUT', '/api/co/setup/templates/:id', 'co_setup', coSetup.updateTemplate],
  ['DELETE', '/api/co/setup/templates/:id', 'co_setup', coSetup.deleteTemplate],
  ['POST', '/api/co/setup/workflows', 'co_setup', (ctx) => coSetup.saveWorkflow(ctx, null)],
  ['PUT', '/api/co/setup/workflows/:id', 'co_setup', coSetup.saveWorkflow],
  ['DELETE', '/api/co/setup/workflows/:id', 'co_setup', coSetup.deleteWorkflow],
  ['PUT', '/api/co/setup/staff/:id', 'co_setup', coSetup.saveStaff],
  ['POST', '/api/co/setup/sweep', 'co_setup', coSetup.sweepNow],
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
      if (isMissingTable(err)) {
        return json({
          error: 'This site has been updated but its database has not. '
            + 'Run the latest database changes — see “Create the tables” in the setup guide — '
            + 'and this will start working. Nothing has been lost.',
          detail: { missingSchema: true },
        }, { status: 503 });
      }
      // Last resort: a constraint that slipped past its handler is still a
      // rule being broken, not a broken server. Say which rule.
      const text = String(err?.message ?? err);
      if (/UNIQUE constraint/i.test(text)) {
        return json({
          error: 'That would duplicate something that has to be unique — usually a name '
            + 'that is already taken. Change it and try again.',
        }, { status: 400 });
      }
      if (/FOREIGN KEY constraint/i.test(text)) {
        return json({
          error: 'That refers to something that no longer exists. Reload the page and try again.',
        }, { status: 400 });
      }

      console.error('Unhandled error', err);
      return json({ error: 'Something went wrong on the server' }, { status: 500 });
    }
  },

  /**
   * The tick, from a Cron Trigger.
   *
   * Each site has its own work to do here and does only its own. On the hotel
   * deployments that is noticing a scheduled stock count has come round; on the
   * practice it is reminders, escalations and rolling recurring meetings
   * forward.
   *
   * Everything either one does is idempotent, so a cron that fires twice — or a
   * person pressing the button in Setup — cannot produce two tasks, two
   * escalations or two rounds of email for the same thing.
   */
  async scheduled(event, env, executionContext) {
    if (!env.DB) return;
    const site = siteOf(env);

    const run = (async () => {
      if (site === 'correspondence') {
        const result = await runSweep(env.DB, env, new Date());
        if (result.skipped) return;
        console.log(
          `Sweep: ${result.reminded} reminded, ${result.escalated} escalated, `
          + `${result.tasksReminded} action points, ${result.meetingsReminded} meetings, `
          + `${result.occurrencesCreated} occurrences created`,
        );
        return;
      }

      const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'timezone'")
        .first()
        .catch(() => null);
      const result = await openDueTasks(env.DB, env, todayIn(row?.value || 'UTC'));
      if (result.opened) console.log(`Opened ${result.opened} stock count task(s)`);
    })().catch((err) => console.error('Scheduled run failed', err));

    if (executionContext?.waitUntil) executionContext.waitUntil(run);
    else await run;
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

  // A housekeeping deployment serves the bed check and the things every site
  // needs — signing in, people, notifications. The breakfast and maintenance
  // API is simply not there.
  if (!servesPath(siteOf(env), url.pathname)) {
    return json({ error: 'Unknown endpoint' }, { status: 404 });
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
      // A list means any one of them is enough — see `allows`.
      if (!allows(permission, ctx.session.permissions)) {
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

/**
 * The salt and work factor to derive with, for a given address.
 *
 * Public by necessity — the browser needs it before it can prove anything. An
 * address with no account gets a stable made-up salt, so this cannot be used to
 * find out who has an account.
 */
async function passwordSalt(ctx) {
  const body = await readJson(ctx.request);
  const email = str(body.email, 'Email address', { required: true, max: 200 });
  const params = await saltForEmail(ctx.db, email, await getPepper(ctx.db));
  return json(params);
}

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

  // Two ways in: a PIN for the kitchen and anyone managing the operation, or an
  // email address and password for administrators.
  const user = body.email
    ? await userForCredentials(db, body.email, String(body.passwordKey ?? ''))
    : await userForPin(db, str(body.pin, 'PIN', { required: true, max: 64 }), env);

  if (!user) {
    throttleFail(ip);
    // A uniform delay keeps a wrong credential from being distinguishable by
    // timing, and says nothing about which half was wrong.
    await new Promise((resolve) => setTimeout(resolve, 400));
    throw badRequest(body.email
      ? 'That email address and password combination was not recognised'
      : 'That PIN was not recognised');
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
    email: user.email ?? null,
    isRecovery: Boolean(user.isRecovery),
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
    email: session.user.email ?? null,
    userId: session.user.id,
    isRecovery: Boolean(session.user.isRecovery),
    signsInWith: session.user.role === 'admin' ? 'password' : 'pin',
    permissions: session.permissions,
    settings: Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value])),
  });
}

/**
 * Change your own PIN or password.
 *
 * Everyone can do this for themselves, which is what stops a shared PIN
 * quietly becoming permanent because changing it needed an administrator.
 * The current credential is always required, so an unattended signed-in tablet
 * cannot be used to lock its owner out.
 */
async function changeCredentials(ctx) {
  const { db, session } = ctx;
  const body = await readJson(ctx.request);

  if (session.user.isRecovery) {
    throw badRequest(
      'You are signed in with the emergency recovery PIN, which is set on the server rather than here. '
      + 'Sign in with your own account to change its credentials.',
    );
  }

  const row = await db.prepare(
    'SELECT id, role, pin_hash, password_hash FROM users WHERE id = ?',
  ).bind(session.user.id).first();
  if (!row) throw badRequest('Your account could not be found');

  // Administrators hold a password; everyone else holds a PIN.
  if (session.user.role === 'admin') {
    const pepper = await getPepper(db);
    const currentKey = String(body.currentPasswordKey ?? '');

    if (!await verifyPasswordKey(currentKey, row.password_hash, pepper)) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      throw badRequest('Your current password is not correct');
    }
    if (!body.passwordKey || !body.passwordSalt) {
      throw badRequest('The new password did not reach the server correctly. Please try again.');
    }
    if (body.passwordKey === currentKey) {
      throw badRequest('The new password is the same as the current one');
    }

    const next = await storedPassword({
      passwordKey: String(body.passwordKey),
      salt: String(body.passwordSalt),
      iterations: body.passwordIterations,
    }, pepper);

    await db.batch([
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(next, row.id),
      db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
        .bind(`${session.user.name} (${session.user.role})`, 'account.password_change', String(row.id), null),
    ]);

    return json({ ok: true, changed: 'password' });
  }

  const current = String(body.currentPin ?? '');
  const next = String(body.newPin ?? '');
  const pepper = await getPepper(db);

  if (await hashPin(current, pepper) !== row.pin_hash) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    throw badRequest('Your current PIN is not correct');
  }
  if (!/^\d{4,10}$/.test(next)) throw badRequest('The new PIN must be 4 to 10 digits');
  if (next === current) throw badRequest('The new PIN is the same as the current one');
  if (await isReservedPin(next, ctx.env)) throw badRequest(PIN_TAKEN);

  try {
    await db.batch([
      db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?')
        .bind(await hashPin(next, pepper), row.id),
      db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
        .bind(`${session.user.name} (${session.user.role})`, 'account.pin_change', String(row.id), null),
    ]);
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw badRequest(PIN_TAKEN);
    throw err;
  }

  return json({ ok: true, changed: 'pin' });
}
