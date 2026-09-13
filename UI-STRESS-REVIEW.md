# UI and stress review — 13 September 2026

This pass refines the existing interface and exercises failure/concurrency cases beyond the earlier requirements audit. It does not replace the product layout.

## Interface

- Self-hosted Inter variable font, including the login screen; upstream license is bundled.
- Calmer table headers, clearer row separators, stronger numeric values (including zero), and consistent badge borders, contrast and spacing.
- People: bounded column widths; recent touch details and the activity timeline share a column so ownership stays visible on desktop. Long names retain their full text in accessible link names/tooltips.
- CRM tags show the primary standing separately. Additional tags expand and collapse with a real keyboard/touch-accessible button.
- Filters merge rapid changes against the latest requested URL. Typing a search while selecting a pod, missing field or favourite no longer silently drops the other choice.

## Reliability failures reproduced and fixed

| Trigger | Previous result | Fix |
|---|---|---|
| CRM notes listing fails for two hours while other listings succeed | Shared cursor advances past the missed activity | Separate stage cursors retain the retry window until that listing completes |
| Full company refresh fails | Full refresh could be marked successful despite the failed listing | A complete refresh is recorded only when all listings/records succeed |
| Older person/company snapshot arrives after a newer update | New data is overwritten | Atomic timestamp conditions reject stale writes while recording that the record was seen |
| An active snapshot arrives after deletion | Deleted contact can reappear | Compare deletion time as well as update time; a genuinely newer restore still works |
| Delayed do-not-contact update follows a newer consent update | Stale flags can exit an enrollment | Apply consent from the accepted cache snapshot |
| Twenty deletes a record without changing `updatedAt` | Deletion is dismissed as a duplicate update | Deletions use a distinct deduplication key and their deletion timestamp |
| Concurrent navigation while page data streams into React | Intermittent hydration error and client rerender | Main page bodies mount after the shell hydrates; server-side data loading and permission checks are retained. First load briefly displays a loading state; filter/action updates keep the existing frame mounted. |

## Stress scope

All generated data and concurrent writes use isolated local PostgreSQL and mock Twenty. They do not send prospect emails or place calls.

- 16 concurrent attempts to enroll the same person: one enrollment.
- 32 simultaneous webhook deliveries: one processed event and one completed action.
- 16 concurrent completions across an email/call step, followed by 16 scheduler attempts: two completions and one next step.
- 20,000 contacts and 6,000 companies, with 12 simultaneous account readers: accurate totals and 1,200 distinct results across twelve pages. The measured reader batch took 548 ms locally; this is a correctness/load sample on the development machine, not a hosted capacity guarantee.
- Delayed updates, consent changes, deletion and restoration; two-hour partial CRM outage and replay.
- Browser coverage includes role permissions, real form submissions, campaign/task progression, filters, tag keyboard access and narrow viewports.

## Final validation

- **322 unit/integration tests across 46 files passed.**
- **52 browser tests passed**, with no retries, against the clean production build.
- Five additional repetitions of the four-seat navigation test passed against the populated demo workspace: **700 section visits**, with no reported browser errors or failed page responses.
- Production build, TypeScript and lint passed. Desktop and phone screenshots were visually inspected.
- The initial stress failures were retained as regression cases. Temporary framework diagnostics and unsuccessful rendering changes were removed before the final build.

## Remaining external constraints

The production dependency audit still reports two moderate `sanitize-html` advisories. The repository already documents why the newer packages cannot load with its CommonJS parser combination, and regression tests cover the relevant payloads with Cadence's restrictive allow-list. See [DECISIONS.md](DECISIONS.md#sanitize-html-is-pinned-below-the-latest-release-11-september-2026). These findings are not claimed to have disappeared.

The previous hosted walkthrough found a deployment behind GitHub. A successful repository check alone does not establish which build the hosted service is running. External CRM/provider behavior requires live configuration and service health; the isolated stress results do not prove unlimited production capacity or the absence of every possible defect.
