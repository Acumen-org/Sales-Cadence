# Directory and CRM content review - 14 September 2026

## Confirmed counting rule

An Accounts pod filter selects companies containing at least one live contact in that pod. The people total then counts **all live contacts at those matching accounts**, including other pods. Each company is counted once. Contacts without a company only contribute to People. This is the behavior the owner explicitly selected; the summary now says **People at matching accounts** and each row says **People at account**. Accounts intentionally does not have the same contact membership as a pod-filtered People list.

## Requested changes

- Accounts replaces Industry, City and Owner columns with PODs, FOs and Product. Associations are deduplicated across the complete account, including contacts outside the selected pod. FOs combine CRM ownership and active/paused enrollment assignments; administrative CRM owners are not presented as FOs.
- People uses **Tags in Twenty** and removes the Recent activity column and timeline. Tag chips use deterministic colours and apply filters. Tier, contact-type and product tags reuse their existing filter. Other CRM tags have a directory-wide dropdown; list categories have their own dropdown. Filter choices survive refresh and pagination. Clearing an FO stays cleared when paging.
- Every existing sort selector (Accounts, People and Enrichment) supports ascending and descending. Sorting occurs before pagination; exports retain the chosen order. People's update sort uses the CRM modification timestamp instead of the latest sync timestamp.
- CRM email queries now request the mapped body field, which was previously omitted. Email and note bodies open in full, with cursor navigation to older records. Emails separate From, To, Cc and Bcc, and sanitize HTML content before rendering. Notes retain their complete body and author. Missing source bodies and unavailable CRM responses remain explicitly identified.
- Sync feedback uses a dismissible, temporary portal toast. Its button keeps the same label and dimensions while running; completion feedback adds no content to the filter toolbar.

## Verification

- Production build, lint and type checking passed.
- 325 unit/integration tests passed, including full email/note query content, mixed-pod account counts, associations, both sort directions and enrichment ordering.
- The scale test exercised 20,000 contacts / 6,000 companies with 12 concurrent account-page reads; all pages contained the expected distinct records.
- 56 browser tests passed, including the sync button/search bounding-box check and automatic toast dismissal. Browser coverage includes tag click/reset/reload, account columns and numeric sort order, export direction, four simultaneous seats repeatedly visiting seven sections, and desktop/mobile layouts.
- Hosted read checks passed for the supplied Admin, POD Manager, Biz Ops and FO accounts across People, Accounts, Meetings and Enrichment: 16 successful routes, no browser errors. Those checks validate the deployed baseline; new behavior was verified against the local production build before pushing.

## Release boundary

The repository workflow builds and pushes an image to Harbor after checks pass. Its current configuration explicitly leaves deployment manual. A successful GitHub push or image build alone does not establish that the hosted site is running that commit.

---

# Table width, sorting, blocked accounts and email reading - 14 September 2026 (second pass)

## Accounts

- The table no longer scrolls sideways. Its nine columns have fixed shares that add up to the
  table, the padding is the denser one People already used, and the headers wrap instead of
  pushing the table wider. The account name column is the narrowest of the change: names truncate
  with the full name on hover. A browser check now measures the scroll width of both directories
  and fails if either overflows by more than a pixel.
- PODs, FOs and Product show one tag and then `+N`, which opens the rest in place - the same
  control People already used for Twenty tags, now shared by both (`src/components/pill-list.tsx`).
  A collapsed row never wraps, so every row is one line high.
- The search box says what people type into it: **Search name or domain**, not the industry and
  city columns that were removed.
- The `mine` badge is gone from the list rows. It was the last of the "Mine" chrome that was
  asked to be removed, and it competed with the account name for the narrower column. The account
  page still says so in its header.

## Sorting

The direction dropdown is gone everywhere (Accounts, People, Enrichment). In its place:

- One control: the sort menu with the direction as an arrow button attached to it. Clicking the
  arrow reverses the order; choosing a different field drops the explicit direction, so a date
  opens newest first and a name A-Z without anyone setting it.
- On Accounts, the columns sort themselves. Account, People at account, In sequence, Replied and
  Last touch are buttons; the one in force carries the arrow, and clicking it again reverses it.
  `aria-sort` is set on the header, and the control still drives the same `sort` and `dir`
  parameters, so a link or a reload lands on the same order.

## People

