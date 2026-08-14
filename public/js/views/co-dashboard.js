import { api } from '../api.js';
import { navigate } from '../app.js';
import { h, mount } from '../util.js';
import { barChart } from '../charts.js';
import { card, exportButton, statTile, table } from './components.js';
import { STATUS_LABEL, TYPE_LABEL, fmtDate, statusPill } from './co-common.js';

/**
 * The dashboard.
 *
 * Written to be read standing up. The four tiles across the top are the ones a
 * partner asks about walking past somebody's desk — what is late, what is
 * coming, how long things are taking — and everything below is the detail
 * behind one of them.
 *
 * Turnaround is measured from registration to close, over letters that actually
 * closed. Averaging in the ones still open would make a growing backlog look
 * like fast work, which is exactly the wrong way round.
 */
export async function renderCoDashboard() {
  const data = await api.coOverview();
  const host = h('div');

  const totalOpen = Object.entries(data.statuses)
    .filter(([status]) => !['closed', 'cancelled'].includes(status))
    .reduce((n, [, count]) => n + count, 0);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Overview'),
        h('div.sub', 'The register, the deadlines and who is carrying what'),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => navigate('co-reports') }, 'Productivity'),
        exportButton(api.coExportUrl(), 'Export register'),
      ),
    ),

    h('div.grid.grid-4',
      statTile({
        label: 'Open in the register',
        value: String(totalOpen),
        sub: `${data.openRoutes} item${data.openRoutes === 1 ? '' : 's'} with somebody`,
      }),
      statTile({
        label: 'Past its deadline',
        value: String(data.overdue),
        accent: data.overdue ? 'var(--bad)' : null,
        sub: data.overdue ? 'these are late now' : 'nothing is late',
      }),
      statTile({
        label: 'Due within a week',
        value: String(data.dueSoon),
        sub: data.unclaimed ? `${data.unclaimed} nobody has picked up` : 'all claimed',
      }),
      statTile({
        label: 'Average turnaround',
        value: data.turnaround.averageDays == null ? '—' : `${data.turnaround.averageDays} days`,
        sub: data.turnaround.closed
          ? `over ${data.turnaround.closed} closed, worst ${data.turnaround.worstDays} days`
          : 'nothing closed yet',
      }),
    ),

    data.unclaimed
      ? h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', `${data.unclaimed} sent to a department with nobody's name on it`),
          h('div.alert-detail',
            'A pool route belongs to whoever picks it up first. Until somebody does, it belongs '
            + 'to everybody — which in practice means nobody.'),
        ))
      : null,

    h('div.grid.grid-2',
      card('By kind', {},
        table([
          { key: 'type', label: 'Kind', format: (v) => TYPE_LABEL[v] ?? v },
          { key: 'open', label: 'Open', align: 'right' },
          { key: 'n', label: 'All time', align: 'right' },
        ], data.types, { empty: 'Nothing registered yet.' })),

      card('By status', {},
        table([
          { key: 'status', label: 'Status', format: (v) => statusPill(v) },
          { key: 'n', label: '', align: 'right' },
        ], Object.entries(data.statuses).map(([status, n]) => ({ status, n }))
          .sort((a, b) => b.n - a.n), { empty: 'Nothing registered yet.' })),
    ),

    card('Volume over the last year', { wide: true },
      data.monthly.length ? monthlyChart(data.monthly) : h('p.muted', 'Not enough history yet.')),

    h('div.grid.grid-2',
      card('Departments', { note: 'What each is holding right now' },
        table([
          { key: 'name', label: 'Department' },
          { key: 'open_routes', label: 'Open', align: 'right' },
          {
            key: 'overdue',
            label: 'Late',
            align: 'right',
            format: (n) => (n ? h('span.pill.bad', String(n)) : h('span.muted', '0')),
          },
        ], data.departments, { empty: 'No departments set up.' })),

      card('Action points', {
        actions: h('button.btn-sm', { onclick: () => navigate('co-tasks') }, 'Open them'),
      },
        h('div.grid.grid-2', { style: { gap: '.6rem' } },
          statTile({ label: 'Open', value: String(data.actionPoints.open) }),
          statTile({
            label: 'Progress',
            value: data.actionPoints.progress == null ? '—' : `${data.actionPoints.progress}%`,
            sub: `${data.actionPoints.done} completed`,
          }),
        ),
        h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'Cancelled points are left out of both halves. They were never work, and counting them '
          + 'as done flatters the figure.')),
    ),

    card('Statutory deadlines', {
      wide: true,
      note: 'The ones that carry a penalty',
      actions: h('button.btn-sm', { onclick: () => navigate('co-cases') }, 'All engagements'),
    }, table([
      { key: 'ref', label: 'Reference', format: (ref, r) => h('a', { href: `#/co-case?id=${r.id}` }, ref) },
      {
        key: 'title',
        label: 'Engagement',
        format: (title, r) => h('div', h('div', title), h('small.muted', r.party_name ?? 'no client')),
      },
      { key: 'statutory_due', label: 'Due', format: (v) => fmtDate(v) },
      {
        key: 'days_left',
        label: 'Runway',
        align: 'right',
        format: (days) => {
          const n = Math.round(Number(days));
          if (Number.isNaN(n)) return h('span.muted', '—');
          if (n < 0) return h('span.pill.bad', `${Math.abs(n)} days past`);
          if (n <= 14) return h('span.pill.warn', `${n} days`);
          return h('span', `${n} days`);
        },
      },
      { key: 'status', label: 'Status', format: (v) => h('span.pill', v) },
    ], data.deadlines, { empty: 'No engagement has a statutory deadline recorded.' })),

    data.upcomingMeetings.length
      ? card('Coming up', {
        wide: true,
        actions: h('button.btn-sm', { onclick: () => navigate('co-meetings') }, 'The diary'),
      }, table([
        { key: 'title', label: 'Meeting' },
        { key: 'starts_at', label: 'When', format: (v) => new Date(v).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) },
        { key: 'location', label: 'Where', format: (v) => v ?? h('span.muted', '—') },
      ], data.upcomingMeetings))
      : null,
  );

  return host;
}

