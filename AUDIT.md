# Cadence project review

Reviewed 9 September 2026, in two rounds. Round one was a broad code, workflow, design and
local-runtime review. Round two drove the app end to end as each role, then put it in front of three
independent critics — one reading the code for defects, one reading captured screens for design, one
checking the eighteen change requests item by item — and fixed what they found. This records what was
covered and what changed. It is not a certification that every possible defect has been eliminated.

## Product intent

Cadence is a human-operated sales engagement workspace beside Twenty CRM. Twenty supplies people,
companies, ownership, consent and observed activity. Cadence manages campaigns, one editable plan per
sequence, task timing, meetings and reporting. A person performs every email, call and LinkedIn
touch; Cadence says who and when, holds the draft, and records what happened.

## What the second round changed

### Two ways to read another pod's data

- `accountDetail` took a `SessionUser` but used it only to compute a "mine" badge. The account list
  was scoped; the record page was not. Two clicks from any person's company link handed a Junior FO
  every contact, timeline and open task at an account in another pod. It now applies the same scope
  the list uses.
- Meetings were unscoped for reading entirely: the list ran `where: {}` and the record page only
  called `notFound()`, while the write path was carefully pod-scoped. Anyone could open any recording
  and read the full transcript of a prospect conversation from a pod they had no part in.
  `src/lib/meetings-query.ts` now scopes both, and `tests/scope-and-pause.test.ts` holds the line.

### A pause that did not pause

Pausing a campaign paused its enrollments, which stopped *future* step generation and nothing else.
Every open touch stayed in every FO's Today with no marker, and pressing Done still completed the
task, recorded a Touch, and wrote a `[Cadence] Email 2 sent by Alisa` note into the CRM for a
campaign the leader had stopped. Paused work is now held: out of the task lists, refused by
complete/skip/snooze with a readable reason, and still PENDING so resuming releases it with its
schedule intact.

### An opt-out that did not stick

Ending a sequence with "asked not to be contacted" recorded the reason on the enrollment but never
set `optedOut` on the person — so the next campaign's conflict preview saw nothing wrong, re-enrolled
them, and the FO emailed somebody who had asked us to stop. The consequence now outlives the
enrollment, as it always did on the parallel skip path.

### Smaller defects with real consequences

- Jumping a person to another step was a manager action in the markup only; the server action allowed
  any task's own FO, so a Junior FO could cancel five planned touches on a pod-owned prospect.
- The campaign **Note** field was parsed and then dropped on the floor.
- A Sales Leader — the role that approves campaigns — got an empty Home, because two queries tested
  for `isSeniorFo` rather than `isPodLeader`.
- A reply notified Twenty's record owner only, so a round-robin campaign's FO never learned their own
  email had been answered.
- The nightly reconcile the docs have always promised was never wired up: `RECONCILE_HOUR` and
  `CACHE_REFRESH_HOUR` were validated, documented and read by nothing.
- Archiving a sequence a live campaign runs on left that campaign SCHEDULED forever with nothing on
  screen to say why. It is refused now, naming the campaigns.
- A meeting Twenty reports (an opportunity booked against a contact) was filed as a `CALL`, so it
  appeared behind a telephone icon and inflated call-channel counts.
- Opening a task marked its draft unsaved and persisted a copy nobody had edited, which then froze
  that task's message against later edits to the plan.
- A byte-order mark at the head of three source files made the Activity page throw a React hydration
  mismatch on every load. The browser suite now names the route a page error happens on.
- A bounced address and a blank one both read "Email missing", which sends the FO looking for the
  wrong thing.
- A person whose engagement had ended read "No current campaign", hiding the most useful fact about
  them; the overview now leads with the last campaign and how it ended.
- A stale `postmaster.pid` naming a recycled PID made the local launcher refuse to start forever.

### Design

The screens were captured against a workspace with real campaigns, tasks and activity and reviewed
one by one. What changed: the sticky Save bar no longer slices the last step of a sequence; a locked
step says so as state rather than grey small print; sequences and campaigns take an icon instead of a
monogram avatar built from their initials; Twenty's status is four labelled fields rather than a
sentence with two numbers in it; stored dates render one way everywhere; a zero never renders in
success green; the figures on the task list are bold; four task tabs fit a 390px phone; a recording
that fails to load says so and offers the source; empty states name the next step; and the login page
says what the app does instead of carrying four slogans.

### Removed rather than fixed

Five server actions with no caller, the seeded stance fixtures for a relationship map that no longer
exists, and every remaining reference in README, DECISIONS and INTEGRATION to sequence versions, A/B
variants, either/or steps, template variables and the stance chart. The write-back table in
INTEGRATION.md was also wrong: it claimed person and company fields are never written, without
mentioning that an applied Enrichment import writes exactly those.

## Verification

