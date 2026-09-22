# Campaign studio release verification

The studio creates outreach inside each campaign, with a calendar planned around mandatory dates, contact priority and each FO's new-people limit. Contact groups can use their own outreach; a contact belongs to exactly one group.

## Setup refinements

- Numeric inputs can be cleared and retyped without a leading zero.
- Setup advances through Audience, Outreach and Schedule with named next-step buttons. Required fields and audience eligibility are checked before Outreach; only a valid calendar can advance to Schedule.
- Default outreach adapts its length and spacing to the campaign window, audience and FO limits. It uses the established cold-outreach channel pattern without a reusable sequence library.
- Outreach groups are created, renamed and deleted in the left sidebar. Assigning a contact removes it from Default; contacts assigned to other custom groups are disabled in the picker.
- Calendar presentation uses the application's normal tables, borders and typography. Dates and limits can be adjusted in place with a validated preview.
- Meetings fit desktop and phone widths, including imported recordings. People campaign membership changes are bulk actions; ineligible selections disable the relevant action.
- Admins can explicitly erase a stopped, completed or draft campaign and its associated task/enrollment records. Exact-name confirmation is required; CRM notes and dependent follow-up campaigns prevent ambiguous deletion.

## Completed local verification

- Production build, type checking and lint passed.
- 446 unit/integration tests across 65 files passed.
- 81 browser tests passed, including campaign creation/publication/editing, role checks, responsive tables, bulk membership, custom-group exclusivity and deletion.
- Three fresh-install browser tests passed against a separate empty database.
- Planner tests include 420 deterministic combinations, 192 small cases checked against an independent exhaustive search, 60 adaptive-starter cases, weekend/year/DST boundaries, priorities, concurrent publication and launch, stale plans, 2,000-contact planning and early rejection of a 10,000-contact overload.
- Directory stress test: 12 concurrent account pages against 20,000 people and 6,000 accounts completed in about 1.3 seconds locally.

## Operational boundaries

Published plans cover every working day within their campaign dates and allow at most two batches per FO per day. Human completion, replies, opt-outs and subsequent removals can change actual coverage; overdue work remains visible rather than silently moving. Existing legacy campaigns retain their execution rules. New studio campaigns execute their published dates.

Planner search is bounded and reports search exhaustion separately from infeasibility. Suggested adjustments are verified before being offered. These checks cover the specified requirements and representative stress cases, not every possible future integration or input.

The release includes a database migration for campaign-owned outreach, draft/published plans and enrollment schedule dates. GitHub CI repeats lint, type checking, unit/integration, browser and fresh-install checks before automatic deployment.