- **Any list category** is gone from the filter bar. The parameter still works, so a list-category
  tag clicked in the table still filters and still shows as a removable chip.
- The bar is one row: search, pod, FO, **Filters**, and the sort control. Product, tier, contact
  type, Twenty tag and sequence state live behind the Filters button, which carries a count when
  any of them is set and opens by itself when a URL arrives with one. Active filters stay visible
  as removable chips whether the panel is open or shut.
- The FO dropdown lists active users in a sales role (Junior FO, Senior FO, Sales Leader, Pod
  Manager) who belong to a pod. Admin and Biz Ops seats are deliberately not outreach owners, and
  a sales user who has not been put in a pod does not appear. Three names means three such users
  in Settings > Team & pods; adding more there adds them here.

## Blocking an account

An admin can take a firm out of Cadence, from a button on its account page or from
Settings > Blocked accounts (with an optional reason). Blocking:

- removes the account from Accounts and its people from People, global search, enrichment and
  campaign audiences;
- refuses any new enrollment with its own reason, "Account blocked in Cadence";
- ends the sequences its people are in (`exitEnrollment`, reason `account_blocked`), which cancels
  the open tasks through the normal path and mirrors the cancellation to Twenty;
- leaves CRM people, companies and cache rows unchanged, so inbound activity still matches
  those people and the history stays intact.

The blocked account's page stays open to an admin, carrying a banner with who blocked it, when,
and why, and returns a 404 to everyone else; the people on it stay reachable for that admin alone.
Unblocking puts the account and its people back immediately. A sequence that ended stays ended:
restarting outreach is a decision somebody makes. Blocking is administration, so it lands in the
audit log and stays out of the Activity feed, beside settings, users and pods.

## CRM emails and notes

Each email is now its own framed card instead of a row in a divided list: a green edge and a
**Received** badge for what came in, a red edge and **Sent** for what went out, a grey one when
the sender is neither one of our users nor the person. The direction is the engine's own rule
(`classifyMessage`), not a second opinion. The header carries the direction, the subject, who sent
it and who it went to, and the date; the body sits below with its recipients, a readable measure,
quoted text set apart, and wide tables and images kept inside the card. Notes get the same framing
without the colour.

## Meetings

The Attendees column no longer breaks across two lines: the count and the "N external" tag sit on
one row, aligned, with the count in tabular figures.

## Verification

- Production build, TypeScript and lint pass.
- 330 unit and integration tests across 48 files pass, including a new file for blocking: the
  account and its people leaving every directory, the cache rows surviving, enrollment refusing
  them, the sequences ending with their tasks cancelled, who may open the page, and unblocking.
- 61 browser tests pass, including the new width measurement of both directories, the collapsed
  FOs column, header sorting in both directions, the Filters panel, and an admin blocking and
  unblocking an account end to end while a second seat is refused the control and the settings tab.
- Screens were captured and inspected for the accounts table, the people bar, the meetings table,
  the CRM email cards and the new settings tab.

## Verification review - 15 September 2026

Reviewed the uncommitted changes against the requested checklist and preserved the newer GitHub deployment/security commits through 77fad87. The hosted baseline still showed the previous direction dropdown; the local changes were not yet deployed. All four supplied seats could read the main directories, and each offered three eligible sales users in its FO dropdown.

Corrected duplicate React keys in the account column definitions and added error handling for blocked-account search/actions. Blocking, enrollment, campaign activation and task generation now coordinate account locks; block creation, enrollment exits, task cancellations and audit records commit together. A concurrent enrollment/blocking regression verifies that no active enrollment or pending task remains. Existing CRM task mirrors are resolved normally; CRM people and companies are unchanged.

The current GitHub workflow now builds AND deploys through Nomad, replacing the older manual release boundary described above. The release includes the BlockedAccount database migration, applied by the web task on startup.

Final verification: production build/type checking/lint passed; all 332 unit/integration tests passed against an isolated database; all 61 browser tests passed, followed by 8 release-build directory/permission checks after the final backend changes. Screens for account chips and CRM message framing were inspected. No live accounts were blocked and no live CRM data was edited during verification.


## Sorting, content completeness and workflow regression - 15 September 2026

People name ordering used surname-first keys even though the visible label is first-name-first. The cache now uses display order; migration `20260924000000_display_name_sort` backfills existing rows. Nameless accounts retain their position after named accounts but reverse their domain fallback when direction changes. Independent filter, tag, header and sort controls now share the pending URL, preventing rapid interactions from overwriting each other. Direction changes use that pending state rather than stale rendered props.

