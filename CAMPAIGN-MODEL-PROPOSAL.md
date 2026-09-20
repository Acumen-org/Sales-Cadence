# Campaign and sequence model for discussion

Reviewed against the September list on 20 September 2026. This is a proposal, not shipped campaign behaviour. Point 18 explicitly asks for discussion before changing the campaign/sequence core.

## What is actually implemented

A campaign currently has one sequence, one pod, start/end dates and a planned audience. The database permits only one ACTIVE or PAUSED enrollment per person, even outside a campaign. This is stricter than points 3 and 19: simultaneous standalone sequences alongside a campaign are **not implemented**. Neither are per-person sequence choices inside a campaign, creator-selected FO rosters, or full editing of an upcoming campaign.

The existing capacity planner does simulate later actions, roll work onto configured working days and include existing FO load. It derives a starting rate automatically. Its default daily action cap in code is 40, with a workspace setting and possible per-user override; this is distinct from new people started per day. The creator cannot yet select that daily starting rate in the campaign form. The latest sequence editor uses calendar-day offsets with non-working dates rolled forward; this audit does not change those semantics.

## Recommended model

1. **Dates are a completion window.** Every planned action for every chosen person must fit by the end date. Reject an infeasible launch and show the specific FO/day overflow. Offer an extended end date or a shorter sequence. Reducing starts per day reduces workload but cannot shorten a sequence's intrinsic span: a 23-day plan cannot finish inside two weeks even for one person.
2. **Separate starts from workload.** The creator chooses new people per FO per day, prefilled from a configurable workspace default (suggested starting default: 5, not yet approved). A separate per-FO daily action cap covers all campaigns and standalone sequences. An email + call touchpoint costs two action slots. Sequence step-count and duration limits are configurable authoring safeguards; they do not replace the daily simulation.
3. **Choose the FO roster explicitly.** Assign only to selected, eligible pod members. Preserve the CRM owner if that owner is selected. A contact owned by an unselected FO is an explicit conflict requiring reassignment or exclusion; do not silently reassign them. Balance only genuinely unowned people across selected FOs, considering existing commitments.
4. **One campaign, one chosen sequence per person.** A campaign has a default sequence and an allowed sequence list. Each member has exactly one selection, individually or in bulk. Separate standalone sequences may run alongside that campaign, as point 19 requests. Prevent duplicate live membership in the same sequence and reserve a person's active campaign slot atomically. Scheduled-campaign conflicts must be surfaced before launch.
5. **Preserve history and make stopping rules explicit.** A reply or opt-out should stop all automated follow-up for that person by default, with exact reply evidence retained against the originating task/sequence where known. Historical replies must never move to a newer campaign. Concurrency rules must cover enrollment, scheduler, campaign launch, replies, pause/resume and restart together.
6. **Upcoming campaigns are editable; active plans are locked.** Before launch, allow dates, name, audience, selected FOs, rates and per-person sequence choices to change, then revalidate capacity. A pending-approval campaign that changes materially needs approval again. After launch lock those planning fields, as point 17 requests. Retain explicit pause/stop and the membership removal requested in point 8; additions to a running campaign must pass a fresh capacity check. Do not quietly expose end-date changes as an exception to the lock.
7. **Show the actual calendar.** One row per FO, one column per working day, displaying planned actions / daily cap and new starts. Differentiate existing commitments from this campaign's proposed work. Show the first/last starting day and final completion date as labelled values, without an unexplained purple line. The planner should also report the first infeasible date and how many people fit.

## How capacity is computed

For each selected FO and each candidate person's start day:

- Expand that person's selected sequence into individual email/call/LinkedIn actions using the same date rules as the scheduler.
- Add those actions to the FO's existing commitments, including future scheduled campaign reservations and standalone work.
- Accept the start only if every action remains on/before the campaign end and every daily total is within the FO's cap.
- Enforce the creator's maximum new starts for that FO/day. Do not increase it automatically to fit the audience.

For mixed sequences or pre-existing work, multiplying people by steps, or dividing the audience by a uniform start rate, is not sufficient. The day-by-day simulation is authoritative. The suggested end date is the first date at which that same simulation fits everyone. Sequence step changes must trigger capacity revalidation for unstarted campaigns; started work retains the existing in-use-step protections.

## Discussion still needed

- Confirm action-based daily capacity (email + call = two slots); this is recommended and matches the current engine's workload unit.
- Set the default starts/day and authoring limits. Do not silently replace the existing daily cap with a proposed number.
- Confirm whether Biz Ops should remain read-only or gain the campaign-membership exception implied by "everyone" in point 8.

Implementation should ship the roster, selected start rates, mixed-sequence planner and upcoming editing together, then migrate the one-live-enrollment constraint with concurrency tests. Removing the current unique index alone would leave replies, tasks and capacity inconsistent.
