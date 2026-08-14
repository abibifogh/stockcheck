// Thin fetch wrapper. Every call goes through here so authentication failures
// and offline states are handled in exactly one place.

class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'No connection to the server. Your work is saved on this device and will sync when you are back online.');
  }

  if (response.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'Your session has expired. Sign in again.');
  }

  const type = response.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) {
    if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status})`);
    return response;
  }

  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.error || `Request failed (${response.status})`, data.detail);
  return data;
}

export const api = {
  ApiError,
  login: (pin) => request('/api/auth/login', { method: 'POST', body: { pin } }),
  passwordSalt: (email) => request('/api/auth/salt', { method: 'POST', body: { email } }),
  loginWithKey: (email, passwordKey) =>
    request('/api/auth/login', { method: 'POST', body: { email, passwordKey } }),
  changeCredentials: (body) =>
    request('/api/auth/change-credentials', { method: 'POST', body }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),

  bootstrap: () => request('/api/bootstrap'),
  recentDays: (limit = 30) => request(`/api/days?limit=${limit}`),
  getDay: (day) => request(`/api/days/${day}`),
  saveDay: (day, payload) => request(`/api/days/${day}`, { method: 'PUT', body: payload }),
  deleteDay: (day) => request(`/api/days/${day}`, { method: 'DELETE' }),

  revisions: (status = 'pending') => request(`/api/revisions?status=${status}`),
  pendingCount: () => request('/api/revisions/pending-count'),
  reviewRevision: (id, body) => request(`/api/revisions/${id}/review`, { method: 'POST', body }),

  importTemplateUrl: () => '/api/import/template',
  importDays: (body) => request('/api/import/days', { method: 'POST', body }),

  locks: () => request('/api/locks'),
  createLock: (body) => request('/api/locks', { method: 'POST', body }),
  deleteLock: (id) => request(`/api/locks/${id}`, { method: 'DELETE' }),
  audit: (limit = 100) => request(`/api/audit?limit=${limit}`),

  overview: () => request('/api/insights/overview'),
  daily: (day) => request(`/api/insights/daily${day ? `?day=${day}` : ''}`),
  weekly: (week) => request(`/api/insights/weekly${week ? `?week=${week}` : ''}`),
  monthly: (month) => request(`/api/insights/monthly${month ? `?month=${month}` : ''}`),
  compare: (a, b) => request(`/api/insights/compare?${new URLSearchParams({
    aFrom: a.from, aTo: a.to, bFrom: b.from, bTo: b.to,
  })}`),
  stock: (asOf) => request(`/api/insights/stock${asOf ? `?asOf=${asOf}` : ''}`),

  createCategory: (body) => request('/api/categories', { method: 'POST', body }),
  updateCategory: (id, body) => request(`/api/categories/${id}`, { method: 'PUT', body }),
  deleteCategory: (id) => request(`/api/categories/${id}`, { method: 'DELETE' }),

  createIngredient: (body) => request('/api/ingredients', { method: 'POST', body }),
  updateIngredient: (id, body) => request(`/api/ingredients/${id}`, { method: 'PUT', body }),
  deleteIngredient: (id) => request(`/api/ingredients/${id}`, { method: 'DELETE' }),

  purchases: (from, to) => request(`/api/purchases?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`),
  createPurchase: (body) => request('/api/purchases', { method: 'POST', body }),
  createDelivery: (body) => request('/api/deliveries', { method: 'POST', body }),
  lastCosts: () => request('/api/purchases/last-costs'),
  deletePurchase: (id) => request(`/api/purchases/${id}`, { method: 'DELETE' }),

  suppliers: () => request('/api/suppliers'),
  createSupplier: (body) => request('/api/suppliers', { method: 'POST', body }),
  updateSupplier: (id, body) => request(`/api/suppliers/${id}`, { method: 'PUT', body }),
  deleteSupplier: (id) => request(`/api/suppliers/${id}`, { method: 'DELETE' }),

  users: () => request('/api/users'),
  createUser: (body) => request('/api/users', { method: 'POST', body }),
  updateUser: (id, body) => request(`/api/users/${id}`, { method: 'PUT', body }),
  deleteUser: (id) => request(`/api/users/${id}`, { method: 'DELETE' }),

  pushKey: () => request('/api/push/key'),
  pushStatus: (endpoint) => request(`/api/push/status${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`),
  pushSubscribe: (body) => request('/api/push/subscribe', { method: 'POST', body }),
  pushUnsubscribe: (body) => request('/api/push/unsubscribe', { method: 'POST', body }),
  pushTest: (body) => request('/api/push/test', { method: 'POST', body }),
  removePushDevice: (id) => request(`/api/push/devices/${id}`, { method: 'DELETE' }),

  notifications: () => request('/api/notifications'),
  updateNotifications: (body) => request('/api/notifications', { method: 'PUT', body }),
  testNotification: () => request('/api/notifications/test', { method: 'POST' }),

  notices: (limit = 20) => request(`/api/notices?limit=${limit}`),
  markNoticesSeen: (lastId) => request('/api/notices/seen', { method: 'POST', body: { lastId } }),

  dataSummary: (from, to) => request(`/api/data/summary?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  eraseData: (body) => request('/api/data/erase', { method: 'POST', body }),

  saveStockCounts: (body) => request('/api/stock-counts', { method: 'POST', body }),
  pendingStockCounts: () => request('/api/stock-counts/pending'),
  reviewStockCounts: (body) => request('/api/stock-counts/review', { method: 'POST', body }),
  updateSettings: (body) => request('/api/settings', { method: 'PUT', body }),

  // ------------------------------------------------------------ maintenance --
  mxBootstrap: () => request('/api/mx/bootstrap'),
  mxIssues: (params = {}) => request(`/api/mx/issues?${new URLSearchParams(params)}`),
  mxCreateIssue: (body) => request('/api/mx/issues', { method: 'POST', body }),
  mxDeleteIssue: (id) => request(`/api/mx/issues/${id}`, { method: 'DELETE' }),

  mxPurchases: (from, to) => request(`/api/mx/purchases?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  mxLastCosts: () => request('/api/mx/purchases/last-costs'),
  mxCreateDelivery: (body) => request('/api/mx/deliveries', { method: 'POST', body }),
  mxDeletePurchase: (id) => request(`/api/mx/purchases/${id}`, { method: 'DELETE' }),

  mxStock: (asOf) => request(`/api/mx/stock${asOf ? `?asOf=${asOf}` : ''}`),
  mxSaveCounts: (body) => request('/api/mx/counts', { method: 'POST', body }),
  mxPendingCounts: () => request('/api/mx/counts/pending'),
  mxCountHistory: () => request('/api/mx/counts/history'),
  mxReviewCounts: (body) => request('/api/mx/counts/review', { method: 'POST', body }),

  mxOverview: () => request('/api/mx/overview'),
  mxReport: (from, to) => request(`/api/mx/report?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  mxCompare: (a, b) => request(`/api/mx/compare?${new URLSearchParams({
    aFrom: a.from, aTo: a.to, bFrom: b.from, bTo: b.to,
  })}`),
  mxAreaDetail: (id) => request(`/api/mx/areas/${id}/detail`),

  mxAreas: () => request('/api/mx/areas'),
  mxCreateArea: (body) => request('/api/mx/areas', { method: 'POST', body }),
  mxCreateAreaRange: (body) => request('/api/mx/areas/range', { method: 'POST', body }),
  mxUpdateArea: (id, body) => request(`/api/mx/areas/${id}`, { method: 'PUT', body }),
  mxDeleteArea: (id) => request(`/api/mx/areas/${id}`, { method: 'DELETE' }),

  mxCreateItem: (body) => request('/api/mx/items', { method: 'POST', body }),
  mxUpdateItem: (id, body) => request(`/api/mx/items/${id}`, { method: 'PUT', body }),
  mxDeleteItem: (id) => request(`/api/mx/items/${id}`, { method: 'DELETE' }),
  mxCreateCategory: (body) => request('/api/mx/categories', { method: 'POST', body }),
  mxPartsTemplateUrl: () => '/api/mx/items/template',
  mxImportParts: (body) => request('/api/mx/items/import', { method: 'POST', body }),
  mxRemoveItems: (ids) => request('/api/mx/items/remove', { method: 'POST', body: { ids } }),
  mxRemoveAreas: (ids) => request('/api/mx/areas/remove', { method: 'POST', body: { ids } }),

  // --------------------------------------------------------------- bakery --
  // The first two need no session: the token in the body is the whole gate.
  bakeryOpen: (token) => request('/api/bakery/open', { method: 'POST', body: { token } }),
  bakerySubmit: (body) => request('/api/bakery/submit', { method: 'POST', body }),

  bakeryForm: () => request('/api/bakery/form'),
  createProduction: (body) => request('/api/production', { method: 'POST', body }),
  productionLog: (from, to) => request(`/api/production?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  deleteProduction: (id) => request(`/api/production/${id}`, { method: 'DELETE' }),

  bakeryLinks: () => request('/api/bakery/links'),
  createBakeryLink: (label) => request('/api/bakery/links', { method: 'POST', body: { label } }),
  revokeBakeryLink: (id) => request(`/api/bakery/links/${id}`, { method: 'DELETE' }),

  // ----------------------------------------------------------- craft shop --
  shopBootstrap: () => request('/api/shop/bootstrap'),
  shopCreateSale: (body) => request('/api/shop/sales', { method: 'POST', body }),
  shopSales: ({ day, limit, mine } = {}) => request(`/api/shop/sales?${new URLSearchParams({
    ...(day ? { day } : {}), ...(limit ? { limit: String(limit) } : {}), ...(mine ? { mine: '1' } : {}),
  })}`),
  shopSale: (id) => request(`/api/shop/sales/${id}`),
  shopVoidSale: (id, reason) => request(`/api/shop/sales/${id}/void`, { method: 'POST', body: { reason } }),
  shopTill: (day) => request(`/api/shop/till${day ? `?day=${day}` : ''}`),

  shopPurchases: (from, to) => request(`/api/shop/purchases?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  shopLastCosts: () => request('/api/shop/purchases/last-costs'),
  shopCreateDelivery: (body) => request('/api/shop/deliveries', { method: 'POST', body }),
  shopDeletePurchase: (id) => request(`/api/shop/purchases/${id}`, { method: 'DELETE' }),

  shopStock: (asOf) => request(`/api/shop/stock${asOf ? `?asOf=${asOf}` : ''}`),
  shopSaveCounts: (body) => request('/api/shop/counts', { method: 'POST', body }),
  shopPendingCounts: () => request('/api/shop/counts/pending'),
  shopReviewCounts: (body) => request('/api/shop/counts/review', { method: 'POST', body }),

  shopOverview: () => request('/api/shop/overview'),
  shopReport: (from, to) => request(`/api/shop/report?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  shopCompare: (a, b) => request(`/api/shop/compare?${new URLSearchParams({
    aFrom: a.from, aTo: a.to, bFrom: b.from, bTo: b.to,
  })}`),
  shopExportUrl: (from, to) => `/api/shop/export?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`,

  shopCreateCategory: (body) => request('/api/shop/categories', { method: 'POST', body }),
  shopCreateItem: (body) => request('/api/shop/items', { method: 'POST', body }),
  shopUpdateItem: (id, body) => request(`/api/shop/items/${id}`, { method: 'PUT', body }),
  shopRemoveItems: (ids) => request('/api/shop/items/remove', { method: 'POST', body: { ids } }),
  shopUpdateSettings: (body) => request('/api/shop/settings', { method: 'PUT', body }),

  // ------------------------------------------------------ notifications --
  inbox: (limit) => request(`/api/inbox${limit ? `?limit=${limit}` : ''}`),
  markInboxRead: (ids) => request('/api/inbox/read', { method: 'POST', body: { ids: ids ?? null } }),

  // -------------------------------------------------- scheduled counts --
  mxStocktakes: () => request('/api/mx/stocktakes'),
  mxMyStocktakes: () => request('/api/mx/stocktakes/mine'),
  mxCreateStocktake: (body) => request('/api/mx/stocktakes', { method: 'POST', body }),
  mxUpdateStocktake: (id, body) => request(`/api/mx/stocktakes/${id}`, { method: 'PUT', body }),
  mxDeleteStocktake: (id) => request(`/api/mx/stocktakes/${id}`, { method: 'DELETE' }),
  mxRunStocktake: (id) => request(`/api/mx/stocktakes/${id}/run`, { method: 'POST', body: {} }),
  mxCancelStocktakeTask: (id) => request(`/api/mx/stocktake-tasks/${id}/cancel`, { method: 'POST', body: {} }),

  // ----------------------------------------------------------- housekeeping --
  hkBootstrap: (params = {}) => request(`/api/hk/bootstrap?${new URLSearchParams(params)}`),
  hkSaveChecks: (body) => request('/api/hk/checks', { method: 'POST', body }),
  hkSubmitRound: (day, slot, body = {}) =>
    request(`/api/hk/rounds/${day}/${slot}/submit`, { method: 'POST', body }),
  hkRounds: (limit = 30) => request(`/api/hk/rounds?limit=${limit}`),
  hkDay: (day, slot) => request(`/api/hk/day?${new URLSearchParams({
    ...(day ? { day } : {}), ...(slot ? { slot } : {}),
  })}`),

  hkOverview: () => request('/api/hk/overview'),
  hkReport: (from, to) => request(`/api/hk/report?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  hkRoom: (id, from, to) => request(`/api/hk/rooms/${id}/detail?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`),
  hkExportUrl: (from, to) => `/api/hk/export?${new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  })}`,

  hkRooms: () => request('/api/hk/rooms'),
  hkCreateRoom: (body) => request('/api/hk/rooms', { method: 'POST', body }),
  hkUpdateRoom: (id, body) => request(`/api/hk/rooms/${id}`, { method: 'PUT', body }),
  hkDeleteRoom: (id) => request(`/api/hk/rooms/${id}`, { method: 'DELETE' }),
  hkCreateBed: (body) => request('/api/hk/beds', { method: 'POST', body }),
  hkUpdateBed: (id, body) => request(`/api/hk/beds/${id}`, { method: 'PUT', body }),
  hkDeleteBed: (id) => request(`/api/hk/beds/${id}`, { method: 'DELETE' }),
  hkSaveRoster: (body) => request('/api/hk/roster', { method: 'POST', body }),
  hkUpdateSettings: (body) => request('/api/hk/settings', { method: 'PUT', body }),

  exportUrl: (type, from, to) =>
    `/api/export?${new URLSearchParams({ type, ...(from ? { from } : {}), ...(to ? { to } : {}) })}`,

  // -------------------------------------------------------- correspondence --
  coBootstrap: () => request('/api/co/bootstrap'),

  coLetters: (params = {}) => request(`/api/co/letters?${clean(params)}`),
  coLetter: (id) => request(`/api/co/letters/${id}`),
  coCreateLetter: (body) => request('/api/co/letters', { method: 'POST', body }),
  coUpdateLetter: (id, body) => request(`/api/co/letters/${id}`, { method: 'PUT', body }),
  coSetStatus: (id, body) => request(`/api/co/letters/${id}/status`, { method: 'POST', body }),
  coArchiveLetter: (id, archived) =>
    request(`/api/co/letters/${id}/archive`, { method: 'POST', body: { archived } }),
  coLinkLetter: (id, body) => request(`/api/co/letters/${id}/links`, { method: 'POST', body }),
  coExportUrl: (from, to) => `/api/co/export?${clean({ from, to })}`,

  coMine: () => request('/api/co/mine'),
  coRoute: (id, body) => request(`/api/co/letters/${id}/routes`, { method: 'POST', body }),
  coActOnRoute: (routeId, body) => request(`/api/co/routes/${routeId}/act`, { method: 'POST', body }),
  coCancelRoute: (routeId) => request(`/api/co/routes/${routeId}/cancel`, { method: 'POST', body: {} }),

  coSign: (id, body) => request(`/api/co/letters/${id}/sign`, { method: 'POST', body }),
  coVerify: (id) => request(`/api/co/letters/${id}/verify`),

  // Files go up as form data rather than JSON, so they skip `request` — see
  // `upload` below. Downloads are a plain link, because a link is what a
  // browser already knows how to open in a new tab.
  coUploadAttachment: (form) => upload('/api/co/attachments', form),
  coAttachmentUrl: (id) => `/api/co/attachments/${id}`,
  coDeleteAttachment: (id) => request(`/api/co/attachments/${id}`, { method: 'DELETE' }),

  coTemplates: () => request('/api/co/templates'),
  coRenderTemplate: (id, params = {}) => request(`/api/co/templates/${id}/render?${clean(params)}`),

  coParties: (params = {}) => request(`/api/co/parties?${clean(params)}`),
  coCreateParty: (body) => request('/api/co/parties', { method: 'POST', body }),
  coUpdateParty: (id, body) => request(`/api/co/parties/${id}`, { method: 'PUT', body }),

  coCases: (params = {}) => request(`/api/co/cases?${clean(params)}`),
  coCase: (id) => request(`/api/co/cases/${id}`),
  coCreateCase: (body) => request('/api/co/cases', { method: 'POST', body }),
  coUpdateCase: (id, body) => request(`/api/co/cases/${id}`, { method: 'PUT', body }),
  coCasesExportUrl: () => '/api/co/cases-export',

  coTasks: (params = {}) => request(`/api/co/tasks?${clean(params)}`),
  coCreateTask: (body) => request('/api/co/tasks', { method: 'POST', body }),
  coUpdateTask: (id, body) => request(`/api/co/tasks/${id}`, { method: 'PUT', body }),

  coMeetings: (params = {}) => request(`/api/co/meetings?${clean(params)}`),
  coMeeting: (id) => request(`/api/co/meetings/${id}`),
  coCreateMeeting: (body) => request('/api/co/meetings', { method: 'POST', body }),
  coUpdateMeeting: (id, body) => request(`/api/co/meetings/${id}`, { method: 'PUT', body }),
  coRecordMinutes: (id, body) => request(`/api/co/meetings/${id}/minutes`, { method: 'POST', body }),
  coMarkAttendance: (id, attendance) =>
    request(`/api/co/meetings/${id}/attendance`, { method: 'POST', body: { attendance } }),

  coOverview: () => request('/api/co/reports/overview'),
  coProductivity: (from, to) => request(`/api/co/reports/productivity?${clean({ from, to })}`),
  coDepartments: (from, to) => request(`/api/co/reports/departments?${clean({ from, to })}`),
  coActivity: (from, to) => request(`/api/co/reports/activity?${clean({ from, to })}`),
  coRetention: () => request('/api/co/reports/retention'),
  coTrailExportUrl: (from, to) => `/api/co/reports/trail-export?${clean({ from, to })}`,

  coSetup: () => request('/api/co/setup'),
  coUpdateSetup: (body) => request('/api/co/setup/settings', { method: 'PUT', body }),
  coCreateDepartment: (body) => request('/api/co/setup/departments', { method: 'POST', body }),
  coUpdateDepartment: (id, body) => request(`/api/co/setup/departments/${id}`, { method: 'PUT', body }),
  coCreateCoCategory: (body) => request('/api/co/setup/categories', { method: 'POST', body }),
  coUpdateCoCategory: (id, body) => request(`/api/co/setup/categories/${id}`, { method: 'PUT', body }),
  coCreateTemplate: (body) => request('/api/co/setup/templates', { method: 'POST', body }),
  coUpdateTemplate: (id, body) => request(`/api/co/setup/templates/${id}`, { method: 'PUT', body }),
  coDeleteTemplate: (id) => request(`/api/co/setup/templates/${id}`, { method: 'DELETE' }),
  coSaveWorkflow: (id, body) => (id
    ? request(`/api/co/setup/workflows/${id}`, { method: 'PUT', body })
    : request('/api/co/setup/workflows', { method: 'POST', body })),
  coDeleteWorkflow: (id) => request(`/api/co/setup/workflows/${id}`, { method: 'DELETE' }),
  coSaveStaff: (userId, body) => request(`/api/co/setup/staff/${userId}`, { method: 'PUT', body }),
  coSweepNow: () => request('/api/co/setup/sweep', { method: 'POST', body: {} }),
  coEmailTest: () => request('/api/co/setup/email-test', { method: 'POST', body: {} }),

  // ------------------------------------------------------------- envelopes --
  coEnvelopes: (letterId) => request(`/api/co/letters/${letterId}/envelopes`),
  coSendEnvelope: (letterId, body) =>
    request(`/api/co/letters/${letterId}/envelopes`, { method: 'POST', body }),
  coVoidEnvelope: (id, reason) =>
    request(`/api/co/envelopes/${id}/void`, { method: 'POST', body: { reason } }),
  coCertificate: (id) => request(`/api/co/envelopes/${id}/certificate`),
  coReissueLink: (recipientId, body = {}) =>
    request(`/api/co/envelope-recipients/${recipientId}/reissue`, { method: 'POST', body }),

  coMySignature: () => request('/api/co/my-signature'),
  coSaveMySignature: (body) => request('/api/co/my-signature', { method: 'PUT', body }),

  // The four a recipient uses. No session: the token in the body is the gate,
  // and it travels in a body rather than a URL so it stays out of server logs,
  // browser history and whatever sits in between.
  coSignOpen: (token, accessCode) =>
    request('/api/co/sign/open', { method: 'POST', body: { token, accessCode } }),
  coSignSubmit: (body) => request('/api/co/sign/submit', { method: 'POST', body }),
  coSignDecline: (body) => request('/api/co/sign/decline', { method: 'POST', body }),
  coSignFile: (body) => request('/api/co/sign/file', { method: 'POST', body }),
};

/** Query string from an object, dropping anything empty. */
function clean(params) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value == null || value === '' || value === false) continue;
    out.set(key, value === true ? '1' : String(value));
  }
  return out.toString();
}

