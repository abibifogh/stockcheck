import { can } from '../app.js';
import { h } from '../util.js';

/**
 * The guide for the correspondence system.
 *
 * Its own file because it is its own business. The rest of the guide explains a
 * hotel, and an audit senior opening Help should not be handed a manual for a
 * breakfast unit. Same shape as the other one — sections filtered by what the
 * reader can actually do — and nothing else shared.
 */

export function coGreeting() {
  if (can('co_setup')) return 'Running the register, and setting the practice up';
  if (can('co_approve')) return 'Reviewing, approving and signing what the firm sends';
  if (can('co_register')) return 'Logging the post in and out, and sending it where it needs to go';
  if (can('co_cases')) return 'The client file and the engagements behind it';
  return 'What is waiting on you, and what to do with it';
}

const p = (...children) => h('p', ...children);
const ul = (...items) => h('ul', items.map((i) => h('li', i)));
const steps = (...items) => h('ol.guide-steps', items.map((i) => h('li', i)));
const note = (title, body, warn = false) => h(`div.guide-note${warn ? '.warn' : ''}`,
  h('b', title), ' ', body);

export const CO_SECTIONS = [
  // -------------------------------------------------------------- starting --
  {
    id: 'co-start',
    title: 'What this is',
    lead: 'A register of everything the firm sends and receives, and the work that hangs off it.',
    render: () => h('div',
      p('Every letter, memo and circular is logged once, given a reference number, '
        + 'and then followed all the way to the point where nobody is waiting on it any more. '
        + 'Along the way it can be sent to people, approved, signed, and filed against the '
        + 'engagement it belongs to.'),
      p('Four things are being kept honest at once:'),
      ul(
        h('span', h('b', 'Nothing is lost. '),
          'A letter exists because it was registered. Its reference is issued once and never reused.'),
        h('span', h('b', 'Somebody is always responsible. '),
          '"Who has this?" is answered by a list of routes, each with a name, a deadline and an outcome.'),
        h('span', h('b', 'Deadlines are real. '),
          'Something late is chased, and then somebody senior is told. It happens whether or not '
          + 'anybody remembers to look.'),
        h('span', h('b', 'The record can be checked. '),
          'Every action is written into a chain that says whether it has been edited since.'),
      ),
      note('Where to start.', 'My desk. It shows what is waiting on you and nothing else. '
        + 'For most of the firm it is the only screen they ever need.'),
    ),
  },

  // -------------------------------------------------------------- my desk --
  {
    id: 'co-desk',
    title: 'My desk',
    lead: 'What is with you, sorted by what will bite first.',
    render: () => h('div',
      p('Four lists, in descending order of "is this mine":'),
      ul(
        h('span', h('b', 'With me. '), 'Sent to you by name.'),
        h('span', h('b', 'Nobody has picked these up. '),
          'Sent to your department, or to anyone who can approve. Acting on one makes it yours.'),
        h('span', h('b', 'While they are away. '),
          'Somebody you are covering for. The work stays theirs; you can see it and act on it.'),
        h('span', h('b', 'My action points. '), 'Things you agreed to do, usually in a meeting.'),
      ),
      p('Each row has the buttons on it, so the common case never needs a click into the letter.'),
      h('h3', 'The four things you can do with something'),
      ul(
        h('span', h('b', 'Seen. '),
          'Acknowledges it. Cheap, honest, and worth doing the moment you read it — it is what '
          + 'tells whoever sent it that somebody has it, without waiting for the deadline to speak.'),
        h('span', h('b', 'Complete. '),
          'You have dealt with it. Write what you did in the note; that is what the file will say '
          + 'in two years when somebody asks.'),
        h('span', h('b', 'Send back. '),
          'It should not have come to you, or it cannot be actioned as it stands. You must say why.'),
        h('span', h('b', 'Pass it on. '),
          'Somebody else needs to do part of it.'),
      ),
      note('Passing it on does not discharge it.',
        'It stays with you until you complete it too. If forwarding cleared your list, a letter '
        + 'would go round the firm until everybody thought somebody else had it.'),
    ),
  },

  // ------------------------------------------------------------ registering --
  {
    id: 'co-register',
    title: 'Registering the post',
    permission: 'co_register',
    lead: 'Logging what arrived, and starting what the firm is sending.',
    render: () => h('div',
      steps(
        h('span', 'Press ', h('b', 'Register'), ' on the register screen.'),
        h('span', 'Choose the kind: incoming, outgoing, an internal memo, or a circular.'),
        h('span', 'Name the client or other party, and the engagement if there is one.'),
        h('span', 'Choose a category. This is the field that does the most work — read below.'),
        h('span', 'Type or paste the letter. If it only exists on paper, attach the scan and put '
          + 'a line of summary in.'),
      ),
      h('h3', 'What the category decides'),
      ul(
        'The reference prefix — TAX-2026-0007 rather than IN-2026-0412. A reference read down '
        + 'the phone should say what it is about.',
        'The default deadline.',
        'How long the file must be kept.',
        'Which workflow starts on its own, if any.',
      ),
      h('h3', 'The reference number'),
      p('Issued the moment the letter is logged, exactly as a paper register works: you take a '
        + 'number from the book when the letter reaches the desk. A draft you abandon keeps its '
        + 'number, and so does a letter you cancel. That is correct — a gap in a register is a '
        + 'question with an answer, and a number that comes round twice is two letters filed as one.'),
      h('h3', 'Deadlines'),
      p('Filled in for you from the category, and set in working hours. A 24-hour deadline set at '
        + 'four on Friday afternoon falls at four on Monday, not on Saturday. Which days count is '
        + 'a setting.'),
      note('Confidential and restricted.',
        'Normal is the default and is right for almost everything. Confidential is a marker. '
        + 'Restricted is different in kind: the letter is absent from everybody else’s register '
        + 'entirely, and only a partner can set it.'),
    ),
  },

  // ---------------------------------------------------------------- routing --
  {
    id: 'co-routing',
    title: 'Sending it to somebody',
    permission: 'co_route',
    lead: 'Who has it, what is being asked of them, and by when.',
    render: () => h('div',
      p('Open the letter and press ', h('b', 'Send to…'), '. You are asked three things: '
        + 'who, what for, and by when.'),
      h('h3', 'Who'),
      ul(
        h('span', h('b', 'A person. '), 'It is theirs immediately.'),
        h('span', h('b', 'A department. '),
          'One route, not one each. Whoever picks it up first has their name written against it — '
          + 'which is what makes "send this to Tax" work before anybody knows who in Tax will take it.'),
        h('span', h('b', 'Anyone who can approve. '),
          'Same idea, but the pool is a permission rather than a department.'),
      ),
      h('h3', 'What for'),
      ul(
        h('span', h('b', 'For action. '), 'Do what it asks and report back.'),
        h('span', h('b', 'For review. '), 'Read and comment before it goes further.'),
        h('span', h('b', 'For approval. '), 'Approve or reject. ', h('b', 'Blocks dispatch.')),
        h('span', h('b', 'For signature. '), 'Sign the document. ', h('b', 'Blocks dispatch.')),
        h('span', h('b', 'For information. '), 'No reply expected. Never chased, never escalated.'),
      ),
      note('Approval and signature block sending.',
        'A letter cannot be marked as sent while either is outstanding. That is not a technicality — '
        + 'it is the entire reason those two exist as separate things from "for review".'),
      h('h3', 'Several at once'),
      p('A letter can be with three people at the same time, each for a different reason with a '
        + 'different deadline. That is how correspondence actually moves: an assessment goes to '
        + 'the tax manager for action, the engagement partner for information, and the managing '
        + 'partner for approval.'),
    ),
  },

  // -------------------------------------------------------------- workflows --
  {
    id: 'co-workflows',
    title: 'Workflows, deadlines and escalation',
    lead: 'The part that runs whether or not anybody remembers to look.',
    render: () => h('div',
      h('h3', 'Workflows'),
      p('A workflow is a list of steps. Each one opens a route; the next opens when that one closes. '
        + 'A workflow attached to a category starts by itself the moment a letter in that category '
        + 'is registered — there is nothing to press.'),
      p('A rejection stops the run where it stands and sends the letter back to whoever wrote it. '
        + 'They are the only person who can do anything about "no", so it does not sit in a queue.'),
      h('h3', 'Reminders'),
      p('A route with a deadline is reminded once, ahead of it. How far ahead is a setting.'),
      h('h3', 'Escalation'),
      p('Past its deadline by the grace period, and somebody senior is told: the person the step '
        + 'names, or the head of the department it went to, or the head of the late person’s own '
        + 'department.'),
      note('Escalation never moves the work.',
        'It stays with the person it was sent to. Moving late items to a partner’s queue is how a '
        + 'partner ends up with forty things and the person who was late ends up with none.'),
      h('h3', 'When somebody is away'),
      p('Set an away date and a cover under Practice setup → People. Their cover sees their work '
        + 'and hears about it going late. Nothing is reassigned — a week of leave should not become '
        + 'a week of silence, and it should not become somebody else’s backlog either.'),
    ),
  },

  // ------------------------------------------------------------- signatures --
  {
    id: 'co-signing',
    title: 'Approving and signing',
    permission: 'co_approve',
    lead: 'Two different things, and the difference matters.',
    render: () => h('div',
      p(h('b', 'Approving'), ' records a decision against a route: yes or no, with a comment. '
        + 'A rejection must say why — one that does not is a letter coming back with nothing '
        + 'anybody can act on.'),
      p(h('b', 'Signing'), ' puts your name on the document itself, and seals it.'),
      h('h3', 'What sealing means'),
      ul(
        'The subject, the text and every attached file are fixed at that moment.',
        'Nobody — including you — can edit them afterwards. A follow-up letter is registered instead.',
        'No further files can be attached, because the attachments are part of what was signed.',
      ),
      p('Four ways to produce a signature: the one you saved, drawn there and then, an uploaded '
        + 'image of your real signature, or your name typed. None is more secure than another — '
        + 'the security is the seal, computed from the account that placed it and a secret held '
        + 'on the server rather than in the database. The choice exists because a system people '
        + 'refuse to use is not secure either.'),
      p('To get somebody ', h('b', 'outside'), ' the firm to sign, see “Getting a client to sign” '
        + 'below. They need no account.'),
      note('Before you sign, read what you are sealing.', 'Signing is the one action here with no '
        + 'undo. If the text is wrong, fix it first — afterwards the only route is a fresh letter.', true),
    ),
  },

  // ----------------------------------------------------- outside the firm --
  {
    id: 'co-envelopes',
    title: 'Getting a client to sign',
    permission: 'co_approve',
    lead: 'A link, no account, and a record of everything that happened.',
    render: () => h('div',
      p('A client is not going to create an account in your correspondence system, and asking '
        + 'them to is how a signed engagement letter turns into a printed page, a wet signature '
        + 'and a photograph taken on a phone.'),
      p('So: open the letter and press ', h('b', 'Send for signature'), '. Each person gets a '
        + 'link that is theirs alone. They open it, read the document and its attachments, agree '
        + 'to sign electronically, and sign. That is the whole thing they have to do.'),

      h('h3', 'Who you are asking'),
      ul(
        h('span', h('b', 'Signs. '), 'Puts their signature on it. The request is not finished '
          + 'without them.'),
        h('span', h('b', 'Approves. '), 'Their agreement is recorded, but no signature is placed. '
          + 'A finance director who authorises but does not execute.'),
        h('span', h('b', 'Copy only. '), 'They get it for information and are asked for nothing. '
          + 'Nothing ever waits on them.'),
      ),

      h('h3', 'In order, or all at once'),
      p(h('b', 'One after another'), ' is right for a countersigned agreement: the second person '
        + 'is not invited until the first has finished, and cannot sign early. Their link still '
        + 'opens, so they can read what is coming.'),
      p(h('b', 'Everybody at the same time'), ' is right for four directors in four countries '
        + 'signing the same resolution.'),

      h('h3', 'Sending freezes the document'),
      p('Its text and its attachments cannot change while the request is out. That is what makes '
        + 'four signatures collected over three weeks signatures on one document rather than on '
        + 'four. If the wrong version went out, withdraw the request, fix it and send a new one.'),

      h('h3', 'Access codes'),
      p('Optional, and worth it for anything sensitive. Give the code to the recipient by some '
        + 'other route — a telephone call, the covering letter. A forwarded email is then not on '
        + 'its own enough to sign.'),

      h('h3', 'The links'),
      p('Everyone is emailed their own link the moment you press send, and the links are shown on '
        + 'screen as well with a copy button — so a recipient with no email address, or a firm '
        + 'that has not set email up yet, is never stuck.'),
      p('Watch the recipient list on the letter. It says ', h('b', 'emailed'), ' and when, or '
        + 'names the reason a send failed, or says the person has no address and you will have to '
        + 'pass the link on yourself. A failure is never silent.'),
      p('If a link goes astray, press ', h('b', 'New link'), ' against that person. They are '
        + 'emailed the new one and the old one stops working immediately.'),

      h('h3', 'Chasing, and giving up'),
      p('Anybody who has not opened it, or has opened it and not signed, is emailed again every '
        + 'few days — the same link, so the first email they were sent still works — and told how '
        + 'long it has been waiting. Nobody in the firm has to remember to chase.'),
      p('Links expire — thirty days by default — and an expired request is reported rather than '
        + 'quietly forgotten, so somebody can send a fresh one to a client who probably meant to '
        + 'sign. When the last person signs, every signer gets a receipt and the firm is told.'),
      note('If nobody has set email up, none of that happens.',
        'Nothing is sent and nothing pretends to have been. The links are still on screen, and you '
        + 'send them yourself. Practice setup → Email is where that is turned on.'),

      h('h3', 'The certificate'),
      p('Every request has one: who was asked, when each of them opened it, from what network '
        + 'address and on what browser, what they signed with, and the fingerprint of the exact '
        + 'document. Printable, because the day anybody wants it is the day somebody outside the '
        + 'firm has asked for evidence.'),
    ),
  },

  // ---------------------------------------------------------- my signature --
  {
    id: 'co-my-signature',
    title: 'Your own signature',
    lead: 'Set it up once. After that, signing is one tap.',
    render: () => h('div'
      ,
      p('On ', h('b', 'My desk'), ' there is a card called My signature. Draw it with a finger or '
        + 'a trackpad, or upload a photograph or scan of your real one. From then on it is offered '
        + 'first every time you sign something.'),
      ul(
        'Replacing it changes what you sign with next time and changes nothing you have already signed.',
        'Removing it changes nothing you have already signed either.',
        'A typed name cannot be saved — there would be no image to show you next time.',
      ),
      note('None of the four ways is more secure than the others.',
        'The security is the seal, computed from the account that placed it and a secret held on '
        + 'the server. Drawing a squiggle adds nothing to that. What it adds is that people will '
        + 'actually use the system, and a signing step people route around is not a control.'),
    ),
  },

  // ---------------------------------------------------------- the trail --
  {
    id: 'co-trail',
    title: 'The trail, and checking it',
    lead: 'What the system can prove, and what it cannot.',
    render: () => h('div',
      p('Every action against a letter is one entry: who, when, what, and the detail. Each entry '
        + 'carries a hash of the one before it, so the whole history is a chain.'),
      p('Press ', h('b', 'Verify this record'), ' on any letter. It answers two questions '
        + 'separately, because they fail for different reasons:'),
      ul(
        h('span', h('b', 'Is the trail intact? '),
          'If not, it names the entry where the break starts, and says whether that entry itself '
          + 'was changed or whether something before it was changed or removed.'),
        h('span', h('b', 'Do the signatures still match? '),
          'A seal can be genuine while the document has moved underneath it. Both are reported.'),
      ),
      p('Swapping the scanned page behind a signed letter changes nothing in the register and is '
        + 'caught anyway: the fingerprint of every attachment is folded into what was signed.'),
      note('What this proves.',
        'That the record has not been edited behind the application — a row quietly changed in a '
        + 'database console breaks the chain here. It is not proof against somebody who can rewrite '
        + 'every row at once. It is proof against the thing that actually happens.'),
    ),
  },

  // ------------------------------------------------------- confidentiality --
  {
    id: 'co-confidential',
    title: 'Restricted files',
    lead: 'Absent, not locked.',
    render: () => h('div',
      p('A restricted letter does not appear in the register for anybody except the person who '
        + 'registered it, anybody it has been sent to, and partners. Not greyed out. Not "you may '
        + 'not open this". Absent — including from the totals and from the exports.'),
      p('That is deliberate. A row saying a file exists still tells you the firm is corresponding '
        + 'with somebody about something, and for the letters that get marked restricted — a '
        + 'disciplinary matter, a suspected fraud, a partner’s own tax affairs — that is the leak.'),
      p('Opening one directly gives the same answer as a letter that does not exist.'),
      note('Only a partner can set it.',
        'Raising a file to restricted changes who in the firm can see it, so it is not the author’s '
        + 'call after the fact.'),
    ),
  },

  // ------------------------------------------------------------ engagements --
  {
    id: 'co-engagements',
    title: 'Engagements',
    permission: 'co_cases',
    lead: 'The work a letter belongs to.',
    render: () => h('div',
      p('An engagement is one piece of work for one client: the 2026 audit of Kwame Foods, the '
        + 'monthly payroll for a clinic, an advisory piece with no end date. Letters, action points '
        + 'and meetings all hang off it, so the file is in one place.'),
      h('h3', 'Two deadlines, deliberately'),
      ul(
        h('span', h('b', 'Statutory deadline. '),
          'The one with a penalty behind it. The board is sorted by this and nothing else.'),
        h('span', h('b', 'Our own target. '),
          'When the firm means to be finished. Missing it costs a conversation.'),
      ),
      p('They are separate fields on purpose. Collapsing them into one loses exactly the '
        + 'information that tells you whether being late is awkward or expensive.'),
      h('h3', 'Hours'),
      p('Hours are logged against action points, and roll up to the engagement against its budget. '
        + 'It is a rough measure and it is honest about being one: it counts what people wrote down.'),
    ),
  },

  // ----------------------------------------------------------- action points --
  {
    id: 'co-tasks',
    title: 'Action points',
    lead: 'What somebody agreed to do.',
    render: () => h('div',
      p('Raised by hand, from a letter, or — most of them — written straight out of a meeting’s '
        + 'minutes. Each has one name against it, a deadline, and a priority.'),
      p('They are reminded before they fall due, and again when they pass it.'),
      note('Progress is done against raised.',
        'Cancelled points are left out of both halves. They were never work, and counting them as '
        + 'done flatters the figure.'),
    ),
  },

  // -------------------------------------------------------------- meetings --
  {
    id: 'co-meetings',
    title: 'Meetings and minutes',
    permission: 'co_meetings',
    lead: 'And the action points that come out of them.',
    render: () => h('div',
      p('Schedule a meeting once, or on a repeat — weekly, monthly, quarterly, whatever it is.'),
      h('h3', 'How repeats work'),
      p('A repeating meeting is stored once, as the rule. The diary holds only the next occurrence, '
        + 'and the next one is created as each passes. A year of rows generated in advance would '
        + 'all be wrong the first time the meeting moves.'),
      h('h3', 'Minutes'),
      p('Minutes and action points are recorded in the same place, and that is the point of the '
        + 'screen. "Ama to write to the Registrar by Friday" typed into a minutes box is a sentence '
        + 'nobody reads again. Typed into the rows underneath, it is a thing with a name, a date '
        + 'and a reminder attached.'),
      note('Recording minutes marks the meeting held.', 'You can add more action points later; '
        + 'they are added to the ones already raised rather than replacing them.'),
    ),
  },

  // ------------------------------------------------------------- reporting --
  {
    id: 'co-reports',
    title: 'The numbers',
    permission: 'co_reports',
    lead: 'What they mean, and what they do not.',
    render: () => h('div',
      h('h3', 'Turnaround'),
      p('Measured from registration to close, over the letters that actually closed. Letters still '
        + 'open are not averaged in — doing that would make a growing backlog look like fast work, '
        + 'which is exactly the wrong way round.'),
      h('h3', 'Clearance'),
      p('Completed against received, in the same window. Above 100% means somebody cleared a '
        + 'backlog; below means one is building.'),
      note('It is a direction, not a grade.',
        'Somebody handling four Revenue enquiries is not slower than somebody acknowledging forty '
        + 'circulars, and the number cannot tell them apart. It is here so that "is anything stuck '
        + 'with anyone" has somewhere to be answered.', true),
      h('h3', 'Exports'),
      ul(
        'The register, as a spreadsheet — what an inspection asks for first.',
        'The engagement board, with statutory deadlines and hours.',
        'The full audit trail with entry hashes, for a period you choose.',
      ),
      p('Every export respects who may see what. A restricted letter is no more present in a '
        + 'manager’s export than it is on their screen.'),
    ),
  },

  // ----------------------------------------------------------------- setup --
  {
    id: 'co-setup',
    title: 'Setting the practice up',
    permission: 'co_setup',
    lead: 'Done once, then left alone for six months.',
    render: () => h('div',
      steps(
        h('span', h('b', 'Departments. '),
          'Give each one a head — that is who overdue work escalates to. A department with no head '
          + 'escalates to nobody.'),
        h('span', h('b', 'Categories. '),
          'Set a prefix, a default deadline and a retention period on each.'),
        h('span', h('b', 'Workflows. '),
          'Edit the two supplied ones or write your own, then attach a workflow to a category so '
          + 'it starts by itself.'),
        h('span', h('b', 'Templates. '),
          'The letters you send over and over. Placeholders are filled from the client and the '
          + 'engagement.'),
        h('span', h('b', 'People. '),
          'Department, title, what appears under their signature, and who covers them when away.'),
      ),
      h('h3', 'Working days and timings'),
      p('Which days count, the default deadline, how far ahead a reminder goes, and how late '
        + 'something must be before it escalates. All four are on the same card.'),
      h('h3', 'Email'),
      p('The card marked ', h('b', 'Email'), ' is what turns automatic messages on: signing '
        + 'invitations, the chasers that go to a client who has not opened theirs, routing and '
        + 'escalation notices, and receipts when a document is finished.'),
      ul(
        h('span', h('b', 'From address. '), 'Must be on a domain your mail provider has verified. '
          + 'An unverified domain means every message bounces or lands in spam, which looks '
          + 'exactly like a client ignoring you.'),
        h('span', h('b', 'Sender name. '), 'What a client sees in their inbox.'),
        h('span', h('b', 'Reply-to. '), 'Where a reply lands — usually the office address somebody '
          + 'actually reads, which is rarely the address the system sends from.'),
        h('span', h('b', 'Site address. '), 'Every link in every message is built from it. Wrong '
          + 'here and the emails go out with links that go nowhere.'),
        h('span', h('b', 'Two switches. '), 'Clients and signers, and the firm’s own people. '
          + 'Separate on purpose: a practice can have clients chased automatically without '
          + 'filling its staff’s inboxes.'),
      ),
      p('Then press ', h('b', 'Send a test to myself'), '. It goes to your own address and nowhere '
        + 'else, and if something is missing it says which thing rather than reporting success and '
        + 'sending nothing.'),
      note('Your own people need email addresses on their accounts.',
        'Users & data is where those live. Somebody without one still sees everything on screen '
        + 'and still gets the bell; they simply get no email.'),
      h('h3', 'Run the sweep now'),
      p('Proves reminders and escalation work without waiting until tomorrow. Everything the sweep '
        + 'does is safe to repeat, so pressing it twice is the same as pressing it once.'),
      note('Changing a workflow does not rewrite history.',
        'Letters already part-way through keep their step number and carry on against the new list. '
        + 'A firm that reorders its approvals means it from now on, not retrospectively.'),
    ),
  },

  // -------------------------------------------------------------- problems --
  {
    id: 'co-problems',
    title: 'When something looks wrong',
    render: () => h('div',
      h('h3', '"This cannot be marked as sent"'),
      p('An approval or a signature is still open on it. Clear them, or withdraw them if they are '
        + 'no longer needed. That refusal is the whole reason those routes exist.'),
      h('h3', '"This document has been sealed"'),
      p('Somebody has signed it, so the text is fixed. Register a follow-up letter — it will be '
        + 'linked to this one and the thread reads from either end.'),
      h('h3', 'A letter somebody mentioned is not in the register'),
      p('Either the filters are narrower than you think — check the status tabs and the archived '
        + 'box — or it is restricted, in which case ask a partner.'),
      h('h3', 'Verification says the document has moved'),
      p('The text or an attachment changed after a signature was placed. The signature itself may '
        + 'be perfectly genuine; what it describes is no longer what is on screen. Open the trail '
        + 'and read what happened after the signing entry.'),
      h('h3', 'Nothing is being chased'),
      p('Check ', h('b', 'Practice setup'), ' → the sweep is switched on, and the routes actually '
        + 'have deadlines. A route asking only for information is never chased — nothing was asked '
        + 'of them, so nothing is late.'),
      h('h3', 'No emails are arriving'),
      p('Open ', h('b', 'Practice setup'), ' → Email. The banner at the top says whether a mail '
        + 'provider key has been set on this deployment at all; without one nothing is sent and '
        + 'nothing pretends to have been. If it is set, press ', h('b', 'Send a test to myself'),
      ' — it names what is wrong. If the test arrives but a client says theirs did not, look at '
        + 'the recipient list on the letter: it records the failure and the reason against that '
        + 'person, and the full log is under Users & data.'),
      h('h3', 'A client says their link no longer works'),
      p('Either the request was withdrawn or it expired — the page they land on says which — or '
        + 'somebody pressed ', h('b', 'New link'), ' for them, which kills the old one on purpose. '
        + 'A reminder never does that: it repeats the same link, so the first email they were sent '
        + 'keeps working.'),
      h('h3', 'Somebody is drowning and nobody knew'),
      p('Productivity → open now and late now, by person and by department. That is what the page '
        + 'is for.'),
    ),
  },
];
