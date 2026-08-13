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

  // Housekeeping. Separate again, and for the same reason: the housekeeper who
  // walks the dorms every morning should be handed the bed check and nothing
  // else — not the roster she is checking against, and certainly not the costs.
  { key: 'hk_check', label: 'Bed check', detail: 'Walk the dorms and record each bed' },
  { key: 'hk_reports', label: 'Housekeeping reports', detail: 'Name tags, surprise occupancy, room by room' },
  { key: 'hk_setup', label: 'Housekeeping setup', detail: 'Dorm rooms, beds, and who is expected in them' },
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
    key: 'housekeeper',
    label: 'Housekeeper',
    detail: 'Walks the dorms and records the beds. Sees nothing else.',
    defaults: ['hk_check'],
  },
  {
    key: 'housekeeping_manager',
    label: 'Housekeeping manager',
    detail: 'Runs the bed check: the round, the reports, and the roster of who is expected where.',
    defaults: ['hk_check', 'hk_reports', 'hk_setup'],
  },
  {
    key: 'admin',
    label: 'Administrator',
    detail: 'Everything, including managing people and settings.',
    defaults: PERMISSION_KEYS,
  },
];

const ROLE_MAP = new Map(ROLES.map((r) => [r.key, r]));

/**
 * What a given site is allowed to hand out.
 *
 * On a housekeeping-only deployment, offering somebody "Daily entry" or
 * "Maintenance purchases" would be offering them a screen that does not exist
 * there. So the People form is given the housekeeping permissions and the roles
 * built from them, and nothing else.
 *
 * Administrator is kept everywhere: it is the role that can manage people, and
 * a site with no way to appoint one is a site nobody can look after.
 */
const HOUSEKEEPING_KEYS = ['hk_check', 'hk_reports', 'hk_setup'];

export function permissionsFor(site) {
  if (site !== 'housekeeping') return PERMISSIONS;
  return PERMISSIONS.filter((p) => HOUSEKEEPING_KEYS.includes(p.key));
}

export function rolesFor(site) {
  if (site !== 'housekeeping') return ROLES;
  return ROLES
    .filter((r) => r.key === 'admin' || r.defaults.some((d) => HOUSEKEEPING_KEYS.includes(d)))
    .map((role) => ({
      ...role,
      // An administrator here administers this site, so their defaults are this
      // site's sections rather than every section in the codebase.
      defaults: role.key === 'admin'
        ? [...HOUSEKEEPING_KEYS, 'users']
        : role.defaults.filter((d) => HOUSEKEEPING_KEYS.includes(d)),
    }));
}

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
