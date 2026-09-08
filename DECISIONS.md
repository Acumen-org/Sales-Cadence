# Decisions and assumptions

Every assumption made while building Cadence, grouped by area. Each entry says what was decided, why, and where to change it.

## Stack and runtime

- **Next.js 15 App Router with server actions, one app for UI and API.** Chosen over Fastify + React so there is one process, one build and one image. Webhooks are route handlers under `src/app/api/webhooks`. The scheduler runs as a separate `worker` container from the same image (`src/worker/index.ts`) so long-running jobs never block requests.
- **Node 20 image, Node 22 tolerated locally.** `engines.node >= 20`. The Docker image is `node:20-bookworm-slim` (Debian, not Alpine) because Prisma's engines are most reliable there; `openssl` is installed explicitly.
- **Prisma 6, not 7/8.** Prisma 7+ removes the Rust engine defaults and requires a `prisma.config.ts` and driver adapters. Pinned to `^6` for stability; the deprecation warning about `package.json#prisma` is expected.
- **Tailwind 3.** Tailwind 4 changed to CSS-first configuration; v3 is what the team is used to and is LTS.
- **Vitest config is `vitest.config.mts`.** Vitest 3 resolves to an ESM-only Vite; a `.ts` config in a CommonJS project fails to load.
- **No icon library or UI kit.** A dozen inline SVG icons (`src/components/icons.tsx`) and Tailwind component classes. Fewer dependencies to break on upgrade.
- **The full `node_modules` ships in the image** (no Next standalone output) because the same image runs `prisma migrate deploy`, the seed (`tsx`) and the worker (`tsx`). Simpler than three images; the size cost is acceptable for an internal tool.

## Data and dates

- **Calendar dates are strings (`YYYY-MM-DD`) in the FO's timezone.** `Enrollment.startDate`, `Task.dueDate`, `Task.plannedDate`, `Task.snoozedTo`. Prisma `@db.Date` returns UTC-midnight `Date` objects that are easy to shift by a day accidentally. `Task.dueAt` is also stored (09:00 local on the due date) for ordering and for Twenty's `dueAt`.
- **One active enrollment per person is enforced twice:** in application logic (with a friendly conflict preview) and by a partial unique index `Enrollment_one_active_per_person` added by hand to the initial migration (Prisma cannot express partial indexes). `ACTIVE` and `PAUSED` both occupy the slot; `REPLIED`, `MEETING`, `COMPLETED`, `EXITED` free it.
- **`Enrollment.currentStep` starts at -1** (nothing generated yet) and equals the index of the latest step whose tasks exist.
- **`Enrollment.sequenceVersionId` is the version of the most recently generated step**, which is what "which version each enrollment is on" shows. Each `Task` also records the version it came from.
- **Steps are JSON on `SequenceVersion`** validated by a zod schema (`src/lib/sequences/steps.ts`). Step and action ids are stable across versions so an enrollment can be mapped into a new version by id (fallback: by index).
- **Person cache (`PersonCache`) is the FK target for enrollments.** People are cached before enrollment (`ensurePeopleCached`), refreshed on webhook and nightly. `raw` keeps the last Twenty payload for debugging.
- **`Touch` table** records every observed or performed touch (email, call, LinkedIn, inbound reply) so "last 5 touches" and "stalled" reports are one indexed query instead of a Twenty round trip.
- **Settings are stored per section** (`twenty`, `matching`, `rules`, `sync`) as JSON rows in `Setting`, validated by zod with defaults in code. Missing rows mean defaults; invalid rows fall back to defaults with a warning.
- **The Twenty API key may live in Settings (plain text in Postgres) or in env.** Env is recommended; Settings exists so an admin can rotate a key without a redeploy. Restrict database access accordingly.

## Auth and roles

- **Email + password, bcrypt (10 rounds), database-backed sessions in an httpOnly cookie (`cadence_session`, 30 days).** A sessions table allows revocation (deactivating a user deletes their sessions). No password reset by email: admins reset passwords in Settings > Users.
- **Middleware only checks cookie presence** (Edge runtime cannot use Prisma); the real lookup happens in the app layout.
- **Roles:** Admin (everything), Senior FO (own pods), Junior FO (own tasks). Pod membership is `UserPod`; a Senior FO may belong to several pods. Junior FOs may snooze only to the next working day; Seniors and Admins can pick any date.
- **A user maps to at most one Twenty workspace member** (`User.twentyMemberId`, unique). `User.aliases` holds extra handles such as `tw_alisa` that appear in note titles produced by telephony tools.

## Twenty facts and mapping

- **All names in `src/lib/twenty/twenty-schema.ts`.** The defaults are the real Acumen workspace, taken from a full export of Alisa's pod (see "The real Twenty mapping" below). `pnpm verify:schema` reports mismatches; every custom field is optional and degrades to null.
- **Note bodies use `bodyV2` `{ markdown }`.** Older Twenty versions used `body`; change `note.body` / `task.body` in the mapping if introspection shows that.
- **Pods = `podOwner` select values.** A pod is created per value (Settings > Users and pods). Which FOs work a pod is Cadence configuration, not Twenty data.
- **Mock fixtures** (`src/lib/twenty/fixtures.ts`): 3 pods, 6 workspace members, 14 companies, 40 people (3 with `dnd = true`), notes in the exact formats `[Email] Outbound email: ...`, `[CALL] Outbound Call by tw_...`, `Call Notes [31-Aug-2026]`, four messages (two outbound, two inbound), one opportunity, three saved views.

## Seed

- **Core profile** creates the default sequence as version 1 exactly as specified and the admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (password set only on first creation).
- **Demo profile** (mock mode only) creates pods Alisa/Leigh/Andrew, six users mapped to the six mock workspace members (`alisa@cadence.local` ... all `password123`; Ria is an Admin, Alisa/Leigh/Andrew Senior FOs, Karson/Daniel Junior FOs) and caches the 40 mock people. Remove `demo` from `SEED_PROFILE` in production.
- **Seeding is idempotent** and safe to run on every start.

## Testing

- **Tests use a real Postgres, not mocks of Prisma.** When `TEST_DATABASE_URL` is unset, `tests/setup/global-setup.ts` boots an embedded Postgres (`embedded-postgres`, no Docker needed) on port 54329 and applies the migrations with `prisma migrate deploy`, so the migration files themselves are exercised.
- **Test files run sequentially** (`fileParallelism: false`) because they share one database; each file truncates tables in `beforeAll`.

## Enrollment engine (phase 2)

