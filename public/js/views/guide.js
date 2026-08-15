import { can, state } from '../app.js';
import { BRAND } from '../brand.js';
import { h, mount } from '../util.js';

/**
 * The user guide, written for the people who actually use this: cooks with wet
 * hands and a manager who wants to know why last week cost more.
 *
 * It adapts to the reader. There is no point telling a cook how to close an
 * accounting period, and a page full of sections you cannot open is a page
 * nobody reads twice. Everything here is filtered by what you can actually do.
 */
export async function renderGuide() {
  const sections = SECTIONS.filter((s) => onThisSite(s.id) && (!s.permission || can(s.permission)));

  // Each contents entry is paired with its section, so the list can follow
  // the reader down the page.
  const pairs = sections.map((s) => {
    const el = h('section.card.guide-section', { id: `guide-${s.id}` },
      h('h2', s.title),
      s.lead ? h('p.guide-lead', s.lead) : null,
      s.render(),
    );
    const link = h('a', {
      href: '#/guide',
      onclick: (event) => {
        event.preventDefault();
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }, s.title);
    return { link, el };
  });

  const contents = h('nav.guide-toc',
    h('div.stat-label', { style: { marginBottom: '.5rem' } }, 'On this page'),
    pairs.map((p) => p.link),
  );

  followReading(contents, pairs);

  return h('div',
    h('div.page-head',
      h('div',
        h('h1', 'How to use this'),
        h('div.sub', greeting()),
      ),
      h('button.btn-sm', { onclick: () => window.print() }, '🖨 Print this guide'),
    ),
    h('div.guide-layout', contents, h('div', pairs.map((p) => p.el))),
  );
}

/** Just below the sticky header, which is where the eye actually reads. */
function bandTop() {
  return (document.querySelector('.topbar')?.getBoundingClientRect().height ?? 58) + 22;
}

/**
 * Mark whichever section is being read.
 *
 * This guide is long, and a contents list that does not say where you already
 * are is only half a map. The active entry is the topmost section crossing a
 * band just under the header — which is where the eye is when reading, rather
 * than the middle of the screen.
 */
function followReading(toc, pairs) {
  if (!pairs.length || typeof IntersectionObserver !== 'function') return;

  const onScreen = new Set();
  let active = null;

  const highlight = (el) => {
    if (el === active) return;
    active = el;
    for (const p of pairs) p.link.classList.toggle('active', p.el === el);
    const link = pairs.find((p) => p.el === el)?.link;
    if (link) keepInView(toc, link);
  };

  /**
   * Once the page can scroll no further the band stops moving, so the last
   * section or two would never light up. There we fall back to whichever
   * section actually fills most of the screen, which is the honest answer when
   * the reader can see the end of the document.
   */
  const largestOnScreen = () => {
    const top = bandTop();
    let best = null;
    let bestArea = 0;
    for (const p of pairs) {
      const box = p.el.getBoundingClientRect();
      const area = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, top);
      if (area > bestArea) { bestArea = area; best = p.el; }
    }
    return best;
  };

  // One decision, made in one place, so the observer and the scroll handler
  // cannot fight over the answer.
  const update = () => {
    const atBottom = window.innerHeight + window.scrollY
      >= document.documentElement.scrollHeight - 2;
    if (atBottom) return highlight(largestOnScreen() ?? pairs[pairs.length - 1].el);
    // Between two sections nothing is in the band; leaving the last one lit is
    // better than blanking the list.
    if (!onScreen.size) return;
    return highlight(pairs.find((p) => onScreen.has(p.el))?.el);
  };

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) onScreen.add(entry.target);
      else onScreen.delete(entry.target);
    }
    update();
  }, { rootMargin: `-${Math.round(bandTop())}px 0px -60% 0px` });

  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  };

  // Built before it is mounted, so wait a frame for the sections to be on the
  // page and stop once they leave it again.
  requestAnimationFrame(() => {
    if (!pairs[0].el.isConnected) return;
    highlight(pairs[0].el);
    for (const p of pairs) observer.observe(p.el);
    window.addEventListener('scroll', onScroll, { passive: true });

    const watcher = new MutationObserver(() => {
      if (pairs[0].el.isConnected) return;
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      watcher.disconnect();
    });
    watcher.observe(document.body, { childList: true, subtree: true });
  });
}

/** Scroll the contents list itself, never the page, to reveal the active entry. */
function keepInView(toc, link) {
  const box = toc.getBoundingClientRect();
  const item = link.getBoundingClientRect();
  if (item.top < box.top) toc.scrollTop -= box.top - item.top + 8;
  else if (item.bottom > box.bottom) toc.scrollTop += item.bottom - box.bottom + 8;
}

/**
 * The sections a housekeeping-only site keeps.
 *
 * Everything else in this guide explains the breakfast unit or the parts store,
 * and on that site they do not exist. Filtering by permission is not enough:
 * an administrator holds every permission, and would otherwise be handed a
 * manual for two systems they cannot open.
 */
const HOUSEKEEPING_SECTIONS = new Set([
  'hk-check', 'hk-roster', 'hk-reports', 'hk-setup', 'account', 'people', 'problems',
]);

function onThisSite(id) {
  return BRAND.app !== 'housekeeping' || HOUSEKEEPING_SECTIONS.has(id);
}

