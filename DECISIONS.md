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

- **All names in `src/lib/twenty/twenty-schema.ts`.** Defaults assume a stock workspace plus custom person fields `dnd`, `podOwner`, `owner` (relation to workspaceMember, FK `ownerId`), `tags`, `eventSource`, `statusOfMeeting`. `owner`/`ownerId` and `statusOfMeeting` are the most likely to differ; `pnpm verify:schema` reports mismatches.
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
- **Meetings** come from `opportunity.created` (point of contact enrolled, including already-replied enrollments) and from `person.statusOfMeeting` matching `meetingStatusValues` (case-insensitive). Both are settings.
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
- **Selections are trimmed to fields that exist.** On first use the client introspects each type (`__type { fields { name } }`) and drops optional custom fields that the workspace does not have, so a missing `statusOfMeeting` or `cadenceTaskId` becomes `null` instead of breaking every query. If introspection is disabled the full mapping is used and `verify:schema` is the only safety net. Results are cached per client instance; the client is rebuilt when the mapping or connection changes.
- **Relation lifts instead of relation filters.** Notes and messages for one person are fetched through `noteTargets(filter: { personId })` and `messageParticipants(filter: { personId })` and lifted to their parent record (messages deduplicated), because filtering a parent by a one-to-many child is not reliable across Twenty versions. Tasks use `taskTargets: { some: ... }`.
- **Reconcile windows** use `updatedAt >= since` for people, notes, opportunities and tasks, and `receivedAt >= since OR createdAt >= since` for messages, because mailbox sync can import old messages late.
- **Deleted people** are only returned when asked (`includeDeleted`), via an `or` on `deletedAt is NULL / NOT_NULL`, matching Twenty's soft-delete default.
- **Mutations**: `createNote` + `createNoteTarget`, `createTask` + `createTaskTarget`, `updateTask`, `deleteTask`. Rich text is sent as `{ markdown }` when the mapped body field ends in `V2`, else as a plain string (legacy `body`). Ids are `UUID` typed variables.
- **Saved Twenty views** are read from the core `views` query with their `viewFilters`, field ids are resolved through the metadata API, and simple operands (is, isNot, contains, doesNotContain, isEmpty, isNotEmpty, greater/less than, before/after) are translated to GraphQL filters. Anything else fails with a clear message suggesting to paste ids instead; the view feature is best-effort and depends on the Twenty version.
- **Introspection prefers the metadata API** (`/metadata` `objects { fields { name type options } }`) because it exposes select option values (needed for `podOwner` and `task.status`), with GraphQL `__type` introspection as the fallback.
- **`pnpm verify:schema`** compares every mapped object and field with the live workspace, distinguishes required from optional fields (`dnd`, `podOwner`, `owner`, `tags`, `eventSource`, `statusOfMeeting`, `cadenceTaskId`, `city`, `timeZone`, message `text` and `messageThreadId` are optional), prints `podOwner` options against configured pods and `task.status` options against the mapping, runs a one-person smoke query, and exits 1 only when something required is missing.
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