- **Steps are generated incrementally, one step ahead.** An enrollment gets its first step immediately. In `shift` mode the next step is generated when every task in the current step is resolved (done or skipped); in `hold` mode also when its planned date arrives, even if the current step is still open. This is what makes "already-generated tasks are untouched, later steps use the new version" well defined.
- **Shift is measured against the step's planned date**, using the local date the last task in the step was resolved. `Enrollment.shiftDays` accumulates; not-yet-generated steps are planned as `start + (day - 1) + shiftDays`, rolled to the next working day. Skipped tasks count as resolved.
- **Caps apply to future dates only.** When a step's planned date is today or later, the whole step (all its actions) moves to the first working day with room under the FO's cap. Overdue plans are left overdue and shown prominently, never rolled or dropped. Snoozed tasks count against their snoozed day.
- **If caps move the first step, the enrollment's start date moves with it**, so day offsets stay relative to the first real touch.
- **Working days and non-working start dates**: a start date on a weekend rolls to the next working day and the preview says so.
- **Version mapping is by stable step id, position as fallback.** After an edit, the next generated step is the one following the current step's id in the active version; `Enrollment.sequenceVersionId` moves to the active version at that moment. Tasks record the version they were generated from.
- **Either/or actions are one task** with `action` (primary) and `altAction`. Completion records `chosenAction`; observed evidence picks the matching side, manual completion lets the FO choose.
- **Evidence is single-use.** `Task.evidenceId` (note:<id>, message:<id>) may complete at most one task and a resolved task is never resolved again, so one event can never advance a step twice.
- **Manual completions create a `Touch`** (`task:<id>`) so the timeline is complete; observed completions get their touch from the ingest pipeline keyed by the Twenty record id.
- **Skips require a reason; snoozes land on the next working day at or after the chosen date and must be in the future.** Junior FOs may only snooze to the next working day (enforced in the actions layer with `nextWorkingDaySnooze`).
- **Pause/resume**: resuming in shift mode adds the paused days to the clock and moves pending tasks to today or later; in hold mode dates stand.
- **Reassign** is allowed only to an active member of the enrollment's pod. Pending tasks move with the enrollment; mirrored Twenty tasks are deleted and recreated because Twenty's assignee is set at creation.
- **FO assignment**: `OWNER` maps the person's Twenty owner to the pod member with that workspace member id, else falls back to the least-loaded pod FO (the "round robin"); `ROUND_ROBIN` always uses least-loaded; `FIXED` is an explicit FO (used by row actions).
- **Daily ramp** (`dailyRampPerFo`) counts enrollments per FO per start date within the campaign and pushes extra people to later working days.
- **People outside the pod** (Twenty `podOwner` differs) are a warning in the preview, not a block: the Senior FO or Admin decided to include them. Enrollments carry the campaign's pod for reporting.
- **Sync out runs after the database transaction**, never inside it, and every failure is logged to `AuditLog` (`sync_failed`) instead of failing the user's action. `TwentyWrite` records each real write; the dry-run wrapper records its own with `dryRun = true`.
- **Completion note titles**: `[Cadence] Email 2 sent by Alisa`, `[Cadence] Call 1 made by Alisa`, `[Cadence] LinkedIn message 2 done by Alisa`. The prefix is configurable (`matching.cadencePrefix`) and is also what stops Cadence's own notes being read as evidence.

## Tasks page and brief (phase 3)

- **Modelled on Outreach's task flow.** List mode: task list on the left, the selected task with big Done / Skip / Snooze buttons in the middle, the brief on the right. Task flow mode (`?mode=flow`) hides the list and shows one task at a time with "n of N" and a Next button; every action navigates to the next task in the current tab. All view state (tab, filters, selected task, mode) lives in the URL so links are shareable and the browser back button works.
- **Tabs are computed on the effective date** (`snoozedTo ?? dueDate`) in the viewer's timezone: Today (= today), Overdue (< today), Upcoming (> today), Done (done or skipped). Overdue counts appear on the tab and as a red banner on every other tab, so overdue work is never out of sight.
- **Scoping follows the roles**: Junior FOs see their own tasks only; Senior FOs see their own plus every task in their pods and get pod/FO filters; Admins see everything. The same predicate (`taskScopeWhere`) is used for lists, counts and the brief, so a URL with someone else's task id shows nothing rather than leaking.
- **The brief is assembled server-side per task**: person fields (email, phone, LinkedIn, where we met, pod, tags), enrollment (sequence + version, campaign, FO, start, clock shift), this step's template filled with the person's and FO's variables (plus the either/or alternative), the last five `Touch` rows, the latest five Twenty notes and open opportunities fetched live (with a warning instead of an error when Twenty is unreachable), colleagues at the company with their enrollment status and FO, and the next step with its planned date.
- **Templates are rendered from the version the task was generated with**, never from the active version, so the FO sees the copy that was in force when the task was created.
- **"Open in Twenty" links to `/object/person/<id>`** on the configured Twenty base URL (Twenty serves app and API from one origin). No link is shown when no base URL is configured (mock mode without `TWENTY_API_URL`).
- **Either/or completion**: a task with an alternative shows two Done buttons, one per channel; the chosen channel is recorded on the task and drives the completion note title.
- **Skip always asks for a reason inline**; Snooze offers the next working day to Junior FOs and a date picker (minimum next working day) to Seniors and Admins. Server actions re-check permissions and the junior restriction; the UI is a convenience, not the guard.

## Ingestion, matching and reconcile (phase 4)

