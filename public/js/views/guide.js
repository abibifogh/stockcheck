import { can, state } from '../app.js';
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
  const sections = SECTIONS.filter((s) => !s.permission || can(s.permission));

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

function greeting() {
  if (can('users')) return 'Everything, including setting the system up and looking after it';
  if (can('reports')) return 'Recording the morning, and reading what it tells you';
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
          h('p', 'Open ', h('strong', 'Compare'), ' in the top menu. Pick one of the ready-made buttons, '
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
