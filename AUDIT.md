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
| 6 | Accounts showed three companies | Addressed | one bad record no longer aborts the sync; Settings > Twenty shows what could not be cached (`person-cache.ts`, `settings/page.tsx`) |
| 7 | Filters and sorting on Accounts and People | Met | `accounts-query.ts`, `accounts-toolbar.tsx`, `people-toolbar.tsx` |
| 8 | Meetings visible to the team; SharePoint; transcripts in every format, uploadable, following playback | Met | `meetings-query.ts`, `meeting-stage.tsx`, `transcript.ts`, `transcript-input.tsx` |
| 9 | Enrichment: missing-information filters, no priority filter, no city | Met | `enrichment.ts`, `enrichment/page.tsx` |
| 10 | Dry run explained; deletions synced; Sync now; strong search | Met | Status card, `reconcile.ts` deleted-since pass, `sync-now-button.tsx`, `search-terms.ts` |
| 11 | Auto-close from CRM activity; two modules close separately | Met (needs messages/notes reaching Cadence; Settings shows the counts) | `engine/ingest.ts`, INTEGRATION 7b |
| 12 | Clean copy from tokens | Met | `src/lib/sequences/personalize.ts` at task creation |
| 13 | Owner-assigned people to their FO, the rest least-loaded | Already so | `previewEnrollment` OWNER mode, `engine/enrollment.ts` |
| 14 | Powerful people selection for a campaign | Met | `people-picker.tsx`, `actions/people-picker.ts` |
| 15 | Product interest filter on People and Accounts | Met | both toolbars |
| 16 | Quality-of-life pass | Met | suites green: unit, browser, fresh install; screens re-captured |