CRM note titles and email subjects wrap in full. The brief no longer cuts note bodies at 180 characters; contact activity preserves the source note body when the note is represented by a touch. Twenty reads request both markdown and BlockNote, decode nested paragraphs, links and table cells, and use the longer editor content when markdown contains a shorter summary. Email HTML renders with normal whitespace, safe paragraph boundaries and compact empty spacers. Plain messages retain paragraph breaks with excessive blank lines collapsed. The existing strict sanitizer still rejects scripts, event handlers and tracking images.

Validation: production build and lint passed; 337 unit/integration tests passed in an isolated migrated database. All 62 browser tests passed against the final production build. Browser coverage includes first-name ordering in both directions, a pending search plus sort change, clear/reload filter behavior, task draft editing and completion, call outcomes, mixed steps, sequence editing locks, campaign launch and follow-up approval, and role permissions. Engine stress coverage includes 16 concurrent enrollments, 32 duplicate webhook deliveries, simultaneous child-action completion, sequence-edit/generation races and campaign lifecycle gates. Twelve concurrent account queries over 20,000 people and 6,000 accounts completed in 579 ms locally; this is not a hosted capacity measurement.

Read-only live sampling covered 12 contacts, 109 notes and 121 emails. Many source note bodies appear unusually short; the exact reported truncated note has not been identified or compared with the original CRM record. The code removes known display truncation and reads the alternate editor body, but does not fabricate text absent from both source fields. No live tasks, campaigns or CRM records were modified during testing.

---

# Stress pass on tasks, campaigns and sequences - 17 September 2026

The previous round fixed sorting, shared filters and CRM content but left the workspace CI red and
did not exercise the three features the owner had not yet inspected. Both are addressed here.

## The failing check

`tests/content-completeness.test.ts` passed the `as const` schema object where `normalizeNote`
takes the mutable `TwentySchema`, so lint passed and `tsc` failed the push. It now builds its
schema with `mergeTwentySchema()`, as every other suite does.

## What the stress pass covers

`tests/stress-tasks-campaigns-sequences.test.ts` - 14 cases, each asserting an invariant an FO
would notice rather than the absence of an exception:

- **Tasks.** Eight clicks on one touchpoint: one completion, one touch, one audit line, no second
  copy of the step. Done, skip and snooze racing: at most one terminal outcome, the step keeping
  exactly the modules the plan holds. A delegation racing a completion: the whole selection moves
  or none of it does. Scheduler ticks beside hand completions across three steps: no duplicated
  step.
- **Campaigns.** Six simultaneous launches: each person enrolled once, one `started` audit line,
  one run. Pausing while its work is completed: no enrollment left active and nothing new
  generated. Stopping beside a scheduler tick: every open touchpoint cancelled exactly once.
  Pause and resume clicked together: one state, enrollments active, no duplicated work. A daily
  ramp under a simultaneous launch: never more than the ramp per FO per day.
- **Sequences.** A plan edit racing the last completion on that step: the task keeps the frozen
  copy the FO was reading. A nurture sequence finishing under concurrent ticks: exactly one new
  cycle. A person who opted out mid-plan: no new cycle. A campaign paused mid-plan: it resumes on
  the step it stopped on, once.

## The bug it found

**The daily cap could be exceeded.** Task generation reads an FO's load for a day and then writes
to it, inside one transaction guarded by an advisory lock on the *sequence*. Two plans feeding the
same FO never meet on that lock, so each could see room for the last slot of a day and take it: a
cap of two produced three touches on 2026-09-14 in the test. Generation now also locks the FO for
the rest of the transaction, taken after the account, campaign and sequence locks so the order can
never invert. The scheduler walks enrollments one at a time, so this adds no contention within a
tick; it only bites where the race was.

## Also in this pass

- A CRM email no longer opens or closes with the blank line its mail client's wrapper div left
  behind, and a note in the person timeline wraps to a readable measure and breaks a long address
  instead of pushing the column sideways.

## Verification

- Production build, TypeScript and lint pass; 352 unit and integration tests across 50 files pass;
  62 browser tests pass.