/**
 * Registered per month, incoming against outgoing.
 *
 * Two series on one axis because the useful reading is the gap between them: a
 * month where forty letters came in and six went out is a month the firm fell
 * behind, and two separate charts hide exactly that.
 */
function monthlyChart(rows) {
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const countOf = (month, type) => rows.find((r) => r.month === month && r.type === type)?.n ?? 0;

  const summary = months.map((month) => ({
    label: month,
    incoming: countOf(month, 'incoming'),
    outgoing: countOf(month, 'outgoing'),
    internal: countOf(month, 'memo') + countOf(month, 'circular'),
    value: rows.filter((r) => r.month === month).reduce((n, r) => n + r.n, 0),
  }));

  return h('div',
    barChart({
      height: 200,
      format: (v) => String(Math.round(v)),
      groups: summary.map((m) => ({
        label: m.label.slice(2),
        values: [
          { name: 'In', value: m.incoming },
          { name: 'Out', value: m.outgoing },
          { name: 'Internal', value: m.internal },
        ],
      })),
    }),
    table([
      { key: 'label', label: 'Month' },
      { key: 'incoming', label: 'In', align: 'right' },
      { key: 'outgoing', label: 'Out', align: 'right' },
      { key: 'internal', label: 'Internal', align: 'right' },
      { key: 'value', label: 'All', align: 'right' },
    ], summary),
  );
}

/**
 * Productivity, per person and per department.
 *
 * On its own page, and hedged on the page itself, because the numbers are
 * easily misread. "Average hours to complete" is the time from a route opening
 * to it closing — not a measure of effort, and not comparable between somebody
 * reviewing engagement letters and somebody answering Revenue queries. It is
 * here so a partner asking "is anything stuck with anyone" has somewhere to
 * look.
 */