/**
 * A multipart upload.
 *
 * Separate from `request` because that one sets a JSON content type, and
 * setting any content type at all on a FormData body breaks it: the browser has
 * to add the multipart boundary itself, and it will not do that if we have
 * already written the header.
 */
async function upload(path, form) {
  let response;
  try {
    response = await fetch(path, { method: 'POST', body: form, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'No connection to the server. The file has not been uploaded.');
  }
  if (response.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'Your session has expired. Sign in again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error || `Upload failed (${response.status})`);
  return data;
}

// --------------------------------------------------------------- offline --
// Day sheets are queued locally when a save fails, so a dropped connection in
// the kitchen never costs the morning's numbers.

const QUEUE_KEY = 'bf.pendingDays';

export function queueDay(day, payload) {
  const queue = readQueue();
  queue[day] = { payload, queuedAt: Date.now() };
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function dequeueDay(day) {
  const queue = readQueue();
  delete queue[day];
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

/** Push anything queued while offline. Returns the number of days synced. */
export async function flushQueue() {
  const queue = readQueue();
  const days = Object.keys(queue);
  if (!days.length) return 0;

  let synced = 0;
  for (const day of days) {
    try {
      await api.saveDay(day, queue[day].payload);
      dequeueDay(day);
      synced += 1;
    } catch (err) {
      if (err.status === 401) throw err;
      break; // still offline — keep the rest queued and try again later
    }
  }
  return synced;
}
