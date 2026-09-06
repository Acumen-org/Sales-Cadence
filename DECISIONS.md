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