export async function renderCoReports(params) {
  const from = params.from ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const to = params.to ?? new Date().toISOString().slice(0, 10);

  const [people, departments, activity] = await Promise.all([
    api.coProductivity(from, to),
    api.coDepartments(from, to),
    api.coActivity(from, to),
  ]);

  const host = h('div');
  const fromInput = h('input', { type: 'date', value: from });
  const toInput = h('input', { type: 'date', value: to });
  const apply = () => navigate('co-reports', { from: fromInput.value, to: toInput.value });

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Productivity and activity'),
        h('div.sub', `${fmtDate(from)} to ${fmtDate(to)}`),
      ),
      h('div.toolbar',
        fromInput, toInput,
        h('button.btn-sm.btn-primary', { onclick: apply }, 'Apply'),
        exportButton(api.coTrailExportUrl(from, to), 'Audit trail'),
      ),
    ),

    h('div.grid.grid-4',
      statTile({ label: 'Registered', value: String(activity.summary.registered) }),
      statTile({
        label: 'Closed',
        value: String(activity.summary.closed),
        sub: activity.summary.closureRate == null ? null : `${activity.summary.closureRate}% of what came in`,
      }),
      statTile({
        label: 'Still overdue',
        value: String(activity.summary.overdue),
        accent: activity.summary.overdue ? 'var(--bad)' : null,
      }),
      statTile({
        label: 'Average to close',
        value: activity.summary.averageDays == null ? '—' : `${activity.summary.averageDays} days`,
      }),
    ),

    card('People', {
      wide: true,
      note: 'Received and completed inside the window; open and overdue are as of now',
    }, table([
      {
        key: 'name',
        label: 'Person',
        format: (name, r) => h('div', h('div', name), h('small.muted', r.department ?? r.role)),
      },
      { key: 'registered', label: 'Registered', align: 'right' },
      { key: 'received', label: 'Sent to them', align: 'right' },
      { key: 'completed', label: 'Completed', align: 'right' },
      {
        key: 'clearance',
        label: 'Clearance',
        align: 'right',
        format: (pct) => {
          if (pct == null) return h('span.muted', '—');
          const cls = pct >= 100 ? 'good' : pct >= 80 ? '' : 'warn';
          return h(`span.pill${cls ? `.${cls}` : ''}`, `${pct}%`);
        },
      },
      {
        key: 'averageHours',
        label: 'Avg hours',
        align: 'right',
        format: (v) => (v == null ? h('span.muted', '—') : String(v)),
      },
      { key: 'openNow', label: 'Open now', align: 'right' },
      {
        key: 'overdueNow',
        label: 'Late now',
        align: 'right',
        format: (n) => (n ? h('span.pill.bad', String(n)) : h('span.muted', '0')),
      },
      {
        key: 'escalated',
        label: 'Escalated',
        align: 'right',
        format: (n) => (n ? h('span.pill.warn', String(n)) : h('span.muted', '0')),
      },
      { key: 'tasksDone', label: 'Points done', align: 'right' },
      { key: 'hours', label: 'Hours', align: 'right', format: (v) => (Number(v) || 0).toFixed(1) },
    ], people.people, { empty: 'Nobody has an account yet.' })),

    h('p.muted', { style: { fontSize: '.82rem' } },
      'Clearance is completed against received in the same window. Above 100% means somebody cleared '
      + 'a backlog; below means one is building. It is a direction, not a grade — a person handling '
      + 'four Revenue enquiries is not slower than one acknowledging forty circulars.'),

    card('Departments', { wide: true }, table([
      { key: 'name', label: 'Department' },
      { key: 'head', label: 'Head', format: (v) => v ?? h('span.muted', 'nobody set') },
      { key: 'letters', label: 'Letters', align: 'right' },
      { key: 'routed', label: 'Routed to it', align: 'right' },
      { key: 'open_now', label: 'Open now', align: 'right' },
      {
        key: 'overdue_now',
        label: 'Late now',
        align: 'right',
        format: (n) => (n ? h('span.pill.bad', String(n)) : h('span.muted', '0')),
      },
      {
        key: 'avg_hours',
        label: 'Avg hours',
        align: 'right',
        format: (v) => (v == null ? h('span.muted', '—') : String(v)),
      },
    ], departments.departments, { empty: 'No departments set up.' })),

    h('div.grid.grid-2',
      card('Busiest clients', {}, table([
        { key: 'name', label: 'Client', format: (name, r) => h('a', { href: `#/co-register?party=${r.id}&status=all` }, name) },
        { key: 'incoming', label: 'In', align: 'right' },
        { key: 'outgoing', label: 'Out', align: 'right' },
        { key: 'n', label: 'All', align: 'right' },
      ], activity.parties, { empty: 'No correspondence in this window.' })),

      card('By category', {}, table([
        { key: 'name', label: 'Category' },
        { key: 'n', label: '', align: 'right' },
      ], activity.categories, { empty: 'No correspondence in this window.' })),
    ),

    card('How it arrived', { wide: true }, table([
      { key: 'channel', label: 'Channel' },
      { key: 'n', label: '', align: 'right' },
    ], activity.channels, { empty: 'Nothing recorded.' })),

    h('p.muted', { style: { fontSize: '.82rem' } },
      `Statuses in the register: ${Object.values(STATUS_LABEL).join(', ')}.`),
  );

  return host;
}