- **One pipeline for webhooks and reconcile.** `ingestEvent` normalises the raw Twenty record (using the field mapping), stores it in `ActivityEvent` with `dedupeKey = objectType:recordId:updatedAt` (falling back to the event name when there is no `updatedAt`), then processes it. Duplicates (Twenty retries, overlapping reconcile scans) are answered with `duplicate` and never processed twice. A failed event keeps its payload, gets `needsReview = true` and shows in Settings > Twenty.
- **Processing is idempotent by construction**, not by luck: evidence ids are single-use, resolved tasks are never re-resolved, and `markReplied` / `markMeeting` / `exitEnrollment` are no-ops once the state is reached. This is what makes "a step can never advance twice from one event" hold even if the dedupe layer were bypassed.
- **Evidence ids are per person**: `note:<id>:person:<pid>`, `message:<id>:person:<pid>`. One email cc'd to two enrolled people completes a task for each; the same note about one person can only ever complete one task.
- **Which task does evidence complete?** The earliest pending task on the person's *active* enrollment whose `action` or `altAction` matches the evidence channel (email evidence completes EMAIL tasks, call evidence completes CALL tasks), regardless of whether it is due today or later. An ad-hoc email therefore completes the next email step early; that is intended, because the touch happened.
- **Only the enrollment's FO completes tasks.** Outbound activity by anyone else is recorded as a `Touch` (so the brief shows it) and reported as `ignored_non_fo`. Paused enrollments do not accept completions.
- **Actor resolution for notes**: `createdBy.workspaceMemberId` first, then the `(?<actor>...)` handle from the title (matched against `User.aliases`, `tw_<firstname>`, or the email local part), then the creator's display name. Unknown actors are recorded as touches and flagged for review, never guessed.
- **Message direction**: outbound when the `from` participant is one of our users (workspace member id, or the handle equals a user's email); inbound when it is a person (participant `personId`, else the handle matched against cached emails). Anything else is ignored. `messageParticipant` events re-fetch the whole message so partial participant sets converge; re-processing is harmless.
- **LinkedIn is never inferred.** Even a note titled about LinkedIn only produces a touch; LinkedIn actions complete when the FO clicks Done.
- **Stale evidence** older than `enrollment.createdAt - evidenceGraceDays` (default 1 day) is a touch, not a completion, so a 30-day reconcile cannot complete steps with pre-enrollment emails.
- **Cadence's own notes** (title starts with `matching.cadencePrefix`, default `[Cadence]`) are ignored on the way back in.
- **Mirrored Twenty tasks**: a Twenty `task.updated` whose id is a mirrored task and whose status is the configured "done" value completes the Cadence task with source `OBSERVED_TWENTY_TASK`; deleting a mirrored task in Twenty just unlinks it. Tasks Cadence did not create are ignored.
- **Meetings** come from `opportunity.created` (point of contact enrolled, including already-replied enrollments) and from `person.meetingTime` being set, which is what the scheduler writes. Both are settings. The evidence id carries the meeting timestamp, so a rebooking counts again while the same booking never counts twice.
- **Company reply rule** (`companyReplyPausesColleagues`, default off): a reply pauses other ACTIVE enrollments at the same company with `pauseReason colleague_replied:<personId>`; a Senior FO resumes them by hand.
- **Webhook security**: HMAC-SHA256 signature over `timestamp:body` (`X-Twenty-Webhook-Signature` / `X-Twenty-Webhook-Timestamp`, plain body HMAC accepted as fallback) when `TWENTY_WEBHOOK_SECRET` is set; otherwise a shared `?token=` when `CADENCE_WEBHOOK_TOKEN` is set; otherwise open (private network only). Payload parsing accepts `eventName`/`eventType`, `record`/`data`, and `objectMetadata.nameSingular`.
- **Reconcile** refreshes the person cache first (so dnd flips and new people are known), then replays notes, messages, opportunities and tasks updated in the window through the same pipeline with `source = RECONCILE`. It runs nightly in the worker at `RECONCILE_HOUR`, on demand from Settings > Twenty, and from `pnpm reconcile [days]`.
- **Worker cadence**: scheduler tick every `WORKER_TICK_SECONDS` (default 5 minutes), nightly reconcile and cache refresh at fixed server-local hours, hourly session purge. The worker imports nothing from `next/*` so it runs under plain `tsx`.

## Sequences, Campaigns, People, Reports, Settings pages (phase 5)

- **Sequence editor saves whole versions.** The editor works on a copy of the active version's steps; saving validates (ascending days, unique ids, no same-type either/or, only known template variables) and creates version n+1, which becomes active immediately. Step and action ids survive edits (only new steps get new ids), so enrollments map by id. Reordering swaps positions but keeps the day column ascending. Saving an unchanged plan is refused rather than creating an empty version.
- **Per-step funnel counts** (Sequences and Campaigns): *active* = enrollments whose latest generated step is this one; *done* = enrollments with at least one DONE task on the step; *replied* / *meeting* = status reached while on this step; *skipped* = skipped tasks, with *bounced* counting skip reasons that mention bounce, undeliverable, wrong address/number or invalid (Cadence does not send email, so bounces are only known when an FO records them); *overdue* = pending tasks past their day.
- **Campaign creation is two-phase**: Preview (never writes, shows candidates with their FO and start date, and every conflict with its reason) then Create. Sources: pasted ids (any separators, several per line), CSV (parsed in the browser, only ids are sent; the column named id/personId or the first column), or a saved Twenty view resolved through the client. The campaign is created ACTIVE and people are enrolled at once; the conflicts list is the same one the preview showed.
- **Campaign pause / resume / stop** act on the enrollments: pause pauses every ACTIVE enrollment with reason `campaign_paused`, resume resumes exactly those, stop exits everyone still open with `campaign_stopped`. Individual pauses made by hand are left alone by a campaign resume.
- **Re-enrol non-repliers** creates a *new* campaign in the same pod (source "re-enrol non-repliers of X") for people whose enrollment COMPLETED at least N days ago with no reply or meeting, who are not enrolled elsewhere and not dnd. They keep their previous FO. It is a manual, previewed action rather than an automatic rule so a human decides when the follow-up starts.
- **People page** reads only the cache: name/company/email/title search, pod and status filters, 100 per page, last touch from `Touch`, enrollment status from the latest enrollment. Row actions: Enrol (sequence, pod defaulted from the person's `podOwner`, FO auto or fixed, optional start date) and Exit. Juniors see the list read-only.
- **Reports** roll up enrollments and tasks by pod, FO, campaign, sequence and channel. Reply rate = (replied + meetings) / (enrolled - exited); meeting rate = meetings / (enrolled - exited). Channel report splits DONE into observed-in-Twenty vs marked-manually so the team can see how much is being tracked automatically. Overdue and stalled lists are capped at 200 rows. "Stalled" = active enrollment with no touch in N days as of the report date (or no touch at all and enrolled more than N days ago). Admins see everything, Senior FOs their pods (plus anything assigned to them), Junior FOs only themselves (they are not offered the page).
- **Settings are fully editable**: Twenty connection (base URL, API key stored in the database only when entered, JSON field-mapping overrides with the defaults shown for reference), matching regexes (validated as regular expressions on save), rules (cap, clock mode, working days, meeting detection, colleague rule, stalled and reconcile windows, default ramp), sync toggles, users and pods, plus an activity log of inbound events (with "mark reviewed") and outbound writes (dry-run flagged).

## Real Twenty client, verify:schema, dry run (phase 6)

- **GraphQL only, one file.** `src/lib/twenty/graphql-client.ts` holds every query and mutation. Twenty's REST API is not used: GraphQL lets the selection set follow the field mapping and one code path serves list, get-by-id and relation lifts.
- **Selections are trimmed to fields that exist.** On first use the client introspects each type (`__type { fields { name } }`) and drops optional custom fields that the workspace does not have, so a missing `salesCallRecordingLink` or `cadenceTaskId` becomes `null` instead of breaking every query. If introspection is disabled the full mapping is used and `verify:schema` is the only safety net. Results are cached per client instance; the client is rebuilt when the mapping or connection changes.
- **Relation lifts instead of relation filters.** Notes and messages for one person are fetched through `noteTargets(filter: { personId })` and `messageParticipants(filter: { personId })` and lifted to their parent record (messages deduplicated), because filtering a parent by a one-to-many child is not reliable across Twenty versions. Tasks use `taskTargets: { some: ... }`.
- **Reconcile windows** use `updatedAt >= since` for people, notes, opportunities and tasks, and `receivedAt >= since OR createdAt >= since` for messages, because mailbox sync can import old messages late.
- **Deleted people** are only returned when asked (`includeDeleted`), via an `or` on `deletedAt is NULL / NOT_NULL`, matching Twenty's soft-delete default.
- **Mutations**: `createNote` + `createNoteTarget`, `createTask` + `createTaskTarget`, `updateTask`, `deleteTask`. Rich text is sent as `{ markdown }` when the mapped body field ends in `V2`, else as a plain string (legacy `body`). Ids are `UUID` typed variables.
- **Saved Twenty views** are read from the core `views` query with their `viewFilters`, field ids are resolved through the metadata API, and simple operands (is, isNot, contains, doesNotContain, isEmpty, isNotEmpty, greater/less than, before/after) are translated to GraphQL filters. Anything else fails with a clear message suggesting to paste ids instead; the view feature is best-effort and depends on the Twenty version.
- **Introspection prefers the metadata API** (`/metadata` `objects { fields { name type options } }`) because it exposes select option values (needed for `podOwner` and `task.status`), with GraphQL `__type` introspection as the fallback.
- **`pnpm verify:schema`** compares every mapped object and field with the live workspace, distinguishes required from optional fields (every custom person field, `cadenceTaskId`, `city`, `timeZone`, message `text` and `messageThreadId` are optional), prints `podOwner` options against configured pods, every mapped select's options against the values the mapping expects, and `task.status` options against the mapping, runs a one-person smoke query, and exits 1 only when something required is missing.
- **Transport**: `fetch` with a 20 s timeout, one retry on network errors and 5xx, readable `TwentyApiError`s carrying HTTP status and GraphQL errors. The `fetch` implementation is injectable so the client is unit-tested against a fake Twenty without a server.
- **Dry run** is implemented once, as a wrapper around any client (`DryRunTwentyClient`): reads pass through, writes are logged to the console and to `TwentyWrite` with `dryRun = true`, fake ids (`dry-note-...`, `dry-task-...`) flow back so the engine behaves exactly as in production.
- **Ping** lists workspace members, which needs nothing but a valid API key and confirms both the URL and the key.

## Outreach parity (round 2)

Sources checked: Outreach support articles on sequence states, manual prospect actions, task management, call dispositions and A/B testing (see the commit message for links). What was adopted, and how it maps onto "humans do every touch":

- **Task types as buckets.** Tasks filter by Calls / Emails / LinkedIn (Outreach's task categories) with counts per bucket; Home shows today's work per bucket with a "Start" that opens the task flow for that type.
- **Calls need a disposition.** Outreach does not count a call as complete without one. `settings.rules.callDispositions` (editable) map to Answered / Not answered; an answered disposition counts as a reply and finishes the sequence when `answeredCallIsReply` is on (Outreach: "replies apply to ... a call logged with a disposition mapped to Answered"). "Wrong number" flags the phone as bad data. Call notes are stored on the task and written into the Twenty note (`[Cadence] Call 1 made by Alisa - Left voicemail`).
- **Skip reasons with consequences.** Outreach has Bounced / Opted Out states and Finish actions. Cadence offers configurable skip reasons; some end the enrollment (bounced, not interested, opted out, bad data) and flag the person (`badEmail`, `badPhone`, `optedOut`). `exitOnBounce` is a rule. Opted-out people can never be enrolled again from Cadence; Twenty's `dnd` is still the record and is never written by Cadence.
- **Finish (Replied) / Finish (No Reply) / Pause / Move to step / Remove** are available from the task flow overflow and the person page, matching Outreach's manual sequence actions. Move to step cancels the current step's pending tasks and generates the target step due now (never retroactively overdue).
- **Bulk actions** (mark done, skip, snooze, reassign) on the task list, Outreach style. Bulk-completing calls requires one outcome for all selected calls.
- **A/B templates** on email actions: variants get balanced random assignment at task creation (Outreach randomises then evens out); a disabled variant stops receiving new tasks but existing tasks keep theirs; per-variant stats attribute a reply to the last email variant sent before it. No automatic winner, as in Outreach.
- **Status wording** follows Outreach: Active, Paused, Finished (Replied), Finished (No reply), Bounced, Opted out, Do not contact, Removed. Prospect **stages** are derived, not stored: Cold, Approaching, Replied, Meeting booked, Unresponsive, Bad data, Do not contact.
- **Keyboard shortcuts** in the task flow (D, S, Z, N/P, C, O, M, 1-9 for outcomes, Enter, Esc). Digits are ignored while typing in the notes box on purpose. Outreach's own shortcuts are mostly global (search, compose); the task-flow keys are ours.
- **Not adopted**: automatic email sending, mailbox assignment, snippets library, task priorities, triggers, out-of-office auto-pause, sequential dialing. Either they need sending, or they add little for a human-executed cadence.

## QA round: what the tests found

- **ESLint** (`pnpm lint`, Next core-web-vitals + TypeScript) added; the codebase is clean.
- **Playwright end-to-end** (`pnpm test:e2e`) drives the production build through the launcher on a fresh embedded database: demo sign-in, campaign creation with conflict preview, the whole task flow (done, log a call with an outcome, skip with a bounce), answered call finishing as replied, sequence editing to a new version, settings save, role restrictions, reports and people pages.
- Bugs found by the browser tests and fixed:
  - `Field` rendered labels with no association to their controls (accessibility defect); now `htmlFor` + `useId`.
  - The Tasks page passed a function to a client component, which Next.js rejects at runtime; the task list crashed. Replaced with a URL template.
  - At 1280px the three-column task layout squeezed the task card to a sliver and the outcome buttons overlapped. The brief now drops below the card until 1536px and the outcome grid sizes by container.
  - Confirmation messages disappeared when the completed task left the list (page re-rendered to the empty state). Confirmations now travel in the URL (`?flash=`) and render as a notice.
  - **Stale settings after save**: the in-process settings cache lived in module scope; Next.js instantiates page and server-action bundles separately, so invalidation from the action never reached the page. The cache now lives on `globalThis`, the same fix Prisma clients use. The Twenty client cache was moved for the same reason.
  - Keyboard `D` on an either/or task opened the overflow menu instead of completing the primary action.
- Process hygiene: the launcher now spawns Node directly (no shell wrapper) so stopping it reliably kills the web, worker and database; `DEV_DB_DIR` lets tests use an isolated database directory.

## Dummy data, pods that follow Twenty, instant sync (round 3)

- **One dummy dataset for everything.** The mock workspace the app runs against (`src/lib/twenty/demo-fixtures.ts`) is now deliberately small and obviously fake: two pods (Alisa's pod, Andrew's pod), three "Dummy Company" records, twelve "Dummy One..Twelve" people (one dnd, one whose pod value has no pod yet), one user per role, and activity in every Twenty shape. The `demo` seed profile also creates a campaign per pod and drives enrollments into every state (active, overdue, replied, bounced, finished, meeting) by replaying the dummy activity through the real ingestion pipeline. `demo-basic` seeds the same without campaigns (used by the browser tests). The larger fixture set the unit tests were written against is kept as the `test` dataset (`MOCK_DATASET=test`, set by the test setup) so the suite did not have to be rewritten.
- **Pods are keyed by Twenty's `podOwner` value and follow Twenty.** Three paths keep them aligned: (1) a person arriving (webhook, cache refresh, view import) with an unknown value creates the pod immediately, marked "discovered from Twenty", so nothing is lost; (2) `syncPodsFromTwenty` reads the `podOwner` select options from the metadata API and creates or renames pods (option label -> pod name, value stays the key), on every cache refresh, nightly, and from the "Sync pods from Twenty" button; (3) Cadence never deletes a pod on its own, so an option removed in Twenty leaves an empty pod for the admin to retire. Renaming an option's *label* in Twenty renames the pod here; changing the *value* (deleting and re-creating the option) creates a new pod and the old one empties out, because the value is what is stored on each person.
- **Admins own who uses the platform and who works which pod**; Twenty owns which pod a *person* is in. Enrollments keep the pod of the campaign they were created in, so reports stay stable if a person is moved between pods mid-sequence; the People page always shows the current pod from Twenty.
- **Instant sync, both directions.** Inbound: webhooks are processed the moment Twenty sends them; the nightly reconcile is only a safety net. Opening a person page re-reads that person from Twenty and refreshes the cache before rendering, so an edit made in the CRM seconds ago is visible without waiting for a webhook. Admins also get a "Sync from Twenty" button on People. Outbound: every write happens synchronously right after the database change that caused it, not on a timer.
- **What Cadence writes to Twenty, exhaustively**: (a) one activity Note on the person for every completed action, titled `[Cadence] Email 2 sent by Alisa` / `[Cadence] Call 1 made by Alisa - Left voicemail`, body with sequence, step, outcome and the FO's notes; (b) optionally a Twenty Task per open Cadence task (`Cadence: Email 1 - Dummy One`, assigned to the FO, due on the task day), updated to done or deleted when the Cadence task resolves. Nothing else: Cadence never edits person, company or opportunity fields, never sets `dnd` or `podOwner`, never touches notes or tasks it did not create. Its own opt-out and bad-data flags are local. Every write is logged in Settings > Activity log, and `CADENCE_DRY_RUN=true` turns all of them into log entries only.
- **Home for Senior FOs shows the pod's replies and meetings**, not only their own, because seniors work their juniors' tasks; the browser tests caught this.

## Visual design: matching Outreach (round 4)

Reworked from an Outreach list-view screenshot supplied by the team, as a design *system* rather than page-by-page restyling:

- **Palette and canvas.** Lavender page canvas (`#f3f4fa`), indigo primary (`brand-600 #5b5fd6`), soft-indigo pills (`brand-50/100`), `ink-*` neutrals that are warmer than Tailwind's slate, and a single `line` border colour. Content sits on white `surface` cards (18px radius, 1px border, soft double shadow). The old Tailwind slate palette was swept out of every file so nothing looks half-migrated.
- **Chrome.** A pale rail (`#fbfbfe`) with a round indigo logo, 10px-radius nav items and a soft-indigo active pill; a top bar carrying the section title, a utility icon cluster, the section's primary action and a bolt that starts the task flow. The section title lives in the top bar and each screen carries a contextual view header inside its surface, which is exactly how the reference separates "Accounts" from "Demo Acct View".
- **Table language.** 13.5px rows, muted 12px headers, hairline separators, hover tint, initials avatars (rounded square for records, circle for people), two-line identity cells, dot-prefixed status badges, and a right-sticky action column so it never clips on narrow windows.
- **New primitives** in `ui.tsx`: `Surface`, `ViewHeader`, `Toolbar`, `Avatar`, `IdentityCell`, `StatusDot`, `DotTimeline`, `RecordHeader`, plus `chip` / `chip-muted` / `btn-icon` classes. `DotTimeline` is the reference's activity sparkline: a hairline with outbound touches above and inbound replies below, positioned by time over 30 days. It appears on People rows and in the task brief.
- **Global search** (magnifier, Ctrl+K) over people, campaigns and sequences, with arrow-key selection. The help icon shows the task-flow shortcut list.
- **Fonts** stay on the system stack (Inter first if installed). No webfont download, so the app still works offline and on an air-gapped server.
- **Verification is visual, not assumed.** `pnpm screens` builds the app, seeds the dummy workspace and captures every screen to `.screens/` with Playwright; the layout problems fixed this round were all found by looking at those captures: a three-pane task layout that crushed the middle pane at 1280px, badges wrapping onto two lines, a clipped row-action column, a duplicated "start task flow" button, the template shown twice (task pane and brief), and raw audit JSON leaking into the person timeline (now formatted in plain language by `audit-format.ts`).
- **Demo data**: each pod now has an established campaign (a week old, so Overdue and mid-sequence states exist) *and* one starting today, so the Tasks screen every FO opens is never empty. Four more dummy people were added for the fresh campaigns.

## Meetings, accounts, activity, and a 1-CPU budget (round 5)

### Meetings and the analysis seam

- **What can actually be played inside the app** decided the design, rather than a promise of "plays everything". `src/lib/meetings/providers.ts` classifies a pasted link: a direct media file (`.mp4`, `.webm`, ...) plays in a `<video>` element that Cadence controls; SharePoint / OneDrive / Microsoft Stream (where Teams recordings land) and Google Drive (where Meet recordings land) allow framing, so they are embedded, with `embed=true&nav=false` added for the SharePoint player; Zoom's recording pages send `X-Frame-Options`, so they open in a new tab; Teams and Meet *join* links are not recordings at all. Each case renders with the reason on screen, so nobody is left staring at a blank frame wondering what broke.
- **Transcripts are parsed, not just displayed.** One parser handles WebVTT, SRT and plain text, including the `<v Speaker>` voice spans Teams writes, the numbered blocks SRT uses, and the `[00:01:02] Name:` lines people paste from Zoom or Otter. Consecutive cues from the same speaker are merged so the panel reads as a conversation. When Cadence owns the player, clicking a line seeks to it and the current line highlights as it plays.
- **Analysis is an interface with nothing behind it yet, on purpose.** `MeetingAnalysis` is a defined shape (outcome, key points with timestamps, next steps, open questions, risks, competitors mentioned, sentiment, talk-time share, free-form sections, model name, confidence) and `MeetingAnalyzer` is a two-method interface. The only implementation today is `LocalStatsAnalyzer`, which computes talk-time share from the transcript and nothing else. The panel says so and lists what will appear when a model is connected. Wiring an open model later means writing one class and calling `setMeetingAnalyzer`; no page, action or table changes.
- **Analysis is never triggered by a page load.** It runs from a button and stores its result, because a model call is slow and may cost money. A changed transcript clears the stored analysis rather than leaving a stale one attached.
- **A meeting is Cadence's own record, not a Twenty object.** Twenty has no recording object to sync, and inventing one would put Cadence in charge of data the CRM cannot see. Meetings link to a cached company so they appear on the account timeline, and attendees link to cached people and to Cadence users where the address matches.

### Accounts and the relationship map

- **An account is a Twenty company; the relationship layer is Cadence's.** Who reports to whom (`reportsToId`), each contact's stance (`accountRole`: champion / supporter / neutral / detractor / unknown) and a free note are stored on the cached person and never written back, because Twenty has no field for them and guessing one would corrupt the CRM. A refresh from Twenty leaves them alone.
- **The chart is always a forest, so nobody vanishes.** A manager who is not in this account, is the person themselves, or would close a loop is treated as "no manager", and only the edge that closes a loop is cut - the branch under it keeps its shape. Roots with nobody under them are listed separately as "unplaced" so a chart of twenty singletons does not look like an org structure. The save action refuses a loop up front with a plain message.
- **One timeline per account, merged from four sources**: touches (emails, calls, LinkedIn), meetings, completed tasks and sequence state changes, all rendered in the same plain language as the person timeline and the activity feed.

### Activity

- **Two sources, one feed**: the audit log (who changed what) and touches (what was actually sent or received). Administration is excluded by design - settings changes, user and pod management, and logins - because the section answers "what is the team doing", and a settings edit is not outreach.
- **The cursor carries the last row's id, not just a timestamp.** Seeded and imported rows routinely share a timestamp; a timestamp-only cursor with `<` silently drops every other row on that second. The cursor is `<instant>|<id>`, the query is inclusive, and the page resumes after that exact row.

### Per-user views

- **Ownership means two things and both count.** An account is "mine" if I own it in Twenty *or* I work anyone in it; a relationship is "mine" if I own the person in Twenty *or* I am the FO on their enrollment. Owning an account with nobody in it still counts as an account. Home tiles, the Accounts "Mine" filter and People `owner=mine` all use the same definition.

### Home

- **The greeting uses the signed-in user's first name**, and the date-plus-counts line is gone: the counts are in the tiles below it, and repeating them in prose was noise.
- **Weeks run Sunday to Saturday in the user's own timezone**, everywhere. `weekRange` is the single implementation, so the two week boxes and the team table cannot disagree.
- **"Replies this week" means inbound email that Twenty synced** for people the signed-in user is responsible for - which is what "someone assigned to a BD replied" looks like once it reaches the CRM. It is not the same as the team table's Replies column, which counts enrollments the FO finished as replied (an answered call counts there, and it is their number to hit).
- **"Meetings booked this week" is decided by attendee domains.** A meeting counts when somebody outside our own domains attended; the domain list (`acumen-strategy.com`, `prairie-hill.com`, `glynac.ai`, `acubooth.com`) is an admin setting, and it is re-applied on read, so editing it is retroactive in both directions. The stored per-attendee flag is only a cache, used when an attendee was recorded by name with no address. Sequence-detected meetings (an opportunity or `meetingTime` in Twenty) are included alongside recorded ones.
- **Each week box shows only the latest row**, with the count on an arrow into the full list, because the point of the box is "is there something waiting", not a second inbox.
- **The utility icon cluster now appears only on Tasks.** Search, notifications and the channel shortcuts exist for working through the day; on every other section they were decoration. The help button stays everywhere (Ctrl+K still opens search from any page). Both primary buttons were removed from the chrome: the section's own action lives inside its view header, where the Outreach reference puts it.

### Running on one CPU and under 2 GB

- **Measured, not asserted.** Idle with the demo workspace: ~370 MB across web, worker and Postgres. After 200 page renders: 2.3 s of CPU in total, about 11 ms per render, and warm renders of 8-75 ms. On a 1 vCPU box that is roughly 90 renders a second of headroom.
- **A query budget is enforced by a test.** `tests/query-budget.test.ts` counts the statements each page issues, then triples the data and requires the count not to move: home 19, account detail 17, accounts list 7, tasks 6, activity 6, ownership tiles 3, unchanged at 3x the rows. That is what stops a per-row lookup creeping back in.
- **The optimisations that mattered** were structural, not micro: Home's nine per-channel counts became one indexed read bucketed in memory; the team table went from five queries per FO to four grouped queries for the whole team; the accounts list aggregates in four `groupBy`s plus one raw query for last touch; the activity feed resolves audit subjects in six batched lookups instead of one per row.
- **Prisma's default pool is the biggest footprint trap.** It is `cores * 2 + 1`, so on a developer machine a single-user app opened 22 Postgres backends (176 MB of private memory). The launcher and Compose now set `connection_limit` explicitly - 6 for the web app, 3-4 for the worker - which cut it to 8 backends and 84 MB.
- **Postgres is tuned small** in Compose (`shared_buffers=192MB`, `work_mem=8MB`, `effective_cache_size=512MB`, `jit=off`, `max_connections=40`), and both Node processes get hard heap ceilings (512 MB web, 320 MB worker). JIT off matters: on a 1-vCPU box it costs more to compile a plan than to run it.
- **The build is the memory peak, not the app.** `next build` is capped to one worker thread with a 1536 MB heap, and type checking is done by `pnpm typecheck` / CI rather than inside the build, where it roughly doubles peak memory. The Dockerfile prunes to production dependencies afterwards and then asserts that what the entrypoint needs (Next, Prisma, tsx, the build id) actually survived the prune.

### Postgres 18 and Twenty 1.23

- **Postgres 18 is verified, not assumed**: the whole suite runs against an embedded PostgreSQL 18.4, and Compose pins `postgres:18-alpine`. Nothing in the schema or queries uses anything newer than PG 14 features, so 16 and 17 also work.
- **Twenty 1.23** is what the GraphQL client and the metadata introspection were written against. `pnpm verify:schema` reads the live workspace and reports any field in `twenty-schema.ts` that does not exist, before anything is written.
- **Company changes now sync instantly too.** A `company.*` webhook updates the account cache immediately (name, owner, industry, size, city, LinkedIn), so renaming a firm in Twenty is reflected here at once rather than at the nightly refresh; deletion tombstones the account instead of dropping its history.

### What the tests found this round

Every item here was a real defect caught by a new test or by reading the captured screens, not a hypothetical:

- The generated migration for this round had Prisma's `package.json#prisma is deprecated` warning captured at the top of the SQL file, because it was produced by redirecting `migrate diff` to a file. Every fresh deploy would have failed on `syntax error at or near "warn"`.
- The transcript parser dropped the speaker for every WebVTT cue: the pattern required a `Name:` prefix even when a `<v Name>` span was present, so nothing merged and talk-time was all "Unknown". Single-letter speaker labels were also rejected.
- `buildOrgTree` detached whole branches on any cycle (walking up from the node itself, so anyone below a loop lost their parent), and left a person with a dangling manager as a lone root instead of listing them as unplaced.
- `display: contents` on the fieldset inside `ActionForm` silently cancelled every `space-y-*` on the form, because the fieldset was the form's only child. Every settings form was rendering with no gaps between fields.
- Re-checking attendee externality with `stored || computed` made the domain setting retroactive in one direction only: adding a domain could never *remove* a meeting from the count.
- Initials for a name like "Company B - discovery (scheduled)" came out as "D(" because punctuation counted as a word.
- The relationship editor's labels were not associated with their controls.

## Home and the task screen, reworked (round 6)

### Home

- **The two "this week" boxes are gone.** They repeated what the team board already reports and what the Meetings section lists, and on a screen whose job is "what do I do now" a second inbox is a distraction. The `/replies` page existed only to serve one of those boxes' arrows, so it went with them, along with `repliesThisWeek` and `meetingsThisWeek`: an unreachable page and two unused queries are worse than none. The domain-based definition of a booked meeting still lives in the Meetings section and its "This week" filter.
- **The team table became a board.** A grid of six raw numbers per person could not be read at a glance. Each row now puts the work owed on the left (due today, overdue, with a dash rather than a zero so the eye skips what is fine), a bar for what has actually been finished this week, and the outcomes on the right. The bar is scaled to the busiest person in the pod, because the only useful comparison when scanning for who needs help is against each other, not against a target nobody set. Columns have explicit widths so the figures stay in a block and the name column absorbs the slack, and a total row closes it off.

### The task screen

- **The overdue banner is gone.** It repeated a number the Overdue tab already carries and pushed the work down the page every time anything was late.
- **One row of controls, one panel slot.** Done, Skip, Snooze, Twenty, More, then Previous and Next. Every panel (call outcome, skip reason, snooze date, the overflow) opens in the same place beneath that row, so opening one never moves the others. More is a fixed-width button that reads "Less" while its panel is open: same button, same position, and a test asserts the position does not move.
- **The shortcut list under the buttons is gone.** Nine key hints in permanent 11px grey text taught nobody anything; the shortcuts still work and the help button still lists them.
- **"Finished (Replied)", "Finished (No reply)", Pause and Remove became one question.** Four buttons whose names described their internal effect are now "End the sequence" with a reason: they replied, ran its course, not interested, asked not to be contacted, wrong details, another reason. The first two finish the enrollment (a reply is credited to the person and the FO), the rest exit it with that reason. Each choice explains itself under the dropdown. **Pause was removed outright** from the task screen: an FO working today's list has no use for "suspend this whole sequence and come back to it", and it is still available where it belongs, on the person and the campaign.
- **"Move to step" is one control.** A select and a button that looked like two unrelated things are now a single bordered group, the button joined to the select, focus ring around the pair. Its confirmation says "Moved to step 3." and nothing else; the trailing "2 tasks due now" was noise about the engine's bookkeeping.
- **Confirmations are a toast, not a banner.** The message appears pinned to the bottom centre where the eye already is after clicking, and takes itself away after a few seconds. It still travels in the URL so it survives the navigation to the next task, and dismissing removes it from the URL so a reload does not resurrect it.
- **The template is editable where it is shown.** The step's subject and body are now fields, not a grey read-only block: an FO reads the person's history on the right and personalises the copy before sending it from their own mailbox. Edits are kept per task in that browser, so switching tasks or reloading does not lose them, "Reset" puts the template back, and Copy copies what is on screen rather than the original. Nothing is written to Twenty from here, and Cadence still sends nothing.
- **"Approaching" and the other invented stages are off the panel.** A label Cadence guessed from its own state was being shown next to the CRM record it was guessing from. What replaced it is what the CRM actually holds: the tags on the person, in their own section, plus the flags that carry consequences (do not contact, opted out, bad email, bad phone).
- **One history, not three lists.** Touches, the emails Twenty synced, the notes people wrote in Twenty, and the sequence's own events are merged onto one clock, newest first, with inbound marked. An email that Cadence recorded as a touch and Twenty also returns in full is shown once. The history sits above the sequence mechanics, because it is what you read before writing.
- **Space is reserved for the analyzer**, bottom right, saying plainly that no model is connected and what will appear when one is. Same seam as the meeting analysis: this panel is the second consumer of it.
- **List and flow are now different screens.** They had been the same layout with the list hidden. List is for picking: a table on the left, the task and the person beside it, bulk actions across selected rows. Flow is for working through a run: no list at all, a rail across the top with one segment per task and the position in the run, larger type, and a way back to the list. Keyboard shortcuts serve flow; the table serves list.

### What the tests found this round

- The ingest suite began failing in the evening and passing in the morning. `Enrollment.createdAt` took the database's clock while the engine took the simulated `now`, and the evidence window is measured from that timestamp: with a fixture note dated the 7th and a real clock late on the 8th, the same note was a completion before about 10:00 and a plain touch after it. Enrollments now stamp the engine's clock, which is the real clock in production, and a test asserts it.
- Two Home assertions were passing for the wrong reason: `getByText('Done this week')` matched the new team-board column header, so it would have kept passing even if the old tile had come back. The check now enumerates the tiles exactly.
- The help popover could not be closed with Escape, unlike every other overlay, which is also what stopped a test from reaching the sign-out button.

## The real Twenty mapping (round 7)

Until this round the person mapping was a guess, written before anyone had seen the workspace.
A full export of Alisa's pod - 934 people, 59 columns - settled it. Three of the guesses were
wrong in ways that would have failed silently in production, and about thirty real fields were
simply absent.

### The three that were wrong

- **The owner of a relationship is `assignedTo` / `assignedToId`, not `owner` / `ownerId`.**
  Twenty has no standard owner on Person; this workspace calls it "Assigned To", and 710 of the
  934 records have one. Reading a field that does not exist returns null, so "My relationships"
  would have been empty for everybody and `assignment: OWNER` would have fallen through to the
  pod's default FO on every enrollment - with no error anywhere.
- **`dnd` is a select, not a boolean.** Its one value is `DO_NOT_DISTURB`, set on three people.
  `raw.dnd === true` is never true for a select, so do-not-contact would never have been
  honoured: those three would have been enrolled and called. The normaliser now treats any set
  value as consent withdrawn, still accepts a boolean for a workspace that has one, and keeps
  the value itself so the record can say *which* restriction applies.
- **"Where we met" is `leadSource`, a multi-select**, not an `eventSource` text field:
  `FPA_WISCONSIN_JULY_2026`, `TRUST_ALTA_LUNCHEON_JUNE_2026`, `LEADGEN`, `NIL`, 27 values in all,
  and a person can carry two. The template variable is now `{{leadSource}}` and it renders the
  humanised label, because `{{eventSource}}` would have put `FPA_WISCONSIN_JULY_2026` in front of
  a prospect. The opening email no longer claims "we met through ..." at all: for the 250 people
  whose source is `LEADGEN` that was simply untrue, and the FO can add the real context in the
  editable message.

### What the record actually holds, and where each part now goes

The workspace tracks far more than contact details, and each group answers a different question,
so each got its own place rather than being flattened into one list:

- **Ownership** - `assignedTo`, `podOwner` (upper-case values: `ALISA`, `ANDREW`, ...),
  `rotationTracking` / `rotationChangedAt` - drives "my relationships", pods, and a flag on the
  person when they have been rotated out to another pod.
- **What the CRM says to do next** - `nextAction` ("FU-2", "Follow up 2"), `nextActionDueDate`,
  `nextStep` (`EMAIL` / `LINKEDIN_MESSAGE`), `nextActionDueDatePoc`, `lastNote` - is now the
  **first** section of the person panel, above Cadence's own step. 535 of the 934 people have a
  next action written by hand in Twenty. Cadence never writes these: the pod plans in the CRM,
  and an FO about to contradict that plan should see it before they type. The due date turns red
  once it is past.
- **Classification** - `tier` (`LEVEL_1`..`LEVEL_4`), `contactType`, `listCategory`
  (`COLD_BD`, `BI_WEEKLY`, `MONTHLY`, `QUARTERLY`), `previousCadence`, `pipelineStageField`,
  `productInterest`, `primaryProduct`, `onGoingCampaigns`, `alisaCallingList`,
  `leadSource` + `leadSourceNotes` - is on the panel, on the person's Details tab, on the
  account's people table, and as filters on the People list.
- **Last touch** - `latestCallActivity`, `lastEmailActivity`, maintained by Twenty's own
  automations for 246 and 226 people respectively - joins the person's history, but only where no
  Cadence touch or synced email already covers that moment, so nothing is shown twice.
- **Meetings** - `meetingTime`, `meetingLink`, `salesCallRecordingLink`, `bookingId` - do two
  things. A meeting time set on the person is now what marks a booked meeting in the engine, and
  the Meetings section grew a **"Booked in Twenty"** list: the people whose record carries a
  meeting, each with its join link and a one-click "Add with transcript" that pre-fills the form
  from the person. Cadence does not create a Meeting row by itself, because a meeting here
  carries attendees and a transcript that only a human can supply.
- **Contact details** also gained `additionalNumber`, `additionalEmails` and `xLink`, and
  `createdBy` so the record can say who added the person and how (`MANUAL`, `EMAIL`, `API`,
  `CALENDAR`).

Two columns of the export are deliberately not carried: `Phones / Additional Phones` (one record
in 934, and the separate `additionalNumber` field is what the team actually uses) and
`Created by / Context`, which holds only the mailbox provider. Everything else in the export has
a home.

### The invented stage is gone

The People list used to show a stage Cadence guessed from its own state - Cold, Approaching,
Unresponsive - next to the CRM record it was guessing from. The panel lost it last round; the
list has lost it now. What replaced it is `crmStanding`: the CRM's own pipeline stage if it has
one, otherwise the contact type, otherwise the list category, with do-not-contact first. Beside
it sits the tier, the expected touch frequency, and anything wrong with the contact details.
What Cadence has *done* with the person - which sequence, which step, replied or not - is a
separate column, because it answers a separate question. The sequence filters stayed, relabelled
as sequence state rather than "stage", and the list gained real filters on tier, contact type and
cadence.

### Values are values; labels are labels

Twenty stores options as constants and keeps the human label in field metadata that Cadence only
sees when it introspects. Printing `AY_PHH_POST_WEBINAR` on screen makes the whole app read like
a database dump, so `twenty/labels.ts` turns a value into something readable: acronyms the team
uses stay upper-case (PHH, FPA, WM, CE, NIL), a run-together trailing year is split off
(`FUTUREPROOF_MAR2026` -> "Futureproof Mar 2026"), and the handful the general rule mangles are
listed outright (`CLIENT_S_CLIENT` -> "Client's client", `LEVEL_2` -> "Tier 2", `COLD_BD` ->
"Cold BD"). Free text passes through untouched. Two tests hold the line: every option the mapping
knows produces a non-empty label, and no text node matching `/^[A-Z][A-Z0-9]+_[A-Z0-9_]+$/`
appears on the People list, the person panel or the person record.

Pod names follow the same rule. A pod discovered from a value Twenty has no label for used to be
called `KARSON`; it is now called "Karson", and the label still wins when the metadata has one.

### Tags carry meaning, so they are read rather than duplicated

The team encodes consent and data quality in tags: `DNC`, `MISSING_EMAIL`, `MISSING_PHONE`,
`ENRICHMENT_REQUIRED`. Cadence already had its own `badEmail` / `badPhone` flags, set by a bounce
or a wrong-number call. Rather than asking anyone to keep two sets in step, the person's tags are
read for the same meaning and the two are merged on display, with Cadence's flags still local and
never written back. Consent is shown once - the standing badge already leads with "Do not
contact", so repeating it in the warnings line was noise.

### What this cost

- `PersonCache` gained 30 columns and four indexes (`tier`, `listCategory`, `nextActionDueDate`,
  `meetingAt`), and the migration stamps every cached person as stale so the next sync refills
  them. `eventSource` and `statusOfMeeting` are dropped.
- The task panel went from 18 queries to 20: one for the pod's name, one for the owner's. Both
  are single lookups, and the query-budget test still holds every page under 30 whatever the row
  count.
- The GraphQL person selection went from 17 fields to 44. All of the new ones are optional, and
  the client already trims a field the workspace does not have out of its selection set, so a
  workspace with only some of them works and `verify:schema` says which are missing. It now also
  prints each select's option values against the ones the mapping expects, which is how a renamed
  option gets caught before an FO sees an empty filter.

### What the tests found this round

- `rawFromPerson` re-expressed a normalised person in Twenty's field shapes, and once `dnd` became
  a select it emitted `null` for a person whose `dnd` was true but whose `dndReason` was unset -
  which is exactly what a fixture or a test that writes `{ dnd: true }` produces. The record then
  read back as *not* do-not-contact, and the dnd-exit test failed. It now emits the default select
  value in that case, so the round trip is faithful either way.
- The phone numbers in the export carry a zero-width joiner inside the calling code (`"‍+1"`).
  Passed through, every phone in the app grows an invisible character and `tel:` links break. The
  calling code is now stripped to digits and `+`.
- A date field can arrive as `2026-08-31` or as `2026-08-31T00:00:00.000Z` depending on how it was
  written; both now yield the same local date, so due dates never shift by a timezone.
- The new "Booked in Twenty" table made `page.locator('table')` ambiguous in an older Meetings
  test, which is the kind of failure worth having: the assertion was too loose to say which table
  it meant.