- A realistic Outlook message (nested divs, `&nbsp;` spacers, a table, a quoted reply, four
  trailing breaks) was rendered through the formatter: figures, table cells and the quoted block
  all survive, with no `&nbsp;` gaps and no run of three or more breaks.

---

# The 34-point round - 18 September 2026

Everything in PLAN.md, phases 1 to 4, built and verified in one round. DECISIONS.md carries the
rules each piece follows; this is what changed and how it was checked.

## Foundations (phase 1)

- Search boxes keep every letter typed while the server is slow: one shared "last sent" rule in
  `useSearchBox`, used by People, Accounts, Meetings, Enrichment and Campaigns.
- The sort arrow takes focus with an inset ring; no outline escapes the control.
- Sequence steps are dragged by their handle (pointer events, not HTML drag), the editor asks for
  the span in days and shows a day strip; step offsets are calendar days that roll off the weekend
  (migration `calendar_day_offsets`, the default sequence on days 1, 3, 8, 11, 16, 22, 26, 31).
- Two kinds of non-prospect: known non-prospects are blocked on sight with the reason recorded;
  free-mail "companies" are never accounts anywhere. Rules live on Settings > Blocked accounts.
- Record pages render from the cache and never wait for Twenty; the live read streams after paint
  behind a circuit breaker (three failures in five minutes pause it for five). Settings > Twenty
  shows webhooks in the last 24 hours and live-read health.
- The page refreshes on a cheap version poll, only when something changed, never within two
  seconds of a navigation. Layout badge counts are one query.

## Campaigns as work between two dates (phase 2)

- A campaign has a start and an end. The planner simulates every step on the committed load per
  FO and finds the rate that fits; the form shows the capacity line live and refuses a launch
  that cannot finish, with the end date that would. Weekend stacking is why the worked example
  gives 5 a day, not 10.
- Hard stop at the end date ends open enrollments with reason `campaign_ended`.
- Membership is one idea before and after launch: an upcoming campaign shows on its people, their
  accounts and the week's Tasks (Starting soon) from the moment it is created. People are added
  to or removed from a campaign from the People list, a person's page and the campaign page.
- People list: Campaign and Sequence columns, campaign filter, bulk add/remove. Campaigns list:
  Upcoming / Active / Finished with per-tab columns; the campaign page has the window bar,
  in-window replies and meetings, the capacity table and a paginated audience.

## The surfaces (phase 3)

- **Accounts**: "In a campaign" as "3 of 12" with a bar, the campaign filter, and the split of
  people with and without an account (the second opens People).
- **Record pages**: person and account pages carry tabs (Overview, Campaigns, Tasks, Activity,
  Emails, Notes / Meetings), an accent per record, and a dialpad Call link whose target is the
  `clickToCallUrl` setting.
- **Meetings**: silent star, no analysis column in the list and no analysis panel on the page
  until a model is connected, "Fill from link" that resolves direct media and proposes date and
  attendees from the transcript's speakers, one transcript normalisation for the reader and the
  talk-time table.
- **Enrichment**: filters on the record in one row (pod, FO, account, tier, type, product,
  campaign, Twenty tag, gap kind, priority, open or not-found), sort by name, account, gaps or last
  sync; By account and Scorecard views; a selection exported exactly, assigned for research, or
  marked not found (which hides the gap only while it stays empty); email-host suggestions for an
  unlinked account; imports remember the mapping for a file shape. New tables `EnrichmentMark`,
  `EnrichmentSnapshot` (nightly, from the worker) and `EnrichmentMapping`.
- **Reports**: the picture (tiles with deltas and sparklines, funnel, channel bars, leaderboard,
  weekday heatmap, campaigns running, pods against the period before), the table, and one
  self-contained HTML export. Charts follow the data-viz method with a validated palette.
- **Notifications**: a two-note chime on new unread, after the first interaction, with a
  Sound on/off control.

## Speed (C14)

- Record pages no longer wait for Twenty; live reads are after paint.
- People's Twenty tag options come from one `unnest` over the tag column, kept for a minute in
  the server process (`src/lib/people-options.ts`, `src/lib/memo.ts`). Options are the one thing
  cached; no number the page shows is.
- The Accounts list reads only the columns it shows; the cached Twenty record (`raw`) was the
  widest column on the table and was being read for every company on every render. The grouped
  aggregates stay live rather than cached for 30 seconds as the plan allowed: the summary tiles
  read them, and the owner's rule is that every number is live.
