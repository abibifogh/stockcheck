// What a person is allowed to reach.
//
// Permissions are checked on the server for every request. The menu hides what
// you cannot use, but hiding is a courtesy — the gate is the API.

export const PERMISSIONS = [
  { key: 'entry', label: 'Daily entry', detail: 'Record guest counts and ingredient usage' },
  { key: 'reports', label: 'Reports', detail: 'Day, week and month analysis, including costs' },
  { key: 'stock', label: 'Stock', detail: 'Stock levels, reorder list, physical counts' },
  { key: 'purchases', label: 'Purchases', detail: 'Record deliveries and see what was paid' },
  { key: 'approvals', label: 'Approvals', detail: 'Accept or reject changes to days already submitted' },
  { key: 'setup', label: 'Setup', detail: 'Ingredients, categories and property settings' },
  { key: 'users', label: 'Users & data', detail: 'Manage people, notifications, locks and erase data' },

  // Maintenance stores. Kept separate from the kitchen permissions so a
  // technician can be given the issue screen and nothing else, and a cook is
  // never handed the parts store by accident.
  { key: 'mx_issue', label: 'Issue parts', detail: 'Record parts released to a room or area' },
  { key: 'mx_reports', label: 'Maintenance reports', detail: 'What each room and area is costing' },
  { key: 'mx_stock', label: 'Maintenance stock', detail: 'Parts on hand, restock list, physical counts' },
  { key: 'mx_purchases', label: 'Maintenance purchases', detail: 'Record parts bought, with cost' },
  { key: 'mx_setup', label: 'Maintenance setup', detail: 'The parts list, and the rooms and areas' },

  // The craft shop. Its own keys again, so somebody hired to stand behind the
  // till gets the till and nothing else — not the kitchen, not the parts store,
  // and not the shop's own cost prices.
  { key: 'shop_sell', label: 'Craft shop till', detail: 'Ring up sales and take payment' },
  { key: 'shop_reports', label: 'Craft shop reports', detail: 'Takings, best sellers and margin' },
  { key: 'shop_stock', label: 'Craft shop stock', detail: 'What is on the shelf, restock list, counts' },
  { key: 'shop_purchases', label: 'Craft shop buying', detail: 'Record stock bought in, with cost' },
  { key: 'shop_setup', label: 'Craft shop setup', detail: 'The product list and its prices' },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

export const ROLES = [
  {
    key: 'cook',
    label: 'Cook',
    detail: 'Records the morning sheet. Sees no costs at all.',
    defaults: ['entry'],
  },
  {
    key: 'manager',
    label: 'Manager',
    detail: 'Records and reviews. Sees costs, stock and purchases, and approves changes.',
    defaults: ['entry', 'reports', 'stock', 'purchases', 'approvals'],
  },
  {
    key: 'technician',
    label: 'Technician',
    detail: 'Issues parts to rooms. Sees no costs at all.',
    defaults: ['mx_issue'],
  },
  {
    key: 'maintenance_manager',
    label: 'Maintenance manager',
    detail: 'Runs the parts store: issues, stock, purchases and the room-by-room analysis.',
    defaults: ['mx_issue', 'mx_reports', 'mx_stock', 'mx_purchases', 'mx_setup'],
  },
  {
    key: 'shop_assistant',
    label: 'Shop assistant',
    detail: 'Works the craft shop till. Sees selling prices, never what anything cost you.',
    defaults: ['shop_sell'],
  },
  {
    key: 'shop_manager',
    label: 'Shop manager',
    detail: 'Runs the craft shop: the till, the stock, the buying and the takings.',
    defaults: ['shop_sell', 'shop_reports', 'shop_stock', 'shop_purchases', 'shop_setup'],
  },
  {
    key: 'admin',
    label: 'Administrator',
    detail: 'Everything, including managing people and settings.',
    defaults: PERMISSION_KEYS,
  },
];

const ROLE_MAP = new Map(ROLES.map((r) => [r.key, r]));

export function isRole(value) {
  return ROLE_MAP.has(value);
}

export function defaultPermissions(role) {
  return [...(ROLE_MAP.get(role)?.defaults ?? ['entry'])];
}

/**
 * Resolve a user's effective permissions. A stored list overrides the role
 * defaults, which is how "what they see" is customised per person.
 *
 * Admins always keep `users`; otherwise the last administrator could edit
 * themselves out of the only screen that can undo it.
 */
export function effectivePermissions(user) {
  if (!user) return [];
  let list = defaultPermissions(user.role);

  if (user.permissions) {
    try {
      const parsed = typeof user.permissions === 'string'
        ? JSON.parse(user.permissions)
        : user.permissions;
      if (Array.isArray(parsed)) {
        list = parsed.filter((p) => PERMISSION_KEYS.includes(p));
      }
    } catch {
      // A malformed override falls back to the role defaults rather than
      // locking the person out of everything.
    }
  }

  if (user.role === 'admin' && !list.includes('users')) list.push('users');
  return list;
}

export function can(user, permission) {
  if (!permission) return true;
  return effectivePermissions(user).includes(permission);
}
