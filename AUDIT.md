# Cadence project review

Reviewed on 9 September 2026. This is a broad code, workflow, design, and local-runtime review, with database-backed regression tests and browser verification. It is not a certification that every possible defect has been eliminated.

## Product intent

Cadence is a human-operated sales engagement workspace beside Twenty CRM. Twenty supplies people, companies, ownership, consent, and observed activity. Cadence manages campaigns, versioned sequences, task timing, local relationship maps, meetings, and reporting. People perform every email, call, and LinkedIn touch. The redesign keeps this boundary and uses actual database values throughout.

The review covered routes and shared components, authentication and role boundaries, server actions, task and enrollment transitions, timezone handling, querying and reporting, Twenty adapters and pagination, meeting providers and transcripts, migrations, tests, startup scripts, dependencies, and deployment configuration. Existing product decisions and integration documentation informed the changes.

## Design changes

- A custom Cadence mark, evergreen sidebar, lime accents, warm canvas, quieter borders, consistent controls, and clearer typography replace the generic purple interface.
- Navigation groups work into Workspace, Engagement, and Insights. A native dialog provides mobile navigation, focus containment, Escape dismissal, and focus restoration.
- Home combines personal priorities, a task-flow entry point, three upcoming touches, today's progress, and scoped weekly team performance.
- Sequences use searchable cards with real step previews, availability filters, versions, campaign counts, and performance. Accounts and campaigns have summary metrics above their lists.
- Shared styling carries through tasks, people, records, meetings, reports, activity, and settings. Login has its own editorial split layout.
- Search is available everywhere, with keyboard navigation, request cancellation, loading/error feedback, and Ctrl+K / Cmd+K. Help, skip-to-content, visible keyboard focus, responsive tables, and reduced-motion support are included.
- Record errors and missing records have recovery states. Task feedback survives navigation, forms retain the right record context, and action buttons report successful operations.

## Corrected issues

| Area | Finding and resulting behavior |
| --- | --- |
| Terminal outcomes | Answering the final call or bouncing the final email could advance the enrollment to completed before applying the outcome. Outcome handlers now defer advancement so replied/exited state is preserved. |
| Concurrent task actions | Competing completion/skip requests could both act on the same pending task. Conditional updates allow one request to claim the task, preventing duplicate completion audits and overwrites. |
| Snoozing | The ordering timestamp could remain on the old day. Snoozing updates it to 09:00 in the task owner's timezone. |
| Task context | Notes, chosen outcomes, and edited drafts could carry into another selected task. Task controls and composers reset by task identity; list selections reset with filters. |
| Keyboard controls | Background task shortcuts could fire while a modal was open, and Enter could submit twice on a focused button. Modal, pending, repeat, and native-activation checks now prevent those collisions. The documented copy shortcut copies the edited draft and reports clipboard failure. |
| Bulk tasks | Select-all could exceed the server's 200-task limit. Selection now respects that limit and reports failures. |
| Campaign access | Global search returned campaigns outside the viewer's pods. Search now uses the same campaign scope as the list and record pages. |
| Team reporting | An FO shared across pods could expose another pod's totals in a senior's team board. Team queries now include the viewer's pod scope. Personal dashboard links also preserve the signed-in FO filter. |
| Assignment | Fixed assignment could bypass the active-membership check. The selected FO must now be active in the campaign pod. |
| Re-engagement | Repeat-campaign candidate counts included people who opted out locally. Those people are now excluded before enrollment preview. |
| Meeting times | `datetime-local` values were interpreted in the server timezone. Create/edit now convert from the user's timezone, including validation of calendar dates and skipped daylight-saving times. |
| Meeting links | Edit accepted malformed URLs that create rejected. Both require HTTP(S); provider matching now uses hostname boundaries. Transcript writes have a size limit, and changing the linked account invalidates both affected records. |
| Sessions and users | Password resets now revoke existing sessions. User forms validate timezones, and sender aliases are normalized and deduplicated. Login return paths reject off-origin and malformed redirects. |
| Public endpoints | Middleware public paths now match exact paths or path segments. The public health check no longer exposes raw database errors. |
| Account sync | Refresh scanned only the first 2,000 CRM people. It now filters by the account in Twenty and follows pagination. Missing/repeated cursors and page limits report incomplete sync instead of silent success. |
| Worker retries | Daily jobs were marked done before succeeding and were skipped when the worker started after the scheduled hour. Completion markers now follow successful work, and missed daily work is eligible after its configured hour. |
| Local startup | Startup could recursively remove an uninitialized directory and remove a live database lock. It now validates the path, preserves nonempty directories, and refuses a live lock. Environment parsing respects quoted values. Normal launches build current source instead of serving an old build. |
| Docker | Local database folders and environment overrides were eligible for inclusion in the image. Build exclusions now cover them. PostgreSQL 18 uses its correct parent volume mount, and the database's published port binds to localhost. Existing-volume migration guidance is in DEPLOY.md. |
| Dependencies | Targeted PostCSS and Prisma configuration overrides plus the Vitest 4 upgrade clear the installed dependency audit. Prisma migrations, the build, and the unit suite were rerun for compatibility. |

## Verification

- `pnpm test`: **211 tests passed in 29 files**, using an isolated embedded PostgreSQL 18 database and all five migrations.
- `pnpm build`: production compilation, TypeScript validation, and build lint passed.
- `pnpm lint`: passed. `pnpm audit`: **no known vulnerabilities found** in the installed dependency graph at review time.
- `pnpm exec playwright test`: **35 browser tests passed** against a fresh isolated database. Coverage includes campaign creation, conflict previews, task outcomes, sequence versioning, rules, role restrictions, meetings, account maps and sync, activity, search, dialog focus, and mobile navigation.
- Desktop and phone screenshots are available in `.screens/` and `.screens/review/`. Main phone layouts were checked at 390 × 844; desktop captures use 1600px width.
- Review/test databases are isolated from `.pgdata-dev`. Existing application data has not been reset.
- The updated app is running at `http://localhost:3100`; its health endpoint reports the database up. Final desktop/mobile captures reported no page errors or horizontal overflow. Temporary review folders remain ignored: automatic approval review blocked their deletion, stating "blocked by policy."

## Boundaries still requiring an integration environment

- The real Twenty service, credentials, webhook delivery, and write permissions were not exercised. Mock adapters, recorded GraphQL shapes, ingestion, and sync behavior are covered locally; run `verify:schema` and the documented dry-run pilot against the intended workspace.
- Meeting analysis and suggested approaches remain visibly unconnected to a language model. This review does not implement transcription, a model provider, or autonomous outreach.
- Docker configuration was inspected, but a container build/run was unavailable because Docker is not installed here. Existing named volumes require the backup/location check described in DEPLOY.md before adopting the corrected PostgreSQL mount.
- Verification uses local/demo data. Production-volume load testing and multi-worker scheduling are outside this review; the documented single-worker deployment remains the supported setup.

Dependency references: [PostCSS advisory](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp), [deepmerge-ts 8 release](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0), [Vitest advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9). PostgreSQL volume reference: [official PostgreSQL 18 image](https://github.com/docker-library/postgres/blob/master/18/alpine3.23/Dockerfile).