- Layout counts are one grouped query; the refresh poll hits `/api/version`.

## Verification

- `pnpm typecheck`, `pnpm lint`, production build pass.
- 57 unit and integration files, 389 tests pass, including: counts agree across pages, non-prospect
  rules, blocked accounts, the capacity planner against its own simulation, the campaign window,
  the fourteen-case stress pass over tasks, campaigns and sequences (which found and fixed the FO
  daily-cap race), media resolution, transcript normalisation, and the enrichment work surface
  (every filter, the scorecard's arithmetic against a snapshot, not-found closing and reopening,
  leader scope on marks, mapping memory), and campaign membership writes (add and remove before
  and after launch, Biz Ops refused, one person in one upcoming campaign, the FO filter on
  upcoming campaigns).
- 72 browser tests pass (`pnpm test:e2e`, serial, one worker), including phase1 (fast typing, sort focus, drag, span, account
  counts, no CRM banner, non-prospect rules) and phase3 (By account, Scorecard, one row of
  filters, export/assign/not found/reopen, exact export of a selection).

## Critics (C16)

Both critics ran on the production screenshots and the code after phase 3; both scored 7/10.
Everything they found that a reader would meet was fixed in the same round and both were run
again: the functional critic scored 8/10 on its second pass, the design critic 7.5 and then 8/10
on its third. The rest is listed with the reason it stays.

**Functional critic - fixed.** Planned touches were "generated" touches (a campaign read "0 of
4" for two people on an eight-step plan); the FO filter emptied the Upcoming tab because an
upcoming campaign has no enrollments; the People filter for a launched campaign still read the
list it launched from, so people skipped at launch showed as members; the account page counted
"in sequence" while the Accounts list counted "in a campaign"; the task brief still dialled
`tel:`; the Starting-soon strip ignored the Tasks pod filter and left out campaigns awaiting
approval; two upcoming campaigns could hold the same person and the second to launch skipped
them silently (`scheduled_elsewhere`); membership writes had no tests
(`tests/campaign-membership-writes.test.ts`: add, remove before and after launch, Biz Ops
refused, the new conflict, the FO filter on upcoming campaigns).

**Functional critic, second pass (8/10) - fixed.** Adding people to an upcoming campaign now
runs the same preview as launch, so somebody promised elsewhere, do-not-contact or in another pod
is refused by name instead of skipped silently on the day; the campaign page counts touches for
the current run only, the way the list does; the brief's phone links open the dialpad beside the
task.

**Functional critic - kept as is.** "Starts per FO per day" stays as an optional ceiling under the
planner (DECISIONS, "A campaign runs between two dates"); lifecycle actions stay on the campaign
page rather than the list; the campaign page's preview messages are the engine's own sentences,
not raw errors.

**Design critic - fixed.** Activity filters were three rows (now one row and a Filters button,
applied on change); ISO dates leaked into the Reports table view and the campaign form; the
sidebar footer truncated the pod; the campaigns list truncated names and the State badge; the
People campaign column truncated (it wraps to two lines); four explanatory sentences (sequence
editor, reports channel aside, campaign form, login); the heatmap coloured cells without a value
and printed white in the series colour; the scorecard was a wall of saturated green (tints only,
values in ink); numbers and count headers were semibold (medium now); product chips on the
campaign form looked like plain text; "1 days"; the sequence editor's width; a duplicate
"Campaigns" heading; the campaign picker's filter names collided with the form's Pod field.

**Design critic, second pass (7.5/10) - fixed.** Colleague titles on the person page sit under
the name instead of truncating beside it; the People list and the account people tab use the one
tier badge; the scorecard's tints tell 100% from 90% from 70%; "1 day" and "1 opportunity"; the
login page carries the wordmark and the headline only; count headers take the header ink; the
campaign picker's tier, type, product and tag filters sit behind Filters; the sequence editor is
as wide as its header band, its day cells keep one width and the week labels sit clear of the
border; the Accounts PODs column has room for a pod's name beside its "+N".

**Design critic, third pass (8/10) - fixed.** "1 day" in the editor header; the campaign picker's
filters fit one row; the day strip's week labels have their own room; the Home tile no longer
carries a fixed sentence when only overdue work is left. Still open, small: the task "More"
panel's select widths, the Home team table's uppercase headers, an email address breaking
mid-domain in the task rail, and the two-line "People at account" header.

**Design critic - kept as is.** Native date inputs render in the browser's locale, which the
runner sets to en-US; a custom picker is a separate piece of work. Outbound emails are red and
inbound green because the owner asked for exactly that. The tier and the list category are two
kinds of tag, each shown once before "+N" for the rest. The record pages keep the section title
as the page heading with the record's name in its header, as every record page has. Record
accents were asked for.

## Live walk of the hosted build - 18 September 2026

With the four seats the owner supplied (Admin, Pod Manager, Biz Ops, Junior FO), `pnpm live:check`
opened sixteen routes as each: every route answered 200, no page errors, no console errors, no
failed responses. The reader's own comparisons (`scripts/live-numbers.ts`, `scripts/live-audit.ts`):

- Alyssa's Home tile says **245** people and the People list it opens says **245** (the 246/245
  disagreement is gone). The admin sees 8,089 people in People.
