# Campaign calendar model - local implementation

This replaces the earlier proposal. The campaign studio implements the model below.

## Campaign setup

The studio has three steps: People, Outreach, Schedule. Dates, products, selected FOs and the audience belong to the campaign. Each FO has a new-people/day batch size, initially copied from the campaign default. Capacity is independent of other campaigns and of legacy workspace daily caps.

Outreach is authored within this campaign. Default is generated from a cold-outreach channel recipe, with its step count and spacing verified against the campaign dates, audience and per-FO limits. It is not a fixed eight-step template. Selected contacts can receive a separate editable copy. A contact has exactly one outreach flow. There is no reusable sequence library or save-as-template action. Private database sequence rows support existing task execution and history; they are not reusable user-facing sequences.

## Planning rules

- Start and end dates are required. Every selected FO must have one or two batches on every Monday-Friday date in the window.
- A batch contains at most that FO's new-people/day count. Two batches on the same day must be at different step numbers. A combined call/email touchpoint counts people once and creates separate required activities.
- Reserve each batch's entire journey before admitting it. First-touch batches start on distinct days in priority order.
- Priority is Clients, MIP, Tier 1, Tier 2, Tier 3, then unclassified; overlapping categories take the highest priority. CRM LEVEL_1/2/3 values are recognized. Equal-priority contacts are grouped by outreach to avoid unnecessary tiny batches, then ordered by name and ID.
- Preserve CRM ownership. Unselected or unmapped owners are explicit conflicts. Distribute only unowned contacts, balancing this campaign's audience relative to each FO's batch size.
- Consecutive people on the same outreach flow form a batch after priority and flow grouping. Do not move a lower-priority person ahead to fill a different flow's batch. This can produce partially filled batches.
- Gaps count calendar days from the previous adjusted touchpoint. Saturday moves to Friday, except a one-day gap moves to Monday. Sunday moves to Monday. No touchpoint is placed on a weekend, and no new touchpoint is generated on a weekend.
- All journeys finish by the end date. No invalid calendar can be published. Step 01 validates eligibility and produces a fitted starter before opening Outreach. Step 02 checks edits in place; Schedule opens only after these checks pass. Suggestions modify gaps, end date or batch sizes only after the same planner verifies a complete replacement calendar. Applying a suggestion requires a fresh review before publication.

The deterministic search tries earlier starts first. It has a work limit and reports search exhaustion separately from infeasibility. It does not claim a global sales-optimal result. Not every possible input has a solution, and the system cannot manufacture meaningful outreach to fill an impossible window.

## Execution and lifecycle

Publication stores the exact calendar, contact assignments and step dates. Launch uses those dates without running a second capacity allocator. Both activities of a combined touchpoint must resolve before the next step becomes available. Replies and opt-outs retain the existing stop behavior.

Saving an upcoming campaign as a draft withdraws its published schedule. Publishing it again revalidates the full plan. Concurrent edits require the latest revision, and publication requires the fingerprint of the reviewed draft. Membership reservations and launch are transactional; competing publications cannot silently share the same people.

Before launch, unavailable people, blocked accounts, changed owners, unavailable FOs or changed follow-up eligibility prevent a partial launch. The campaign displays an attention message for review. Campaign-owned steps cannot be edited through legacy endpoints.

Active plans are locked. Independent task snoozing, step jumping and delegation are disabled for calendar tasks because they would invalidate the accepted dates and FO reservations. Pause, stop, reply and explicit removal remain available. Pausing does not shift dates. Resuming after the end date is refused. Plan another run opens a new draft with the previous campaign's audience and outreach for fresh date/capacity review; previous history stays intact.

The guarantee covers the published plan. Actual replies, opt-outs, removals and missed work can reduce coverage. Missed tasks remain visibly overdue rather than being silently combined with another batch or moved beyond the deadline. At the end date the campaign stops remaining work.

## Compatibility and deployment

Existing campaigns retain their historical execution model. Upcoming legacy campaigns can be opened in the studio and converted before launch. Sequence routes redirect to campaigns; historical IDs remain in the database. Follow-up requests use private campaign outreach and require a leader's calendar review before publication.

Migration: `20261001000000_campaign_calendar` adds campaign drafts/calendars, enrollment dates and private-flow ownership. It removes unique sequence names so separate campaigns can each have a Default flow. Deploy migration before starting code. Deployment uses the regular tested main-branch release pipeline.

## Studio refinements

Outreach groups are created, named, edited and deleted in the left sidebar. Contacts leave Default when assigned to a custom group. Contacts in other custom groups remain visible but cannot be selected, including through page-wide or all-matching selection. Deleting a group returns its people to Default.

The calendar is a compact working-week view. Dates and FO limits can be adjusted in a dialog without leaving it; an invalid adjustment keeps the last valid calendar intact. Starter generation is limited to new, unauthored outreach. Existing campaign drafts and restarted custom outreach are preserved.

People membership changes are bulk actions. Mixed selections add only currently available contacts and remove only campaign members. Removing people from an upcoming calendar returns it to draft for review; it cannot run using a stale published plan. Meetings use a fixed-width desktop table and labeled rows on smaller screens.