- `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test`: 269 tests across 37 files, on an embedded Postgres 18.
- `pnpm test:e2e`: 45 browser tests, including `e2e/roles.spec.ts`, which drives one full journey per
  role and checks every denial by URL as well as by the missing link — a hidden link is not a
  permission.
- `pnpm test:fresh`: drives the app as a brand-new deployment — one admin, the default sequence,
  nothing worked yet — on its own database and port.
- `pnpm screens`: captures every screen against the sample workspace for design review.

## Known limits

- Meeting analysis and the Cadence AI panels are deliberately unconnected until a model provider is
  implemented; they say so rather than pretending.
- Click-to-call is real but unconfigured out of the box: with no endpoint in Settings the Call button
  is a `tel:` link. See INTEGRATION.md.
- The sample workspace is no longer the default. `SEED_PROFILE=core` and `TWENTY_MODE=graphql`
  are the defaults, the seed refuses to create the first account without a password, and the
  sample data only builds in mock mode - which is where the test suites live. `pnpm db:reset`
  empties a workspace back to that state, and `pnpm test:fresh` drives the app as a new install.

## The owner's requirements, checked

Each of the 21 points from the owner's review, where it lives in the code, and the state on 10 September 2026. "Met" means implemented as asked and covered by a test or a captured screen.

| # | Point | State | Where |
|---|---|---|---|
| 1 | Live numbers read as live, static text light | Met | `Count`, `Stat`, `DataValue`, `N` (`src/components/ui.tsx`, `src/app/(app)/home/page.tsx`); labels `text-ink-400/500`; zero is quiet by rule |
| 2 | Bell is about inbound mail, not tasks | Met | `src/lib/notifications.ts`, `src/components/notifications-bell.tsx` |
| 3 | Tasks per channel, rich text, calls, CRM at hand | Met | `src/components/tasks/task-composer.tsx`, `rich-text-editor.tsx`, `src/lib/actions/calls.ts`, `task-brief.tsx`, `crm-history.tsx` |
| 4 | What is written back to Twenty | Met | `INTEGRATION.md` "What Cadence writes", `src/lib/engine/sync-out.ts`, outbox `sync-retry.ts` |
| 5 | People: no cadence filter, no sync button, campaigns shown, Overview first | Met | `src/components/people/*`, `src/app/(app)/people/[id]/page.tsx` |
| 6 | Accounts: no stance, titles, details as fields | Met | `src/components/accounts/org-tree.tsx`, `src/app/(app)/accounts/[id]/page.tsx` |
| 7 | Enrichment queue and import at scale | Met | `src/lib/enrichment.ts`, `src/app/(app)/enrichment/*` |
| 8 | Meetings: attendees editable, no notes, details as fields | Met | `src/components/meetings/attendee-editor.tsx`, `src/app/(app)/meetings/[id]/page.tsx` |
| 9 | No explanatory subtext, nothing hardcoded that should be live | Met | help sits behind `Info` glyphs (`ui.tsx`); mode strings render only in mock mode |
| 10 | Name and AI feature | Met by decision | name kept "Cadence"; "Cadence AI" (`src/lib/workspace.ts`, `src/components/assistant.tsx`) |
| 11 | Sequences: modular, business days, no versions, locked while in use | Met | `src/components/sequences/sequence-editor.tsx`, `src/lib/engine/clock.ts`, `sequence-plan.ts` (steps drag; modules are added with a button) |
| 12 | Campaigns: no Active column, pause/stop/restart, re-enrol needs approval | Met | `src/lib/engine/campaigns.ts`, `src/lib/actions/campaigns.ts`, `src/app/(app)/campaigns/page.tsx` |
| 13 | Every control has logic behind it | Met | every button is a server action or a real link; `tests/`, `e2e/` |
| 14 | Activity: one type filter incl. LinkedIn, date range, pod dropdown | Met | `src/components/activity/activity-toolbar.tsx` |
| 15 | Reports: date range, no Overdue/Stalled | Met | `src/app/(app)/reports/page.tsx` |
| 16 | Settings: team and pods, roles, no timezone/aliases/caps | Met | `src/components/settings/users-panel.tsx`, `src/lib/actions/users.ts` |
| 17 | Critic loop to 8 | See `DECISIONS.md` and the git log | functional and design reviews, three rounds |
| 18 | Every point checked | This table | |
| 19 | Meeting product tags PHH / Acubooth / Glynac | Met | `src/lib/workspace.ts`, `src/components/meetings/product-tags.tsx` |
| 20 | Enrichment beyond email and phone | Met | `CONTACT_CRITICAL`, `ACCOUNT_USEFUL` incl. AUM (`src/lib/enrichment.ts`) |
| 21 | No over-bolding | Met | one scale: weight marks the primary element only (`src/app/globals.css`, commit `98e7ed4`) |

## The owner's second list, checked (11 September 2026)

