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
  { key: 'bakery', label: 'Bakery', detail: 'Report bread produced, which puts it into stock' },
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

  // Housekeeping. Separate again, and for the same reason: the housekeeper who
  // walks the dorms every morning should be handed the bed check and nothing
  // else — not the roster she is checking against, and certainly not the costs.
  { key: 'hk_check', label: 'Bed check', detail: 'Walk the dorms and record each bed' },
  { key: 'hk_reports', label: 'Housekeeping reports', detail: 'Name tags, surprise occupancy, room by room' },
  // Deliberately narrower than setup. The front desk knows who is booked into
  // which bed tonight; that is no reason to let them rename a dorm or delete
  // one, and a permission that bundles the two would force the choice.
  { key: 'hk_roster', label: 'The roster', detail: 'Set who is expected in each bed tonight' },
  { key: 'hk_setup', label: 'Housekeeping setup', detail: 'Dorm rooms and beds — and the roster with them' },
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
    // Including the bakery form: a manager covering for the baker on a quiet
    // Sunday should not need their own access changed to record a bake.
    defaults: ['entry', 'reports', 'stock', 'purchases', 'approvals', 'bakery'],
  },
  {
    key: 'baker',
    label: 'Baker',
    detail: 'Reports what came out of the oven. Sees no costs and no other screen.',
    defaults: ['bakery'],
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
    key: 'receptionist',
    label: 'Receptionist',
    detail: 'Records the morning and evening bed checks from the desk. Sees nothing else.',
    defaults: ['hk_check'],
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
    defaults: ['hk_check', 'hk_reports', 'hk_roster', 'hk_setup'],
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
const HOUSEKEEPING_KEYS = ['hk_check', 'hk_reports', 'hk_roster', 'hk_setup'];

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
  // Anybody who can build the dorms can say who is expected in them: the roster
  // sits on the same screen, and a setup holder who could not touch it would be
  // looking at a control that refused them.
  if (list.includes('hk_setup') && !list.includes('hk_roster')) list.push('hk_roster');
  return list;
}

export function can(user, permission) {
  if (!permission) return true;
  return effectivePermissions(user).includes(permission);
}

/**
 * Does a signed-in person's list satisfy what a route asks for?
 *
 * A route may name a list instead of a single permission, and a list means
 * "any one of these". The roster is the case that needed it: it is reachable
 * both by the person who maintains the dorms and by the front desk who only
 * fills it in, and collapsing those into one permission would mean handing the
 * front desk the power to delete a dorm.
 *
 * `null` — a route with nothing to check — lets anybody signed in through.
 */
export function allows(required, held = []) {
  if (!required) return true;
  const needed = Array.isArray(required) ? required : [required];
  if (!needed.length) return true;
  return needed.some((p) => held.includes(p));
}