function greeting() {
  if (can('users')) return 'Everything, including setting the system up and looking after it';
  if (can('reports')) return 'Recording the morning, and reading what it tells you';
  // Somebody who only walks the dorms should not be greeted with a page about
  // the kitchen.
  if (can('hk_check') && !can('entry')) {
    if (can('hk_reports')) return 'Walking the dorms, and reading what the checks tell you';
    return can('hk_roster')
      ? 'Checking the beds, and keeping the roster of who is expected in them'
      : 'Walking the dorms and checking the beds — that is all you need';
  }
  if (can('hk_roster') && !can('hk_check') && !can('entry')) {
    return 'Keeping the roster of who is expected in which bed';
  }
  return 'Recording the morning — that is all you need';
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

const steps = (...items) => h('ol.guide-steps', items.map((i) => h('li', i)));

/**
 * One panel of a report, explained: what it is called on screen, what it is
 * actually telling you, and what to do about it. The third column is the one
 * that matters — a number nobody acts on is decoration.
 */
function readings(...rows) {
  return h('div.guide-readings', rows.map(([name, means, action]) => h('div.guide-reading',
    h('div.guide-reading-name', name),
    h('div.guide-reading-means', means),
    h('div.guide-reading-action', h('strong', 'What to do: '), action),
  )));
}
const points = (...items) => h('ul.guide-points', items.map((i) => h('li', i)));
const note = (title, text) => h('div.guide-note', h('strong', title), ' ', text);
const warn = (title, text) => h('div.guide-note.warn', h('strong', title), ' ', text);

function faq(...pairs) {
  return h('div.guide-faq', pairs.map(([q, a]) => h('details',
    h('summary', q),
    h('div.guide-answer', a),
  )));
}

// ---------------------------------------------------------------------------
// The guide itself
// ---------------------------------------------------------------------------

const SECTIONS = [
  {
    id: 'morning',
    title: 'Every morning',
    permission: 'entry',
    lead: 'This is the whole job. It should take a minute or two once you are used to it.',
    render: () => h('div',
      steps(
        h('span', h('strong', 'Count the guests.'), ' In-house guests and outside guests are counted '
          + 'separately, because outside guests pay. The fee is set by your manager and you cannot change it.'),
        h('span', h('strong', 'Tap ⚡ Fill usual.'), ' This fills in what is normally used for that many '
          + 'guests, worked out from your own past mornings. If the button is not there, your manager '
          + 'has turned it off and you enter each item yourself.'),
        h('span', h('strong', 'Correct anything that was different.'), ' This is the important part. The '
          + 'suggestion is only a starting point — it does not know that today you ran out of bread or '
          + 'that a coach party arrived.'),
        h('span', h('strong', 'Enter 0 where nothing was used.'), ' A zero is a real answer. Leaving a box '
          + 'empty is not, and the system will not let you submit until every everyday item has a number.'),
        h('span', h('strong', 'Tap Submit day.'), ' You will be asked to confirm anything recorded as zero. '
          + 'Read that list — it is the last chance to catch a box you meant to fill.'),
      ),
      note('The number under each item', 'is what that item usually takes for today’s headcount. '
        + 'Tap it to accept it. It is a faint, slanted number until you enter something real.'),
      note('You can save without submitting.', 'Tap Save to come back to it later. Nothing is counted '
        + 'in the reports until you submit.'),
      warn('If the internet drops', 'keep working. Your entries are kept on the tablet and sent as soon '
        + 'as you are back online. You will see “Saved on this device”.'),
    ),
  },

  {
    id: 'fixing',
    title: 'Fixing a mistake',
    permission: 'entry',
    render: () => h('div',
      h('p', 'It depends on whether the day has been submitted yet.'),
      points(
        h('span', h('strong', 'Not submitted yet:'), ' just change it and submit as usual.'),
        h('span', h('strong', 'Already submitted:'), ' change it and submit again. Your correction does '
          + 'not overwrite anything — it is sent to a manager, who sees exactly what would change and '
          + 'accepts or rejects it. Until they accept it, the original figures stand.'),
        h('span', h('strong', 'An older day:'), ' use the date arrows at the top to go back. If the day '
          + 'is in a closed period you will see a padlock message, and an administrator has to reopen it.'),
      ),
      note('Why the extra step?', 'Once a day has been reported on, its numbers should not change quietly. '
        + 'You are usually right — but “usually” is not enough once someone has acted on the figures.'),
    ),
  },

  {
    id: 'account',
    title: 'Your PIN and your account',
    render: () => h('div',
      points(
        can('users') || state.role === 'admin'
          ? h('span', h('strong', 'Administrators'), ' sign in with an email address and a password.')
          : h('span', h('strong', 'You sign in with your own PIN.'), ' Nobody else has the same one, '
            + 'which is how the system records who entered each morning.'),
        h('span', h('strong', 'Change it yourself'), ' from ', h('em', 'My account'), ' at the top of the '
          + 'screen. You need your current one first, so a tablet left signed in cannot be used to lock '
          + 'you out.'),
        h('span', h('strong', 'Add it to your home screen.'), ' On the tablet or phone, tap Share, then '
          + '“Add to Home Screen”. It then opens like a normal app.'),
      ),
      warn('Do not share a PIN.', 'If two people use one PIN, the day sheets stop telling you who '
        + 'recorded what — and that is the first thing you will want to know when a number looks wrong.'),
    ),
  },

  {
    id: 'reports',
    title: 'Reading the reports',
    permission: 'reports',
    lead: 'Five views, each answering a different question — and the handful of rules all five obey.',
    render: () => h('div',
      h('h3', 'The five screens'),
      points(
        h('span', h('strong', 'Overview —'), ' where things stand right now, and anything that needs a '
          + 'decision today. Start here.'),
        h('span', h('strong', 'Day —'), ' what one morning cost, and which items pushed it up or down. '
          + 'It compares against a normal day ', h('em', 'of the same weekday'), ', because Sundays are '
          + 'not Tuesdays.'),
        h('span', h('strong', 'Week —'), ' this week against last, which items moved, and which are being '
          + 'portioned inconsistently.'),
        h('span', h('strong', 'Month —'), ' the full picture: cost per guest over time, where the money '
          + 'goes by category, whether the outsider fee covers itself, and what the store did.'),
        h('span', h('strong', 'Compare —'), ' any two periods you choose, side by side. The four screens '
          + 'above always compare against the period immediately before; this one lets you pick both '
          + 'sides yourself.'),
      ),

      h('h3', { style: { marginTop: '1.2rem' } }, 'The one number to watch'),
      h('p', h('strong', 'Cost per guest.'), ' Total food cost divided by everyone who ate. It is the only '
        + 'figure that is fair to compare across days, because it does not care whether the hotel was '
        + 'full or empty. A busy Saturday costing more than a quiet Tuesday is not a problem; a busy '
        + 'Saturday costing more ', h('em', 'per guest'), ' than usual is worth a look.'),

      // The mechanics belong here rather than in a section of their own: they
      // are the reason the figures above mean what they mean, and nobody goes
      // looking for them until a number surprises them.
      h('h3', { style: { marginTop: '1.2rem' } }, 'Where the numbers come from'),
      h('p.guide-lead', 'Worth reading once. These few rules decide what everything above actually means.'),
      points(
        h('span', h('strong', 'Costs use a running average price.'), ' Each delivery blends into the '
          + 'average cost of what is already in the store. A day is costed at the price in force '
          + 'that day, so a price rise shows up when it actually happened.'),
        h('span', h('strong', '“Expected” is learned from you,'), ' not from a recipe book. It is the '
          + 'middle value of the last 28 service days, per guest, scaled to today’s headcount. The middle '
          + 'value rather than the average, so one blow-out morning does not move the yardstick.'),
        h('span', h('strong', 'Part-finished periods compare fairly.'), ' A week or month still running is '
          + 'only ever measured against the same number of days of the one before it. Nine days of August '
          + 'are compared with the first nine days of July, never with the whole of it — otherwise every '
          + 'month would look like a huge saving right up until the day it ended.'),
        h('span', h('strong', 'Where there is no history, it says so'), ' rather than showing a confident '
          + '“0% change”.'),
        h('span', h('strong', 'Outside guests'), ' eat the same food, so what they cost you is the '
          + 'per-guest food cost times their number. The month view tells you the fee at which they '
          + 'break even.'),
      ),

      note('Charts respond to your mouse.', 'Hover anywhere on a line or bar to read the exact figures '
        + 'for that day.'),
      note('Everything exports.', 'Every report has a “Save as PDF” button that gives you the whole '
        + 'screen, charts included, ready to email or file. Beside it is an export button for the '
        + 'raw numbers as a spreadsheet.'),
      note('The first fortnight will feel manual.', 'Suggestions and alerts are learned from your own '
        + 'history, so there is nothing to learn from at the start. It gets quick from about week three.'),
    ),
  },

  {
    id: 'overview-explained',
    title: 'The Overview screen, panel by panel',
    permission: 'reports',
    lead: 'Where things stand right now. If you only look at one screen, look at this one.',
    render: () => readings(
      ['Latest day — guests',
        'How many people ate at the most recent breakfast, in-house and paying guests added together. '
        + 'The small line underneath is the last three weeks, so you can see whether it is a normal number.',
        'Nothing, usually. It is context for everything else on the screen.'],
      ['Cost per guest',
        'What the food cost divided by the number of people who ate. This is the fairest single '
        + 'number in the whole system, because it does not change just because the hotel was busy.',
        'Compare it with the little trend line beside it. A steadily rising line means your costs are '
        + 'creeping up — either prices rose or portions grew.'],
      ['This week',
        'Total food cost so far this week, and how it compares with the same number of days last week. '
        + 'A part-finished week is never compared against a full one, so the percentage is honest.',
        'A green figure means you spent less than the equivalent days last week. A red one is worth '
        + 'opening the Week screen for.'],
      ['Month to date',
        'The same thing over the current month, with the cost per guest for the month so far.',
        'Use it to see whether the month is on track before it ends, rather than finding out afterwards.'],
      ['Outsider revenue (month)',
        'Money taken from people who are not staying at the hotel but paid to eat breakfast.',
        'Compare it with the food cost per guest on the Month screen — that tells you whether the fee '
        + 'is actually worth charging.'],
      ['Stock on hand',
        'What the store is worth right now: everything you have bought, minus everything recorded as '
        + 'used, priced at what you paid.',
        'If this is negative or wildly wrong, deliveries have not been recorded. Fix that first — it '
        + 'affects every other number.'],
      ['Needs reordering',
        'How many items have fallen below the level you said you want to keep in stock.',
        'Open the Stock screen and use the order list.'],
      ['Today',
        'Whether the kitchen has recorded today yet.',
        'If it still says “Not yet” late in the day, chase it. A missing day is worse than a rough one, '
        + 'because it leaves a hole in every average.'],
      ['Needs your attention',
        'The system comparing today against your own normal and telling you what looks off — one item '
        + 'used far more than the headcount explains, something habitual not recorded at all, or stock '
        + 'that has gone impossible.',
        'This is the part to actually read. Each line says what happened and roughly what it cost.'],
      ['Cost per guest against covers',
        'Two lines on one chart: what each guest cost you (left) and how many guests there were (right). '
        + 'They have separate scales so both are readable.',
        'Look for the lines moving apart. Cost per guest climbing while guest numbers fall is the '
        + 'classic sign of a buffet laid out for more people than turned up.'],
      ['Guests per day / Daily food cost this week',
        'The week so far, day by day, with last week faded behind it for comparison.',
        'Spot the odd day out, then open it on the Day screen.'],
    ),
  },

  {
    id: 'day-explained',
    title: 'The Day screen, panel by panel',
    permission: 'reports',
    lead: 'One morning in detail. This is where you find out why a day was expensive.',
    render: () => readings(
      ['The four tiles at the top',
        'Guests, total food cost, cost per guest, and money taken from outside guests — each with how '
        + 'it compares against a normal recent day.',
        'The cost-per-guest tile is the one to judge the day by. The others explain it.'],
      ['What stands out',
        'Plain-language notes on anything unusual: an item used well above or below what that many '
        + 'guests would normally need, or a habitual item with nothing recorded.',
        'Read these first. Each one names the item, the quantity, what was expected, and what the '
        + 'difference cost you.'],
      ['Where the money went',
        'The day’s cost split by category — eggs and dairy, bakery, meats and so on.',
        'Useful for spotting a category that has quietly become a bigger share than you thought.'],
      ['Against a typical [weekday]',
        'The same day of the week, averaged over the last few weeks. Sundays are compared with Sundays.',
        'This is the fairest comparison on the screen. A busy Saturday costing more than a quiet Tuesday '
        + 'is normal; a Saturday costing more than other Saturdays is not.'],
      ['Usage against expectation',
        'Every item, with what was used, what would normally be used for that many guests, the '
        + 'difference as a percentage, and — the important column — what that difference cost in money.',
        'Sort your eye down the “cost impact” column. The biggest numbers there are where the money '
        + 'actually went, which is rarely the biggest percentage.'],
      ['Recent trend',
        'Cost per guest and guest numbers over the last four weeks, so this day sits in context.',
        'A single bad day is noise. Three in a row is a pattern worth acting on.'],
      ['Entry quality',
        'How completely the sheet was filled in, and which items were left blank.',
        'A low score means the day’s figures understate reality. Treat its costs as a floor, not a fact.'],
    ),
  },

  {
    id: 'week-explained',
    title: 'The Week screen, panel by panel',
    permission: 'reports',
    lead: 'Comparison. Everything here answers “compared with what?”',
    render: () => readings(
      ['The four tiles',
        'Guests, food cost, cost per guest and outsider income for the week, each against last week.',
        'If cost went up but cost per guest did not, you simply served more people. That is not a problem.'],
      ['This week against last week',
        'Each day’s cost with the same weekday last week beside it.',
        'Look for one day sticking out rather than the whole week drifting.'],
      ['Cost per guest through the week',
        'The same, per guest, with last week as a dashed line.',
        'Where the solid line sits above the dashed one, that day got more expensive per head.'],
      ['What moved',
        'The items whose spend rose or fell most against last week, in money.',
        'This is your shortlist. Two or three items usually explain most of a week’s change.'],
      ['Weekday pattern',
        'How each day of the week normally behaves, averaged over the last eight weeks.',
        'Use it to set expectations, not to judge one morning. If Sunday is always heavier, that is your '
        + 'business, not a fault.'],
      ['Category spend',
        'Each category this week against last, and its share of the total.',
        'A category whose share keeps growing is worth a conversation with the kitchen.'],
      ['Ingredient detail — the “Consistency” column',
        'How steady each item’s use per guest is. “Steady” means the same amount per person every day. '
        + '“Erratic” means it swings about.',
        'Erratic items are usually being eyeballed rather than measured, or guessed at the end of '
        + 'service. They are the easiest place to find savings.'],
      ['Portioning to look at',
        'The worst offenders from that column, gathered in one place.',
        'Start here if you want to tighten portion control.'],
      ['The “⇄ Compare with…” button',
        'Opens the Compare screen carrying this week and the week before it, already filled in.',
        'Use it when last week is not the comparison you want — change either date range once you '
        + 'are there and measure this week against any other.'],
    ),
  },

  {
    id: 'month-explained',
    title: 'The Month screen, panel by panel',
    permission: 'reports',
    lead: 'The owner’s report. This is the one to read at the end of a month.',
    render: () => readings(
      ['The four tiles',
        'Guests, food cost, cost per guest and outsider income for the month, against the month before.',
        'Cost per guest is the headline. The rest is context.'],
      ['Where the month is heading',
        'If the month is not finished, a straight-line estimate of where it will land based on the days '
        + 'recorded so far.',
        'An early warning. It assumes the rest of the month looks like the part already served, so '
        + 'treat it as a direction, not a forecast.'],
      ['Daily cost per guest',
        'Every service day in the month on one line, with whether the trend is rising, falling or flat.',
        'A rising trend inside a single month usually means supplier prices moved. Check the Purchases '
        + 'screen for when.'],
      ['Outside guests — does the walk-in fee pay for itself?',
        'What you charge outsiders, against what their food actually costs. “Break-even fee” is the '
        + 'price at which you neither gain nor lose on the food.',
        'If your fee is below the break-even figure you are paying people to eat. If it is above, the '
        + 'difference is contribution — but remember it only counts food, not labour or gas.'],
      ['Store movement',
        'What you bought this month against what you consumed, and what the store is worth at the end.',
        'Buying much more than you used ties up cash on shelves. Using much more than you bought means '
        + 'you are eating through earlier purchases. Either is fine occasionally; month after month is '
        + 'worth understanding.'],
      ['Week by week',
        'The month broken into weeks, so you can see within-month drift.',
        'Steady climb week on week is the pattern to catch early.'],
      ['Category mix',
        'The share of the month’s spend by category.',
        'Compare it with what you would expect a breakfast to cost. A category well out of line is '
        + 'either a genuine menu choice or a leak.'],
      ['Biggest cost drivers',
        'The dozen items that cost you the most this month.',
        'These are where attention pays. A 10% saving on your top item beats eliminating your smallest.'],
      ['Best and worst days',
        'The leanest and heaviest days by cost per guest.',
        'Open the worst ones to see why. Open the best ones too — sometimes a very cheap day is a sheet '
        + 'that was only half filled in.'],
      ['Every ingredient — “vs last month”',
        'Whether each item’s use per guest went up or down compared with last month. If this month is '
        + 'still running, “last month” means the same number of days of it, not the whole of it.',
        'This is the like-for-like measure. It ignores how busy each month was.'],
      ['The “⇄ Compare with…” button',
        'Opens the Compare screen carrying this month and the matching stretch of the month before, '
        + 'already filled in.',
        'Use it when the previous month is not the right yardstick — the same month last year, or the '
        + 'months either side of a menu change, usually tell you more.'],
    ),
  },

  {
    id: 'compare-explained',
    title: 'The Compare screen, panel by panel',
    permission: 'reports',
    lead: 'Any two periods you choose. The Week and Month screens only ever compare against the '
      + 'period immediately before; this one answers everything else.',
    render: () => h('div',
      h('p', 'Use it for questions the other screens cannot answer: this August against last '
        + 'August, the month before you changed the menu against the month after, high season '
        + 'against low season.'),
      readings(
        ['Which periods?',
          'It opens on this month so far against the same number of days of last month — the '
          + 'ninth of August is measured against the first nine days of July, never against the '
          + 'whole of it. Below that are six ready-made comparisons, or any two date ranges you '
          + 'type yourself. “Use the period immediately before” sets the second range to match the '
          + 'length of the first, ending the day before it starts.',
          'Start with a preset. Type dates only when you have a specific question.'],
        ['The warning about different sizes',
          'If the two ranges are not the same length, or one has more service days than the other, '
          + 'the screen says so.',
          'Take it seriously. A fortnight will always cost more than a week. When you see that '
          + 'warning, read the per-guest figures and ignore the totals.'],
        ['The tiles',
          'Guests, food cost, cost per guest and outsider income for the first period, with the '
          + 'second underneath as “was …”.',
          'Cost per guest is the only one that is fair across periods of any size.'],
        ['Service days / guests per day / cost per day',
          'The same figures divided by how many mornings were actually served.',
          'These make a busy fortnight comparable with a quiet week.'],
        ['Cost per guest, day by day',
          h('span', 'Both periods drawn over each other, starting from each one’s first day. The dates '
            + 'along the bottom are the first period’s; the dashed line is the same ', h('em', 'position'),
          ' in the second period, not the same calendar date.'),
          'Look for one period sitting consistently above the other, rather than for single spikes.'],
        ['What changed most',
          'The items that moved most between the two periods. When the periods are the same size '
          + 'this is ranked in money; when they are not, it switches to cost per guest so a longer '
          + 'period cannot sweep the board simply by being longer.',
          'This is your shortlist. Two or three items usually explain most of the difference.'],
        ['By day of the week',
          'Cost per guest for each weekday in both periods.',
          'A single weekday that moved while the others held still points at a change in that day’s '
          + 'service, not at prices.'],
        ['Outside guests',
          'The fee you charged and the break-even fee in each period, side by side.',
          'If the break-even figure has climbed above what you charge, food costs have overtaken '
          + 'the fee and it needs revisiting.'],
        ['By category / Every ingredient',
          'The same comparison at category and item level, with the per-guest change alongside the '
          + 'money change.',
          'Trust the per-guest column. The money column is only like-for-like when the two periods '
          + 'are the same size.'],
      ),
    ),
  },

  {
    id: 'alerts',
    title: 'What the alerts mean',
    permission: 'reports',
    render: () => h('div',
      points(
        h('span', h('strong', '“X above normal” —'), ' more of something was used than the headcount '
          + 'explains. The figure beside it is what that difference cost you. Common causes: over-'
          + 'portioning, waste, a spill, or a quantity keyed in wrongly.'),
        h('span', h('strong', '“X not recorded” —'), ' an item normally used every day has no figure at '
          + 'all. Almost always a forgotten box rather than a genuine zero.'),
        h('span', h('strong', '“Cost per guest above normal range” —'), ' the whole morning was expensive, '
          + 'not just one item. Open the day and look at the biggest cost drivers.'),
        h('span', h('strong', '“Negative stock” —'), ' the records say you used more than you ever bought. '
          + 'A delivery was not recorded. Add it under Purchases.'),
      ),
      note('Nothing is flagged early on.', 'An item needs about a week of history before it can be judged. '
        + 'Flagging things on two days of data produces noise, and noise teaches people to ignore alerts.'),
    ),
  },

  {
    id: 'deliveries',
    title: 'Recording deliveries',
    permission: 'purchases',
    lead: 'The habit that decides whether the money figures mean anything.',
    render: () => h('div',
      steps(
        h('span', 'Go to ', h('strong', 'Purchases'), ' and set the delivery date and supplier.'),
        h('span', 'Add a line for each item on the delivery note. The unit cost fills in with what you '
          + 'last paid, and the previous price is shown beside it — change it if the price has moved.'),
        h('span', 'Tap ', h('strong', '+ Add another item'), ' for as many lines as the note has.'),
        h('span', 'Check the delivery total against the invoice, then ', h('strong', 'Save delivery'), '.'),
      ),
      warn('Why this matters more than it looks.', 'Every cost in every report comes from what you actually '
        + 'paid. Skip the delivery log and the prices slowly drift out of date, until the reports are '
        + 'confidently telling you something untrue.'),
      note('Suppliers come from a list', 'so the same trader does not appear three times with three '
        + 'spellings. An administrator manages that list under Setup.'),
    ),
  },

  {
    id: 'stock',
    title: 'Stock and the monthly count',
    permission: 'stock',
    render: () => h('div',
      h('p', 'The Stock screen works out what should be in the store: what you started with, plus what '
        + 'you bought, minus what was recorded as used.'),
      points(
        h('span', h('strong', 'Order list —'), ' anything below its par level, with a suggested quantity '
          + 'to bring it back up. There is a button to copy the whole list for your supplier.'),
        h('span', h('strong', 'Days cover —'), ' how long the current stock lasts at the recent rate of '
          + 'use. Under three days is flagged.'),
        h('span', h('strong', 'Record a physical count —'), ' what you actually counted on the shelf.'),
        h('span', h('strong', 'The category chips at the top —'), ' press one and the whole page narrows '
          + 'to it, the figures included, so “Store value” means the value of that category. '
          + '“Group by category” instead keeps everything and bands the tables, with each band’s value '
          + 'on its heading. The copied order list matches whatever is on screen.'),
      ),
      warn('Count the store once a month.', 'Everything else in this system is built on what people '
        + 'said they used. A physical count is the only thing that reveals waste, over-portioning and '
        + 'loss. The difference between the count and the book figure is the honest number.'),
    ),
  },

  {
    id: 'approvals',
    title: 'Approving corrections',
    permission: 'approvals',
    render: () => h('div',
      h('p', 'When a cook changes a day that was already submitted, it waits here instead of overwriting '
        + 'anything.'),
      points(
        h('span', 'You see a plain before-and-after list — “Eggs 90 → 140”, “In-house guests 48 → 52”.'),
        h('span', h('strong', 'Accept'), ' replaces the recorded figures. ', h('strong', 'Reject'), ' '
          + 'leaves them exactly as they are. Either way you can add a note.'),
        h('span', 'Until you decide, every report still uses the original figures.'),
      ),
      note('Deal with these promptly.', 'A correction sitting unapproved means somebody knows the recorded '
        + 'numbers are wrong and the reports do not.'),
    ),
  },

  {
    id: 'setup',
    title: 'Setting up the ingredient list',
    permission: 'setup',
    lead: 'Time spent here is what makes the kitchen’s morning quick.',
    render: () => h('div',
      points(
        h('span', h('strong', 'Unit —'), ' how you actually measure it. Pieces for eggs, loaves for bread, '
          + 'kilograms, litres.'),
        h('span', h('strong', 'Tap step —'), ' how much one press of + or − moves the number. Set it to how '
          + 'the kitchen counts: 6 for eggs, 0.5 for a half kilo. ', h('em', 'This is the single biggest '
          + 'lever on how fast entry is.')),
        h('span', h('strong', 'Everyday or occasional —'), ' everyday items show on the kitchen screen and '
          + 'must be filled in before a day can be submitted. Occasional ones hide behind “All items”. '
          + 'Keep the everyday list tight.'),
        h('span', h('strong', 'Par level —'), ' the level at which you want to reorder.'),
        h('span', h('strong', 'Opening stock —'), ' what is physically in the store today. Set this before '
          + 'you start, or the stock figures begin wrong and stay wrong.'),
      ),
      note('Removing an ingredient', 'that already has history retires it rather than deleting it, so past '
        + 'reports stay correct.'),
      warn('Set the timezone first.', 'It decides which calendar day a morning belongs to. Changing it '
        + 'later makes past days ambiguous.'),
    ),
  },

  {
    id: 'people',
    title: 'People and access',
    permission: 'users',
    render: () => h('div',
      points(
        h('span', h('strong', 'Cooks'), ' see only the daily entry screen. No costs at all.'),
        h('span', h('strong', 'Managers'), ' see the reports, stock, purchases and approvals.'),
        h('span', h('strong', 'Administrators'), ' see everything, and sign in with an email address and '
          + 'password rather than a PIN.'),
      ),
      h('p', 'You can also tick individual sections for one person — a manager who should not see '
        + 'purchases, for instance. What they see in the menu and what they can actually reach are the '
        + 'same thing; it is checked on the server every time.'),
      warn('Keep a second administrator.', 'If only one person can administer the system and they forget '
        + 'their password, the emergency PIN is all that stands between you and a locked door.'),
      note('The emergency PIN', 'is set on Cloudflare, not here. This screen tells you whether it is '
        + 'working, and warns you loudly if somebody’s everyday PIN has taken it over.'),
    ),
  },

  // ---------------------------------------------------------------- maintenance --

  {
    id: 'mx-issue',
    title: 'Issuing parts to a room',
    permission: 'mx_issue',
    lead: 'Three taps. Do it as you fit the part, not at the end of the day.',
    render: () => h('div',
      steps(
        h('span', h('strong', 'Tap where you are working.'), ' Rooms and areas are listed; type in the '
          + 'box to jump straight to one. If you are not working in a particular room, skip it.'),
        h('span', h('strong', 'Tap each part you used.'), ' Tapping the same part again makes it two, '
          + 'then three. For anything not on the everyday list, type in the search box — the size, '
          + 'colour or fitting works as well as the name, so “9W” finds the right bulb.'),
        h('span', h('strong', 'Tap Record issue.'), ' That is it. The room stays selected so the next '
          + 'thing you fit in the same room is two taps.'),
      ),
      note('Quantities start at one.', 'Use the − and + buttons in the bar at the bottom, or type '
        + 'straight into the box, only when it is not one.'),
      note('The job number and note are optional.', 'They help later when somebody asks why a room '
        + 'cost what it did, but a record with neither still tells the store what left the shelf.'),
      warn('Record it when you fit it.', 'A part fitted on Tuesday and recorded on Friday makes the '
        + 'stock figures wrong for three days, and by then nobody remembers which room it went to.'),
    ),
  },

  {
    id: 'mx-reports',
    title: 'What the maintenance reports tell you',
    permission: 'mx_reports',
    lead: 'The kitchen reports ask what a guest cost. These ask what a place cost.',
    render: () => h('div',
      h('p', 'You cannot stop bulbs failing. You can find out that one room gets through four times '
        + 'its share of them, and go and look at why.'),
      readings(
        ['Store — the opening screen',
          'This month\u2019s spend, what the shelf is worth, how much needs ordering, and how much has '
          + 'not moved in three months.',
          'Read the alerts. Everything else on that screen is context for them.'],
        ['Heavy places',
          'A room or area consuming far more than the others, judged against the typical place rather '
          + 'than against a budget. One expensive refurbishment does not make every other room look fine.',
          'This is the finding. Open the room to see what keeps going into it.'],
        ['“Went to the same place N times”',
          'The same part issued to the same room on three or more separate days in the period.',
          'Repeatedly replacing a part is patching, not fixing. It usually means a cause nobody has '
          + 'dealt with — a socket that keeps blowing, a pipe that keeps leaking.'],
        ['A room\u2019s own page',
          'Everything ever issued to that one place: what, how often, and what it has cost month by month.',
          'A part with several occasions is the one to look at first.'],
        ['Store movement',
          'What you bought in the period against what you actually issued.',
          'Buying much more than you use is cash going onto a shelf. Month after month, it is worth '
          + 'asking whether the order quantities are right.'],
        ['Order list',
          'Everything below its restock level, with how much to order and roughly what it will cost.',
          'Negative stock never means the shelf is negative — it means a delivery was never recorded. '
          + 'Add it under Bought and the figure corrects itself.'],
        ['Not touched in three months',
          'Parts sitting on the shelf that nothing has been done with.',
          'Not necessarily wrong; some spares exist so you never need them urgently. But it tells you '
          + 'how much cash is tied up in them.'],
        ['Compare',
          'Any two periods side by side — the rains against the dry months, before and after a rewiring.',
          'If the two periods are different lengths the screen says so. Read the per-day figures then, '
          + 'not the totals.'],
      ),
      note('Narrowing the shelf to one kind of part.', 'The chips at the top of Parts on the shelf pick '
        + 'a category — Electrical, Plumbing — and the whole page narrows to it, the figures included. '
        + '“Group by category” instead keeps everything and bands the tables, with each band’s value on '
        + 'its heading. Counts you have typed are kept while you move between categories, so one Save '
        + 'records the lot.'),
    ),
  },

  {
    id: 'mx-setup',
    title: 'Setting up the parts store',
    permission: 'mx_setup',
    lead: 'Two lists: the parts you keep, and the places you keep them for.',
    render: () => h('div',
      points(
        h('span', h('strong', 'Add rooms a floor at a time.'), ' Give the first and last number and '
          + 'they are all created at once. Running it twice is safe — rooms that already exist are '
          + 'left alone.'),
        h('span', h('strong', 'Mark the everyday parts.'), ' Those appear on the issue screen without '
          + 'searching. Keep the list to the dozen or so things that genuinely go out every week, or '
          + 'the screen stops being fast.'),
        h('span', h('strong', 'Restock level'), ' is the point at which you want to be told to order '
          + 'more. Leave it at zero for anything you buy only when a job needs it.'),
        h('span', h('strong', 'On the shelf now'), ' is what is there the day you start. Get this '
          + 'roughly right and the stock figures are useful from week one.'),
        h('span', h('strong', 'Details'), ' are the variables that tell two similar parts apart — size, '
          + 'colour, fitting, material, whatever you actually use. Add as many as a part needs. They '
          + 'show under its name on the issue screen and in the stock list, and searching matches '
          + 'them, so somebody can type “9W” or “chrome” instead of hunting through the list.'),
      ),
      h('h3', { style: { marginTop: '1.1rem' } }, 'Loading the whole list from a spreadsheet'),
      h('p', 'Adding thirty parts one form at a time is how a store ends up with eight of them. '
        + 'Download the template, fill it in, upload it, and check the preview before anything is '
        + 'written.'),
      steps(
        h('span', h('strong', 'Download the template.'), ' It comes down with the parts you already '
          + 'have, so the same file works whether you are setting up from nothing, correcting prices '
          + 'across the board, or re-levelling after a stocktake.'),
        h('span', h('strong', 'Sizes and colours are just columns.'), ' Any column that is not one of '
          + 'the standard ones becomes a detail: put “15W” under a Size column and “Chrome” under a '
          + 'Colour column and that is exactly what you get. A blank cell means that part has no such '
          + 'detail. Add your own columns for anything you need.'),
        h('span', h('strong', 'Upload it and read the preview.'), ' It tells you how many will be '
          + 'added, how many updated, which detail columns it found, and any new categories it will '
          + 'create. Nothing is written until you press Import.'),
        h('span', h('strong', 'Choose what happens to parts already on the list.'), ' Skipped by '
          + 'default, so an accidental re-upload changes nothing. Switch to “Update” when you mean '
          + 'to correct them.'),
      ),
      warn('Mistakes stop the whole file.', 'A price that is not a number or a name that appears '
        + 'twice is listed with its row number, and nothing imports until it is fixed. That is '
        + 'deliberate — a half-imported list is harder to sort out than one that never went in.'),
      note('Removing something keeps its history.', 'A part or a room that has been used is retired '
        + 'rather than deleted, so past months still add up to what they actually cost.'),
    ),
  },

  // --------------------------------------------------------------- housekeeping --

  {
    id: 'hk-check',
    title: 'Walking the dorms: the bed check',
    permission: 'hk_check',
    lead: 'Two questions per bed. It should take about as long as it takes to look at the bed.',
    render: () => h('div',
      h('p', 'The dorms are walked three times a day, and each walk is its own report. '
        + 'Reception check in the morning, housekeeping check again while the rooms are being '
        + 'done, and reception check once more in the afternoon. The point of three is that '
        + 'something found in the morning can be put right before the day ends.'),
      h('p', h('strong', 'Each round has its own shift and its own hours.'), ' The morning check '
        + 'runs from 6am to 2pm and the afternoon check from 2pm to midnight, both at reception. '
        + 'The housekeeping round in between is the housekeepers’ own — nobody else can fill it in, '
        + 'at any hour, because a round reception recorded says nothing about whether anybody '
        + 'walked the rooms. You only ever see the one you are on.'),
      steps(
        h('span', h('strong', 'There is only one round to be on.'), ' The screen shows the round '
          + 'you are walking and nothing else: housekeepers get theirs whatever the hour, reception '
          + 'get the morning check before two and the afternoon one after it. The other shifts’ '
          + 'rounds are not there to be opened, tidied or corrected — a manager sees all three, and '
          + 'that is who to tell if something in one of them is wrong.'),
        h('span', h('strong', 'Open the room you are standing in.'), ' Rooms are listed down the '
          + 'screen. The first one with beds still to answer for is already open; tap any other '
          + 'room’s name to open it.'),
        h('span', h('strong', 'For each bed, tap Free or Occupied.'), ' Occupied means somebody is '
          + 'using it — bedding disturbed, bags, belongings — whether or not they are in it now.'),
        h('span', h('strong', 'If you tapped Occupied, answer the name tag question.'), ' Yes or No. '
          + 'That is the whole reason for the round: an occupied bed with nothing on it to say whose '
          + 'it is, is the thing your manager needs to know about.'),
        h('span', h('strong', 'When you have finished the property, tap Submit.'), ' That sends '
          + 'your check to whoever needs it. The other two checks of the day are separate — '
          + 'submitting yours does not finish theirs.'),
      ),
      note('An empty room is one tap.', 'Use “All free” on the room’s title bar to mark every '
        + 'bed in it free at once, then correct any that are not.'),
      note('Your answers save themselves.', 'You do not have to press anything as you go. The bar at '
        + 'the bottom counts the beds you have answered for and says when everything is saved.'),
      note('Add a note whenever something is odd.', 'The ✎ button beside a bed takes a line of text — '
        + '"bag on the frame, nobody about", "tag has fallen off". These reach your manager with the '
        + 'round, and they are usually the most useful part of it.'),
      warn('An occupied bed is not saved until the tag question is answered.', 'The bed stays '
        + 'highlighted and the bar at the bottom counts how many are waiting. If you leave them, they '
        + 'are reported as beds nobody checked, which is not the same as beds that were fine.'),
      faq(
        ['I made a mistake on a bed.',
          h('p', 'Tap the answer you gave again to clear it, then give the right one. If the round '
            + 'has already been submitted you can still change it — use the earlier rounds at the '
            + 'foot of the screen — and submitting again sends a corrected summary.')],
        ['Somebody else is doing the first floor.',
          h('p', 'That is fine. Two people can fill in different parts of the same check at the '
            + 'same time, and each bed records who answered for it.')],
        ['The morning check already found this bed untagged.',
          h('p', 'Answer what you see now, not what somebody else saw earlier. If it has a tag now, '
            + 'say yes — that is how the system knows it was dealt with. Each check is a fresh look, '
            + 'and the reports compare them.')],
        ['I did not get to finish yesterday\u2019s round.',
          h('p', 'Use the earlier checks at the foot of the screen to pick the day. You will find '
            + 'your own round there — the one your shift walks — and it is never refused for being '
            + 'late. It is filed against the day it belongs to, not the one you are standing in.')],
        ['Where has the morning check gone?',
          h('p', 'It belongs to the morning shift, and that includes yesterday\u2019s and last '
            + 'week\u2019s. After two o\u2019clock the screen shows the afternoon check on every '
            + 'day you open; before two it shows the morning one. Nobody is meant to be tidying up '
            + 'a round another shift walked — if something in one is wrong, tell a housekeeping '
            + 'manager. They see and can record all three, at any hour, on any day.')],
        ['The signal dropped while I was in the basement.',
          h('p', 'Keep going. The screen says “not saved” and keeps trying on its own; as soon as '
            + 'there is signal again everything you tapped goes through.')],
        ['I could not get into a room.',
          h('p', 'Leave its beds unanswered and submit anyway — it will ask you to confirm. The '
            + 'report shows that room as not checked, which is exactly what happened. Add a note if '
            + 'you know why.')],
      ),
    ),
  },

  {
    id: 'hk-roster',
    title: 'Tonight’s roster: who should be in which bed',
    permission: 'hk_roster',
    lead: 'The roster is what turns “this bed is occupied” into “this bed should not have been”.',
    render: () => h('div',
      h('p', 'Reception know who is booked into which bed tonight. The Roster screen is where that '
        + 'goes in, and it is the only reason the reports can tell you a bed was found occupied when '
        + 'nobody was expected in it.'),
      h('p', h('strong', 'A roster is a night, not a day.'), ' The roster you write on Tuesday is '
        + 'for Tuesday night. Two checks look at that night from either side: Tuesday afternoon, '
        + 'before anybody sleeps in it, and Wednesday morning, to see what became of it. That is '
        + 'why this screen asks about two nights at once.'),
      steps(
        h('span', h('strong', 'First, say how last night ended.'), ' The left-hand column starts as '
          + 'whatever last night’s roster said. Correct anything the bookings changed after it was '
          + 'written — the cancellation at noon, the walk-in at eleven — because this is what this '
          + 'morning’s check is judged against.'),
        h('span', h('strong', 'Then set tonight.'), ' Should be free, should be occupied, or not '
          + 'tracked. “Set tonight to” does a whole room at once, then change the few that differ. '
          + 'Each answer colours itself — green for a bed that should be empty, blue for one '
          + 'somebody is booked into, grey for one nobody is tracking — so a room can be checked at '
          + 'a glance rather than read line by line.'),
        h('span', h('strong', 'Add who is expected, if it helps.'), ' A guest name or a booking '
          + 'reference beside a bed. It is optional, and it shows on the reports beside anything odd '
          + 'that bed turns up.'),
        h('span', h('strong', 'Press Save the roster.'), ' One button for both nights. Saving '
          + 'confirms last night, which settles it: its findings stop moving after that.'),
      ),
      note('Why the morning check looks backwards.', 'Somebody in a bed at eight in the morning '
        + 'slept there last night, under last night’s bookings. If the check were judged against '
        + 'tonight’s roster, a guest who paid and has since checked out would be reported as a '
        + 'stranger, and a bed sold this afternoon would be reported as empty when it should be '
        + 'full. Neither is true, and both would train people to ignore the report.'),
      note('The middle round is treated gently.', 'At eleven in the morning last night’s guest may '
        + 'have gone and tonight’s has certainly not arrived, so a bed changing hands can honestly '
        + 'be found either way. The housekeeping round is only judged where the two nights agree — '
        + 'a bed both nights call free, found occupied, is still worth knowing about.'),
      note('A night nobody wrote a roster for.', 'The last roster written carries forward, because '
        + 'bookings run over several nights and treating a missed morning as “nobody is expected '
        + 'anywhere” would quietly switch the reporting off. The screen says where it came from.'),
      note('“Not tracked” is a real answer.', 'A bed left as not tracked is still checked and still '
        + 'has to carry a name tag. It simply raises no surprise either way. Only beds you have set '
        + 'here can be reported as occupied when they should have been free.'),
      note('This screen cannot break anything.', 'It sets the roster and nothing else — the dorms, '
        + 'the beds and their names are on the Setup screen, which is a separate permission. Somebody '
        + 'given the roster cannot rename a dorm or delete a bed.'),
      note('Correcting an open night, and closing it.', 'Until a night is confirmed, correcting it '
        + 'also corrects the rounds already judged against it — that is what makes it worth doing at '
        + 'nine in the morning. Once confirmed, nothing moves: the front desk cannot change it, and '
        + 'a housekeeping manager has to reopen it if something was confirmed too early.'),
      note('The person walking the dorms should not see this.', 'Somebody who knows the answer before '
        + 'they look at the bed is not really checking it. That is why the roster is its own '
        + 'permission and is left off the bed check screen.'),
    ),
  },

  {
    id: 'hk-reports',
    title: 'What the bed check tells you',
    permission: 'hk_reports',
    lead: 'Everything on these screens is arranged around one number: occupied beds with no name tag.',
    render: () => h('div',
      readings(
        ['The three checks',
          'Morning, housekeeping and afternoon, each its own report with its own submitter. The panel '
          + 'shows how many of each were done, and who walked them.',
          'A round that keeps being missed is a rota problem, and the hours it covers are '
          + 'unwatched however good the other two look.'],
        ['Found and fixed',
          'Whether a finding survived the day. A bed untagged in the morning and tagged by the '
          + 'afternoon was dealt with; the same bed untagged all day was not.',
          'This is the number that says whether checking three times is worth anything. '
          + '"Still wrong at close" is the list to act on.'],
        ['Occupied, no name tag',
          'Beds somebody is sleeping in that carry nothing to say who. Counted only against beds that '
          + 'were actually checked and found occupied.',
          'This is the finding. The email that goes out at the end of each round lists every one of '
          + 'them by room and bed — walk them.'],
        ['Tag compliance',
          'The share of occupied beds that were labelled. Measured against occupied beds, not against '
          + 'every bed, so a quiet week with empty dorms cannot flatter it.',
          'It is the figure to put on a wall. Compare it in points against the period before, which is '
          + 'what the report shows.'],
        ['Occupied unexpectedly',
          'A bed the roster said would be free, found occupied.',
          'Either a booking never reached the front desk, or that bed was never sold. Both are worth '
          + 'knowing before the guest leaves.'],
        ['Booked but found empty',
          'The reverse: a bed the roster had somebody in, found empty.',
          'Usually a guest who left early. If it keeps happening in one room, check the register '
          + 'against the room.'],
        ['Not checked',
          'A bed or a whole room nobody answered for. Shown in grey on the room-by-day squares.',
          'A grey row is not a clean room, it is a room nobody opened — and it deserves as much '
          + 'attention as a red one.'],
        ['Every room, every day',
          'One square per room per day, coloured by the worst thing found in it that day.',
          'Read the rows: a room that keeps going red has a pattern, and hovering a square says what '
          + 'happened. Click a room’s name for everything ever found in it.'],
        ['Beds found untagged more than once',
          'The same bed, repeatedly unlabelled.',
          'One bed doing this over and over is rarely a guest problem. It is usually a habit on one '
          + 'shift, or a frame that has nowhere to attach a tag.'],
        ['Who walked the rounds',
          'How many beds each person answered for, and what they found.',
          'Somebody who never finds anything, on the same floors where everybody else does, is worth '
          + 'a quiet word.'],
      ),
      note('The bell tells you the moment a check lands.', 'Every submitted check '
        + 'appears under the 🔔 at the top of the screen, with the one number that matters — how '
        + 'many beds had no name tag — and a link straight to that day. It also says when an '
        + 'email could not be sent, which is the failure you would otherwise never hear about.'),
      note('Coverage keeps the rest honest.', 'Every rate on the page is calculated from the beds that '
        + 'were checked. Coverage tells you how much of the property that was, so a perfect week on a '
        + 'quarter of the beds cannot be mistaken for a perfect week.'),
    ),
  },

  {
    id: 'hk-setup',
    title: 'Setting up the dorms',
    permission: 'hk_setup',
    lead: 'Rooms and beds are set up once and barely touched again.',
    render: () => h('div',
      steps(
        h('span', h('strong', 'Add each dorm room with its beds.'), ' Say how many beds and they are '
          + 'numbered for you — six beds gives you Bed 1 to Bed 6. Rename any of them afterwards to '
          + 'match what is painted on the frame, because that is what the housekeeper is looking at.'),
        h('span', h('strong', 'Save the room.'), ' One button saves any bed you renamed.'),
      ),
      note('Erasing a period.', 'Under Users & data there is an “Erase bed checks” panel. Set a '
        + 'From and To date and it counts what falls inside them — so many checks, so many beds — '
        + 'before you confirm. Only that period goes: the dorms, the beds, the people and every '
        + 'other day are untouched. There is no undo, which is why it counts first.'),
      note('The roster is never shown to the housekeeper.', 'Somebody who can see what the answer is '
        + 'supposed to be before they answer is not really checking. It appears on the reports and '
        + 'on the Roster screen, and nowhere else.'),
      note('The roster is not here any more.', 'It moved to its own screen when it became a record '
        + 'per night, confirmed each morning. This screen is the furniture — rooms and beds — which '
        + 'changes a few times a year rather than several times a day.'),
      note('Changing the roster does not rewrite the past.', 'Every check keeps its own copy of what '
        + 'was expected at the time, so tonight’s bookings cannot change what last Tuesday found.'),
      note('Closing a room keeps its history.', 'A room or bed that has ever been checked is closed '
        + 'rather than deleted, so past rounds still add up.'),
    ),
  },

  {
    id: 'alerts-setup',
    title: 'Being told when a day is submitted',
    permission: 'reports',
    lead: 'Two ways to hear about it, and they do different jobs.',
    render: () => h('div',
      points(
        h('span', h('strong', 'An alert on your phone or computer —'), ' arrives within seconds of a '
          + 'cook pressing Submit, and says who submitted, how many guests and the cost per guest. '
          + 'Tap it to open that day.'),
        h('span', h('strong', 'An email —'), ' the full morning summary with the analysis and '
          + 'anything flagged, which is the one worth keeping.'),
      ),
      h('h3', { style: { marginTop: '1.1rem' } }, 'Turning on the alert'),
      steps(
        h('span', 'Open ', h('strong', 'My account'), ' at the top right of the screen.'),
        h('span', 'Choose ', h('strong', '“Alert me on this device”'), ' and allow notifications when '
          + 'the browser asks.'),
        h('span', 'Press ', h('strong', 'Send a test'), ' to prove it arrives before you rely on it.'),
      ),
      warn('On an iPhone or iPad, add the site to your Home Screen first.',
        'Use Share → Add to Home Screen, then open it from that icon and turn the alert on there. '
        + 'Apple only allows notifications for sites opened that way — in ordinary Safari the option '
        + 'will not work, and that is Apple’s rule rather than a fault in this system.'),
      note('Each device is separate.', 'Your phone and your office computer are two permissions. '
        + 'Turn it on in each place you want to be told. Turning it off on one leaves the others alone.'),
      can('hk_reports')
        ? note('The bed check has its own email.', 'It goes out the moment a round is submitted and '
          + 'lists every occupied bed found without a name tag, by room and bed, along with anything '
          + 'found where the roster said it should not be. It has its own list of recipients under '
          + 'Users & data → Email alerts; left empty, it goes to the same people as the morning sheet.')
        : null,
      can('users')
        ? note('What you can see under Users & data.', 'The “Phone alerts” panel lists every device '
          + 'being alerted and who it belongs to, lets you retire a phone that has been lost or '
          + 'replaced, and has a master switch. A device that stops existing — a reset phone — is '
          + 'dropped from the list automatically the next morning.')
        : null,
    ),
  },

  {
    id: 'admin-tools',
    title: 'Closed periods, bulk entry and erasing',
    permission: 'users',
    render: () => h('div',
      h('h3', 'Closing a period'),
      h('p', 'Once you have reported on a month, close it. Nothing inside a closed period can be added, '
        + 'changed or deleted by anyone — not a cook correcting a sheet, not an import, not you. '
        + 'Reopening is possible and is recorded.'),
      h('h3', { style: { marginTop: '1rem' } }, 'Bulk entry'),
      h('p', 'For catching up on a backlog or importing paper records. Download the template, fill it in '
        + 'with a spreadsheet, save as CSV and upload it. It always shows you what it would do — which '
        + 'days it would create, replace or skip — before anything is written.'),
      h('h3', { style: { marginTop: '1rem' } }, 'Erasing data'),
      h('p', 'For clearing out a trial run before going live. You have to type ERASE to confirm. It keeps '
        + 'your people, your settings and your ingredient list; you can also give a date range to remove '
        + 'just a few bad mornings.'),
      warn('There is no undo.', 'No recycle bin, no restore. Use the date range if you only mean to remove '
        + 'a few days.'),
    ),
  },

  {
    id: 'problems',
    title: 'If something goes wrong',
    render: () => h('div',
      faq(
        ['It will not let me submit the day',
          h('p', 'Every everyday item needs a number. Items still missing one are outlined in red with '
            + '“needs a figure”. Enter 0 where nothing was used. You also need a guest count.')],
        ['I get a padlock message about a closed period',
          h('p', 'That date has been closed by an administrator and cannot be changed. Ask them to reopen '
            + 'it if the correction is genuinely needed.')],
        ['I submitted a correction but the reports have not changed',
          h('p', 'Corrections to an already-submitted day wait for a manager to accept them. Until then '
            + 'the original figures stand. Check the Approvals screen.')],
        ['A number looks wrong in the reports',
          h('p', 'Open the Day view for that date. It shows every item, what was expected, and what the '
            + 'difference cost. If the entry itself was wrong, correct it on the entry screen — it will '
            + 'go for approval if that day was already submitted.')],
        ['A comparison shows a huge rise or fall I do not believe',
          h('p', 'Check the two date ranges are the same length. On the Compare screen a yellow banner '
            + 'appears when they are not, or when one has far more service days than the other — in that '
            + 'case the totals are meaningless and only the per-guest figures can be trusted. The same '
            + 'thing happens if a few days were never entered: missing mornings pull the total down and '
            + 'read as a saving that never happened.')],
        ['I want to compare two particular periods',
          h('p', 'Open ', h('strong', 'Compare'), ' under Breakfast in the side menu. Pick one of the '
            + 'ready-made buttons, '
            + 'or type any two date ranges yourself and press Compare. You can also start from the Week '
            + 'or Month screen and press “⇄ Compare with…”, which carries that period across for you.')],
        ['The stock figures look impossible',
          h('p', 'Negative stock means deliveries have not been recorded. Add them under Purchases. If the '
            + 'figures were never right to begin with, set the opening stock for those items under Setup.')],
        ['Someone has left and I want to stop them signing in',
          h('p', can('users')
            ? 'Users & data, find them, Edit, set Status to Disabled. It takes effect on their very next '
              + 'action, not whenever they next sign out.'
            : 'Ask an administrator to disable their account under Users & data.')],
        ['I have forgotten my PIN or password',
          h('p', can('users')
            ? 'Any administrator can set a new one from Users & data. If every administrator is locked '
              + 'out, the emergency PIN set on Cloudflare is the way back in.'
            : 'Ask a manager or administrator to set a new one for you.')],
        ['Nobody has entered the day and it is getting late',
          h('p', 'Anyone with entry access can record it, including from a phone. The day sheet records '
            + 'who submitted it, so it will be clear it was not the usual person.')],
      ),
    ),
  },
];