| # | Point | State | Where |
|---|---|---|---|
| 1 | Team members never appear as people | Met | `src/lib/people-scope.ts` (login emails and the workspace's domains) |
| 2 | Pod Manager and Biz Ops | Met | `src/lib/auth/rbac.ts` (`isPodManager`, `isBizOps`, `canSeeAllPods`), migration `20260919000000_roles_pod_manager_biz_ops` |
| 3 | Keep non-campaign people in check | Met | a sequence that repeats: `Sequence.repeatEveryDays`, next round in `src/lib/engine/tasks.ts` |
| 4 | Delegate a task to a team member | Met | `src/lib/engine/delegate.ts`, More panel in `task-actions.tsx` |
| 5 | Filters already on for the reader; pod mandatory | Met | `src/lib/default-filters.ts`, `defaultFilters` in rbac; `needsPod` in `actions/users.ts` |
| 6 | Accounts showed three companies | Addressed (11 Sep, second pass) | the sync was all-or-nothing and froze on its first failure; every stage is now independent, pages are Twenty's 60, Settings > Twenty shows Twenty's counts beside the cache with the shortfall in red, and `pnpm sync:diagnose` names the failing listing (`continuous-sync.ts`, `person-cache.ts`, `engine/reconcile.ts`, `scripts/sync-diagnose.ts`) |
| 7 | Filters and sorting on Accounts and People | Met | `accounts-query.ts`, `accounts-toolbar.tsx`, `people-toolbar.tsx` |
| 8 | Meetings visible to the team; SharePoint; transcripts in every format, uploadable, following playback | Met; SharePoint corrected 11 Sep | `meetings-query.ts`, `meeting-stage.tsx`, `transcript.ts`, `transcript-input.tsx`; a SharePoint sharing link refuses to be framed ("refused to connect"), so only the Share > Embed player is framed and a sharing link opens in a new tab with that instruction (`meetings/providers.ts`) |
| 9 | Enrichment: missing-information filters, no priority filter, no city | Met | `enrichment.ts`, `enrichment/page.tsx` |
| 10 | Dry run explained; deletions synced; Sync now; strong search | Met | Status card names the variable (`CADENCE_DRY_RUN`); deletions come across on their own pass every minute and a daily full pass marks anyone Twenty no longer returns as deleted; `sync-now-button.tsx`; `search-terms.ts` |
| 11 | Auto-close from CRM activity; two modules close separately | Met (needs messages/notes reaching Cadence; Settings shows the counts) | `engine/ingest.ts`, INTEGRATION 7b |
| 12 | Clean copy from tokens | Met | `src/lib/sequences/personalize.ts` at task creation |
| 13 | Owner-assigned people to their FO, the rest least-loaded | Already so | `previewEnrollment` OWNER mode, `engine/enrollment.ts` |
| 14 | Powerful people selection for a campaign | Met | `people-picker.tsx`, `actions/people-picker.ts` |
| 15 | Product interest filter on People and Accounts | Met | both toolbars |
| 16 | Quality-of-life pass | Met | suites green: unit, browser, fresh install; screens re-captured |

## Seen on the hosted app (12 September 2026)

Signed in to `cadence.pmx.acumen-strategy.com` as an admin the owner created and walked every
section with `pnpm live:check`, read-only. What the live workspace showed, and what changed:

- **The sync is complete and healthy.** Settings > Twenty: 8,369 of 8,369 people and 4,931 of
  4,931 companies cached, continuous sync healthy, dry run off. The two fixes that got it there
  are both on main: stages that survive a failure (this side) and id-ordered pagination (the
  team's commit; ordering by `updatedAt` had Twenty stop at 530 people).
- **People opened on eighty pages of "(no name)".** Twenty holds hundreds of imported records
  (tag "GHL Exported") with a phone or an address and no name, and an empty name sorts first. A
  `sortName` column, null for the nameless, orders both lists with the nameless last, and a
  nameless person is shown by email or phone rather than a placeholder.
- **Accounts showed 500 rows of "?" and nothing else.** The list took the first 500 companies by
  name, and thousands of companies Twenty created from email domains, nameless and empty, sorted
  ahead of every real account. The list is now every matching company, ranked by people first,
  paged at 100, with a nameless company shown by its domain.
- **Every person record said "CRM temporarily unavailable".** The message hid the cause; the CRM
  tab still had it: `Object noteTarget doesn't have any "personId" field`. Twenty renamed note and
  task targets (`personId` became `targetPersonId`). The client now reads the workspace's field
  names once and uses them for filters, selections and writes, ingestion reads either name, a
  person's tasks are fetched through their target table rather than a relation filter Twenty does
  not support, and an admin sees the underlying error under the message. Until this is deployed,
  no CRM note reaches the person it is about, which is what "nothing auto-completes" looks like.
- **Walked again as Biz Ops and as a junior FO.** Biz Ops sees everything, as designed. The junior
  saw 174 people (the ones assigned to them in Twenty) rather than their pod's 936, and no meetings
  at all: the three meetings belong to the team's own companies, which no pod contact works at, so
  the pod rule hid them from everyone but admins. Juniors now read their pod, and meetings are
  readable by the whole team. The Pod Manager account could not be signed into with the password
  given (the app answers "Email or password is incorrect"); it exists, is enabled and is in the
  Alisa pod, so a password reset from Settings > Team & pods is all it needs.
- **The recording that does not play is a Stream sharing link** (`glynac-my.sharepoint.com/:v:/g/...`).
  SharePoint refuses to show that page inside another site whatever the viewer's sign-in state; the
  Share > Embed link (`_layouts/15/embed.aspx?UniqueId=...`) is the one that plays. The deployed build
  still frames the sharing link; main links out and says which link to paste.
- **Everything else rendered without errors**: no page errors, no console errors, no failed
  requests on any section. Tasks, campaigns and sequences are empty because none have been
  created yet. `pnpm sync:diagnose` now also runs the person-scoped reads that failed here.

## Known flake: an intermittent hydration error on /activity (11 September 2026)

`workspace.spec.ts` "mobile navigation and all main sections fit a phone" collects page errors while
walking every section at a phone viewport, and has twice caught a **React #418** (hydration
mismatch) attributed to `/activity` on a GitHub runner. It has never reproduced on Windows: the
suite passes there against a fresh database, under `TZ=UTC`, and with the persisted database
removed.

Ruled out so far, each by test rather than by argument:

- **Case-sensitive imports** - every relative and aliased import resolves by exact case.
- **Timezone** - the whole suite passes under `TZ=UTC`, which is what the runner uses.
- **Stale local state** - passes against a database initialised from scratch.
- **ICU / CLDR drift** - `formatInstant` uses `en-GB` `month: 'short'`, where CLDR changed September
  from "Sep" to "Sept", so server (Node) and client (Chromium) could disagree. They agree here
  (both "Sept"), and an ICU mismatch would fail *every* September run, while run 4 passed this test.
- **`useSearchParams` without a Suspense boundary** (a Next.js client-render bailout) - none of the
  components that use it render on `/activity`.

So it is genuinely intermittent and unexplained. `retries: 1` on CI stops one blip blocking a push;
Playwright still reports the test as **flaky** rather than passed, so it stays visible. The
underlying hydration error is a real defect and should be chased with a reproduction (a trace from a
failing run) rather than more speculation.

**What the failing run's trace established (11 September 2026, CI run 3, commit `36a0932`).** The
Playwright report kept by the failed run was downloaded and read rather than reasoned about:

- **The attribution is right.** The `/activity` document finished loading, `goto` resolved, and the
  error was reported 16 ms later, while `/activity` was the live document. It is not a late error
  from `/campaigns`.
- **It is a structural mismatch, not a text one.** React 19 throws error 418 with the argument
  `text` when a text node differs and `HTML` when an element is missing, unexpected or of another
  type; this one carries `HTML`. That rules out date and number formatting, which is where the
  earlier hypotheses (timezone, CLDR "Sept") were looking.
- **The data was the same as here.** The feed held 53 rows, and the same 53 render locally from the
  browser-test database.
- **The markup is valid.** The browser's own parse of the server HTML for `/activity` is identical,
  node for node, to the DOM React renders on the client. Whatever hydration tripped over is not
  something the parser rewrote and not something a client render reproduces: the DOM before and
  after React regenerated the tree differ only by Next's route announcer.
- **It does not reproduce here.** Eight loads in development mode and twenty-five in a production
  build, each at 390px under a 6x CPU throttle against that same database, produced no hydration
  message at all.

What is left is the environment: Linux Chromium and Node 20 on a slow two-vCPU runner, with the
HTML arriving in chunks. The test now waits for the network to go idle before judging a route, and
when a page error has been recorded it attaches the server's HTML and the DOM React settled on to
the report, so the next failure carries the two sides of the comparison instead of only the error.
The reproduction scripts live in `.review/` (ignored by git): `repro-db.ts` starts the browser-test
database, `hydration-repro.mjs` loops a route under CPU throttle, `fetch-html.mjs` saves the server
HTML and compares its parse with the live DOM.

Fixed at the same time, and a real test bug rather than a flake: `tasks-ui.spec.ts` "the message is
editable in place" typed into the rich-text editor and then asserted the draft had been kept,
without first checking the keystrokes had landed. On a slower runner the click had not focused the
editor yet, the keystrokes were swallowed, and the failure read as "the draft was not saved" when
nothing had been typed - the subject saved correctly, and the body still held the sequence's own
copy. The test now asserts the text reached the editor before asserting it survived a reload.