- Accounts: 4,924 accounts in view; 3,671 people with an account; 4,420 without - which summed
  to 8,091 against 8,089 in People. The two were colleagues filed under prospect accounts in
  Twenty; "people at an account" now reads the directory's people, so the two tiles add up to
  People exactly (asserted in `counts-agree.test.ts`). "People without an account" is one rule
  (`peopleWithoutAccountWhere`) shared by the tile and the People filter it opens: no company, or
  a company that is not an account here.
- Typing "Acumen strategy" fast into People, Accounts, Meetings and Enrichment left every letter
  in the box and in the URL.
- The campaign starting Mon 21 Sept shows on Home and on Tasks (with "181 yours" for Alyssa), in
  the People campaign column as "Upcoming", and in the Campaigns Upcoming tab, three days before
  it starts.
- The first person page opened with no CRM banner; the "Acubooth Meeting with Alisa" talk time has
  no "Unknown" and no analysis panel shows.
- Server time (document response) per route as the admin: Home 184 ms, Tasks 147, People 256,
  Meetings 169, Campaigns 179, Sequences 166, Reports 185, Activity 219, Accounts 487,
  Enrichment 877. Enrichment builds the whole queue (7,730 contacts, 4,924 accounts) on each
  request and is the one page over the plan's 300 ms target.
- Settings > Twenty: 8,469 people and 4,950 companies cached, equal to Twenty; continuous sync
  healthy (every 60 s); live reads healthy; last reconcile 11:54 with notes and messages flowing.
  **Webhooks (24 h): none received** - Twenty is not posting to
  `https://cadence.pmx.acumen-strategy.com/api/webhooks/twenty`, so changes arrive on the
  minute-by-minute pass rather than instantly. The webhook needs registering in Twenty (Settings >
  Developers > Webhooks) with the URL above and the HMAC secret.
- Accounts still listed "Microsoftonline" (a Microsoft login domain): the default never-prospect
  and free-mail lists were widened (Microsoft's online, Office and Azure domains; common platforms;
  mail.ru and other free-mail providers). The rule re-scans every company on each sync, and three
  minutes after the deploy the hosted build had blocked 14 more accounts (4,924 -> 4,910),
  "Microsoftonline" among them; their 36 people left the directory (8,089 -> 8,053), and the
  Accounts tiles read 3,633 with an account + 4,420 without = 8,053, exactly the People count.
- Emails and notes for the ten most recently active people (`scripts/live-crm-content.ts`): every
  Emails and Notes tab loaded, paginated where there were more than 25; bodies present. Two
  "Untitled note" bodies showed markdown table pipes from Twenty's summary field, which
  `presentNoteBody` now folds into plain lines. Comparing against Twenty itself needs Twenty
  access; what Cadence shows agrees with the Twenty status card (counts equal, reconcile flowing).
- Webhooks: rather than a URL to type into Twenty, Settings > Twenty now has "Register webhook in
  Twenty", which creates it through Twenty's API with the server's own secret. Pressed on the
  hosted build at 13:42: "Registered. Twenty now posts every change to this Cadence (*.*)."
- The "huge gaps" in emails were signatures laid out as Outlook tables: rows of empty cells and
  paragraphs holding one non-breaking space each, every one a blank line to the reader. The email
  formatter now folds them (`tests/email-signature.test.ts` carries the real shape, from a message
  on the hosted build).
