# Cadence - plan for the next round (18 September 2026)

This is the working plan for the thirty-four points raised on 18 September. It is written to be
executed in the next round without further questions: every item names the cause where one was
found, the change, the files it lands in, and how it is verified. Where a point needed a decision,
the decision is made here with its reasoning, and section B lists the few the owner should confirm
before implementation starts.

Numbers in brackets are the owner's own numbering. Items are grouped into workstreams (section C)
because several points share one root cause or one data model; the order of work is in section D.

---

## A. What the investigation found

Each of these was traced in the code, not guessed.

| # | Symptom | Root cause | Change |
|---|---|---|---|
| 1 | Home says 246 people, People filtered to Alyssa says 245 | Two definitions. Home counts `owner = me OR any enrollment as FO` over every cached person, including team members, blocked accounts and finished enrollments (`accounts-query.ts` `myOwnershipCounts`). People applies the directory exclusions and counts only ACTIVE/PAUSED enrollments (`people/page.tsx`). One person satisfies one rule and not the other. | One shared `myPeopleWhere(user)` used by both, and every Home tile links to the People list that produces the same number. A test asserts the tile equals the filtered count for every seeded seat. |
| 2 | A campaign starting 21 Sep shows no upcoming tasks | By design. Enrollments and tasks only exist once a campaign launches on its start date (`launchScheduledCampaigns`), and steps are generated when they fall due. Upcoming shows work that exists. | Keep. Add a "Starting soon" strip on Tasks and the campaign's own page so a scheduled campaign is visible before it starts (see C5). |
| 3 | Search boxes delete letters while typing | Every toolbar does `useEffect(() => setText(q), [q])`. Typing pushes the URL after a debounce; when the new URL renders, the effect resets the box to the URL's value, discarding whatever was typed during the round trip. Meetings has the shortest debounce (250 ms) so it shows most. | Sync from the URL only when the box is not focused and the value differs from what the box last sent. One shared `useSearchBox(paramName)` hook replaces the copy in each toolbar. Browser test types fast under a slowed server and asserts nothing is lost. |
| 4 | Accounts says 3,758 people, People shows 8,000+ | The tile sums people who have a company link. Roughly half the CRM's people have no company in Twenty. The number is right; the label is not. | Label it "People with an account" and add "People without an account" beside it, linking to People filtered to `account=none`. `sync:diagnose` gains a line comparing Twenty's own person→company link count with the cache so a sync gap would show. |
| 9 | A green line appears beside the sort arrow when clicked | The global `:focus-visible { outline: 2px solid; outline-offset: 4px }` draws around the arrow button, and the control's `overflow-hidden` clips it to a sliver. | Focus style on the button itself (inset ring), no outline offset inside clipped groups. |
| 12b | An upcoming campaign appears nowhere | A scheduled campaign holds only `personIds`; every page reads enrollments, which do not exist yet. | Campaign membership becomes a first-class query (C6): scheduled membership from `personIds`, running membership from enrollments. People, accounts, person and account pages, and Tasks all read it. |
| 18 | "Unknown" in talk time but not in the transcript | `mergeSpeakers` only merges a line into the previous one when both carry the same speaker. A continuation line with no name stays a separate cue with `speaker: null`; the transcript view shows it under the previous speaker with no label, while `talkShare` files it under "Unknown". | Carry the previous speaker forward onto unlabeled continuation lines at parse time. Both views then agree. Lines before any speaker is named are labelled "Unattributed" in both places. |
| 20 | Dragging a step does nothing | Two things. `move()` silently refuses when any step in the range has open tasks (right, but invisible). And the drag starts from a `<button draggable>` with no `dataTransfer.setData`, which Firefox requires before it will begin a drag; Chrome shows a ghost but drop targets are the whole `<li>`, so a drop between cards lands nowhere. | Pointer-based reorder with a visible placeholder and a locked-step tooltip; browser test drags step 3 above step 2 and asserts the order and the recomputed waits. |
| 25 | "8122 matching · showing 1?300" | The en dash between the page numbers was saved into the source as a literal `?`. | "1–300". Covered under the picker rework (C5). |
| 27 | "CRM temporarily unavailable ... 502 Bad Gateway" appears on person pages | Opening a person awaits a live read from Twenty before rendering. When the gateway fails the page renders a banner with the raw error. | The live read moves after first paint (streamed), never blocks, never shows an error; failures go to Settings health with a circuit breaker (skip live reads for five minutes after three failures). The page shows only "Synced 2 min ago". |
| 29 | Reports should be visible to sales leaders, Biz Ops and pod managers | Already so in code: `canViewReports = admin OR Biz Ops OR pod leader`, where pod leader is Senior FO, Sales Leader or Pod Manager (`rbac.ts:95`). | Verify on the hosted build with the supplied seats. Decision B6 on whether Senior FO keeps it. |
| 33 | Clicks feel laggy | Four causes measured in code, to be confirmed by timing: the person page blocks on a network read (above); the People page runs a `distinct` scan over every cached person on every render to build the tag list; the Accounts page aggregates all 4,931 companies on every render; and the 30-second `router.refresh()` re-renders the whole tree, which lands on top of clicks. | C14. |

---

## B. Decisions taken (confirm or object before the round starts)

1. **Step offsets become calendar days** (#19, #24). "Email 3 days after the call" means three days, weekend included. A step that lands on a non-working day rolls forward to the next working day. Existing sequences are converted once: business day *d* becomes calendar day *d + 2·⌊(d−1)/5⌋*, which keeps every existing plan on the same actual dates. Recorded in DECISIONS.md.
2. **A campaign has a start and an end date, and its size is derived from them** (#22). The planner computes how many people each FO can start per day so that everyone finishes the whole sequence by the end date within the FO's daily cap, and caps the audience to that. Over-size is refused with the number, and the form offers "extend the end date" or "trim the audience". Detail in C5.
3. **At the end date the campaign completes softly.** People mid-sequence finish their remaining steps; the campaign shows "N ran over" rather than abandoning them. An admin switch per campaign, "stop what is left at the end date", is available for the hard case.
4. **Campaign tabs are Upcoming, Active and Finished.** Active is the default; Upcoming when Active is empty.
5. **Two kinds of non-prospect** (#31). Vendors and platforms (Microsoft, Google, OpenAI, Anthropic, Apple, Amazon, Meta, LinkedIn, Salesforce, HubSpot, Zoom, Slack, Adobe, Oracle, IBM, Nvidia, GitHub, Atlassian, Dropbox, DocuSign, Calendly) are **blocked accounts**: gone with their people, admin-reviewable, via the existing blocking. Free-mail domains (gmail, googlemail, outlook, hotmail, live, yahoo, icloud, me, aol, proton, zoho, mail.com, yandex, qq) are **not accounts at all**: Twenty created a "gmail.com" company from an address; the company is hidden from Accounts, but the people stay, shown with no account. Blocking those companies would hide real prospects who use personal email.
6. **Reports** stays visible to Senior FOs as well as Sales Leaders, Pod Managers and Biz Ops unless the owner says otherwise (they lead pods today).
7. **Calls open the dialpad** (#13): every Call button and phone number opens `https://h00ks.acm.acumen-strategy.com/admin/dialpad?number={phone}` in a new tab. The URL is a setting with `{phone}` as the placeholder, defaulting to that address. The owner should confirm the dialpad reads a `number` parameter; if not, the setting is still right and the parameter is dropped.
8. **Analysis stays hidden until Cadence AI is connected** (#18). The Analysis column and the "Ready" badge go; the analysis panel on a meeting shows nothing until the assistant setting holds a model.
9. **Enrollment removal** (#10) ends the person's sequence with reason `removed`, cancels their open tasks through the normal path, and is reversible only by adding them again (a new enrollment).
10. **The FO assignment field goes** (#25). The owner-first rule already in the engine applies: the contact's Twenty owner when they are an eligible FO in the pod, otherwise the least-loaded FO. Round robin remains available on the campaign page for a manager who wants it, not on the form.

---

**Owner's answers (18 Sep):** #1 - "my people" means live enrollments everywhere: owned in Twenty or a
running (ACTIVE/PAUSED) enrollment with me as FO, nothing finished, nothing internal or blocked, on
every tile and filter. #12 - an upcoming campaign must show *something* before it starts, within
the same week window Tasks already uses: a "Starting soon" entry on Tasks, on the person and
account pages of its members, and on the campaign lists.

## C. Workstreams

### C1. Counts that agree (#1, #4, #6)

- `src/lib/people-scope.ts`: `myPeopleWhere(user)` = directory exclusions AND (`ownerMemberId = me` OR an ACTIVE/PAUSED enrollment with me as FO). Home tiles ("My people", "My accounts"), the People `fo=` filter and the Accounts `fo=` filter all use it. `myOwnershipCounts` is rewritten on top of it.
- Accounts stats: "Accounts in view", "People with an account", "People without an account", "In a campaign" (see C7), "Engaged accounts". Replied and Meetings columns are totals over all time; headers say so on hover ("Replies, all time").
- `scripts/sync-diagnose.ts`: prints Twenty's people total, people with a company relation, cache totals for both, and the difference.
- Tests: `tests/counts-agree.test.ts` seeds one seat with an owned person, an enrolled person, a finished enrollment, an internal colleague and a person at a blocked account, and asserts Home = People filter = Accounts filter.

### C2. Search boxes, sort control, drag (#3, #9, #20)

- `src/components/search-box.tsx`: `useSearchBox(param, { debounce })` owns the text state, the debounce, and the rule "adopt the URL only when I am not focused and it is not what I last sent". Toolbars for People, Accounts, Meetings, Enrichment, Campaigns and the workspace search use it.
- `sort-control.tsx`: the arrow button gets `focus-visible:ring-2 ring-inset` and `outline-none`; the group drops `overflow-hidden` in favour of rounding the inner elements.
- `sequence-editor.tsx`: reorder with pointer events (`pointerdown` on the handle, a translated placeholder, drop index from the pointer's y against card midpoints). Locked steps show a tooltip "Work or cancel its open touches to move it". Keyboard: the existing up/down buttons stay.
- Browser tests: typing "Acubooth" quickly with a 400 ms server delay leaves "Acubooth" in the box and in the URL; clicking the sort arrow shows no stray outline (screenshot diff of the control); dragging step 3 above step 2 reorders and renumbers the waits.

### C3. Calendar model (#24, #19)

- `SequenceStep.day` is a calendar day offset (day 1 = start). `plannedDateForStep` becomes: `roll(start + day − 1 + shiftDays)` where `roll` moves a non-working day to the next working day. Shift mode's `shiftAfterStep` works in calendar days too.
- Migration `calendar_day_offsets`: converts every stored step with the formula in B1 and records the conversion in the audit log per sequence.
- `Sequence.durationDays` (required, ≥ last step's day). The editor enforces `day ≤ durationDays`.
- The editor labels change: "Day 4" and "Wait 3 days" (no "business"). A note under the day picker says what happens on weekends only once, in the field's own hint, not as running text.
- The caps (`findDateWithCapacity`) already work on the resolved due date, so nothing changes there.
- Tests: `clock.test.ts` gets calendar cases (Fri + 2 days → Mon; Sat start → Mon; shift across a weekend); `steps.test.ts` covers `durationDays` validation; a migration test converts the default sequence and checks each step's first planned date is unchanged for a Monday start.

### C4. Sequence editor (#19, #20)

- Required fields marked with a red asterisk: name, duration. Everything else optional.
- Duration field (days) with an optional calendar strip: a row of *duration* cells, weekends shaded; clicking a cell sets the selected step's day; hovering shows "Day 9 · rolls to Mon if the campaign starts on a Thursday" style text only in the tooltip.
- Step cards show the day and the wait from the previous step; the strip and the cards stay in sync.
- Drag as in C2. Adding a module to a step, and both modules appearing inside one task, are unchanged.

### C5. Campaigns: dates, capacity, tabs, form, detail (#2, #12b, #21, #22, #25, #26)

**Model** (`prisma/schema.prisma`, migration `campaign_window`):
- `Campaign.endDate` (required for new campaigns; existing ones get `startDate + sequence.durationDays` and are flagged for review on their page).
- `Campaign.productInterest String[]`, `Campaign.description` (renames `notes`), `Campaign.startsPerFoPerDay Int` (the planned rate), `Campaign.hardStopAtEnd Boolean default false`, `Campaign.assignmentMode` kept but defaulted to OWNER and hidden from the form.
- `dailyRampPerFo` is superseded by `startsPerFoPerDay` and dropped after conversion.

**Capacity planner** (`src/lib/engine/capacity.ts`):
- Inputs: sequence (steps, `durationDays`, touches per person *k*), window [start, end], pod FOs with their caps, and the committed load per FO per day from existing pending tasks in the window (`foLoad`).
- Starting window: working days from `start` to `lastStart = end − (durationDays − 1)`, minus the roll allowance (the last step rolls forward at most to the next working day; the planner checks the resolved date ≤ end).
- For each FO, simulate: place *r* starts on each starting day, generate every step's resolved date, add to the committed load, and require every day ≤ cap. Binary-search the largest *r*. Audience capacity = Σ over FOs of *r_f × W*. Per FO: `r_f × W`.
- Output: `{ perFo: [{ fo, rate, capacity }], total, lastStartDate, worstDay }`, plus the two remedies with their numbers: the end date that would fit the chosen audience, and the audience that fits the chosen end date.
- Worked example: sequence of 4 touches over 14 days; cap 40; three FOs; start Mon 21 Sep, end Fri 30 Oct → last start Fri 16 Oct → 20 starting days. Naively 40 / 4 = 10 starts a day, but weekend rolls stack seven starts' worth of touches onto Mondays, so the simulation gives **5 a day → 100 per FO, 300 in all**. (Corrected during implementation: the planner's test pins this number.)

**Engine**:
- `activateCampaign` schedules start dates from the planner's rate (replacing `dailyRampPerFo`), owner-first assignment as today.
- A scheduled campaign whose audience grows (C6) re-plans and refuses the addition if it no longer fits, naming the number.
- At `endDate`: the scheduler marks the campaign `COMPLETED` when no enrollment is active; if some are, the campaign shows "N ran over" and stays `ACTIVE` until they finish, unless `hardStopAtEnd`, in which case the remaining enrollments exit with reason `campaign_ended` and their tasks are cancelled.

**Campaigns page** (#21):
- Tabs: Upcoming (DRAFT, PENDING_APPROVAL, SCHEDULED), Active (ACTIVE, PAUSED), Finished (COMPLETED, STOPPED). Default Active, else Upcoming. Counts on the tabs.
- Filters in one row: search, pod, sequence, product, FO, date range. Sort control as elsewhere.
- Columns per tab. Upcoming: campaign, pod, sequence, starts in, audience / capacity ("180 of 200"), approval state, actions (approve, launch now, edit). Active: campaign, pod, progress ("Day 12 of 40" with a bar), people, touches done / planned, replies, meetings, actions (pause, stop). Finished: campaign, pod, ran, people, replies, meetings, reply rate, actions (re-enrol non-repliers, duplicate as new).

**Create form** (#25), two columns:
- Left "Campaign": Name*, Sequence*, Pod*, Product* (from Twenty's product-interest options, multi-select), Start date*, End date*, Description. No FO assignment, no ramp, no "?" icons. Under the dates, the capacity line, live: "Fits up to 600 people · 10 a day per FO · last start Fri 16 Oct", turning red with the remedy when the audience exceeds it.
- Right "People": one picker with the same filters as People (pod, FO, tier, type, product, tag, sequence state, account search), sorted like the directory (nameless last), paginated 100 a page with "1–100 of 8,122". "Select all 8,122 matching" selects every id for the current filters, computed on the server, no 5,000 limit. Deselection bug: the selection is a set keyed by id, kept in a ref so a late search response cannot overwrite it; a test races two searches. "Upload a list (CSV)" remains as a secondary tab; paste-ids and Twenty view are removed.
- Review, automatic: as the selection changes (debounced), the form shows who will start, who is skipped and why (already in a sequence, do-not-contact, opted out, internal, blocked account, no eligible FO) — the existing preview, run without a button, titled "Who starts".
- Approval flow unchanged.

**Campaign page** (#26):
- Header band: name, status, pod, sequence, product; a timeline bar from start to end with today's marker, the last-start marker, and per-day touch counts underneath (planned vs done).
- Stats: people, started so far, touches done / planned, replies, meetings, reply rate. Replies and meetings count only events between the campaign start and end (or now) for people in the campaign, computed from touches and meetings rather than enrollment status.
- Audience table paginated (50 a page) with search; "On launch" column as today.
- Per-FO table with capacity used.
- Scheduled campaigns show "Starting soon" panels on Tasks (for FOs in the pod), on the people and account pages of its members, and on Home for managers.

**Tests**: `capacity.test.ts` (the worked example, weekend roll stacking Monday, committed load from a second campaign reducing rate, refusal with both remedies); `campaign-window.test.ts` (end-date completion soft and hard, membership growth refused when over capacity); picker race and select-all e2e; the three tabs and their defaults e2e.

### C6. People and campaigns (#10, #15, #12b)

- `src/lib/campaign-membership.ts`: `membershipFor(personIds)` returns, per person, the scheduled campaigns holding them (`personIds`) and the running or finished enrollments; `membersOf(campaignId)` the reverse.
- **People table**: two columns replace "Campaign / sequence": **Campaign** (name, status chip Upcoming / Active / Paused / Replied / Meeting / Finished) and **Sequence** (name · "Step 2 of 6"). Nothing numeric where a name belongs.
- **Filter row**: "Campaign" dropdown in the first row, always present, listing Upcoming and Active campaigns (grouped), with a disabled "No campaigns yet" state when empty.
- **Bulk bar**: "Add to campaign" opens a dialog listing Upcoming and Active campaigns for the people's pods with their capacity left ("Q4 nurture · Upcoming · 42 places left"), and "New campaign" at the end, which opens the form with the selection filled. Adding to a scheduled campaign appends ids and re-plans; adding to an active one enrolls now (start today, owner-first) within capacity. Over-capacity is refused with the number.
- When the Campaign filter is set, the bulk bar also offers "Remove from campaign" (per row and in bulk). Scheduled: ids removed. Active: enrollment exits with reason `removed`, tasks cancelled, note not written (nothing was done). Confirmation names the count.
- **Person page**: "Add to campaign" / "Remove" in the header; a Campaigns card listing upcoming and current with their dates.
- Server actions in `actions/campaigns.ts`: `addPeopleToCampaign`, `removePeopleFromCampaign`, both pod-scoped like enrollment writes today, audited.
- Tests: add to scheduled, add to active, remove from each, capacity refusal, the filter listing, and the person-page controls, for a Senior FO and for Biz Ops (refused).

### C7. Accounts (#5, #6, #7)

- Column "In sequence" becomes **In a campaign**: "3 of 12" with a small proportion bar; hover names the campaigns. Filter "In a campaign: any / everyone / nobody" in the toolbar. Stat tile "Accounts with someone in a campaign".
- Replies and Meetings are all-time totals; headers say so on hover (C1).
- Account page people table: **Campaign** (name) and **Sequence** (name · step N of M) columns; no bare numbers.
- Two new tabs on the account page: **Meetings** (the account's meetings with date, attendees, transcript state, favourite) and **Tasks** (open and upcoming touches for anyone at the account, next 30 days, grouped by day, each linking into Tasks). The existing "Campaigns and tasks" tab becomes "Campaigns".

### C8. Record pages: character, sections, calls, live read (#8, #11, #12, #13, #14, #27)

**Character (seeded, not random)**. Each person and account gets an accent chosen deterministically from six that sit inside the brand palette (moss, sage, clay, slate, plum, sand), keyed by a hash of the record id, so a record always looks the same to everyone. It applies to: a header band with a soft gradient and a 4 % geometric pattern, the avatar ring, the eyebrow labels and the stat numbers on that page. Typography rules hold (weight only on the primary element; no bold in running UI). Screens are captured for review.

**Person page**:
- Tabs: Overview, Campaigns, Activity, **Emails**, **Notes**, Tasks. Emails and Notes are separate tabs, each with its own count in the tab ("Emails 14") taken from Twenty's total so a gap between what Twenty holds and what is shown is visible at once.
- **Tasks tab** (#14): open and upcoming touches for this person over the next 30 days, plus overdue, grouped by day, with the step and channel, linking into the Task flow; scheduled campaign starts appear as "Starts Mon 21 Sep · Q4 nurture".
- **Calls** (#13): the Call button and every phone number open the dialpad link (B7). `tel:` links go.
- **Live read** (#27): the page renders from the cache immediately; a streamed `LiveRecord` component re-reads Twenty after paint and, if anything changed, refreshes the record in place. Failures never render; they increment a health counter shown in Settings > Twenty and trip a five-minute circuit breaker after three. The header shows "Synced 2 min ago".
- **Email and note formatting** (#11): the formatter is run against real exports. This needs three or four raw messages and notes from the live workspace (any person; copied from Settings > Activity log > Inbound events, or from `sync:diagnose --sample 5`, which this round adds). Known remaining cases to handle: Outlook signature tables, `<span>`-only bodies with `<br>` runs, and Markdown notes with hard-wrapped lines.

**Account page**: same character treatment; the two new tabs from C7.

### C9. Meetings (#18)

- **Star**: an optimistic toggle with no status text; the star fills or empties, nothing else appears.
- **Analysis**: column removed from the list and the badge from the page until the assistant is configured (B8).
- **Transcript follows the audio**: it already does for direct media. For SharePoint and OneDrive share links the server tries the link with `?download=1` and follows redirects; if the result is video or audio, that direct URL is stored as `mediaUrl` and the native player is used, so following works. Google Drive share links resolve to `uc?export=download&id=`. Zoom, Teams and Meet join pages cannot be framed or fetched and keep the current "open in a new tab" path. The stored `provider` gains `resolvedFrom` so the meeting page can say which path it took.
- **Clean transcript**: `normalizeTranscript(cues)` produces "Speaker: dialogue" text, merging consecutive lines from one speaker, dropping cue ids and timestamps, carrying the previous speaker forward onto unlabeled continuation lines (the fix for "Unknown"), labelling anything before the first speaker "Unattributed". Both the transcript view and the talk-time table are built from the same normalized cues. Copy and download of the clean text from the meeting page. Accepts WebVTT, SRT, JSON (Zoom, Teams, Otter, Fireflies shapes), plain text with or without timestamps.
- **Add a meeting from a link**: paste the link; the server resolves the provider, fetches the page's title and description where the link allows it, and pre-fills name, date (from the title, the description, or the file name), company (a Dummy Company-style name match against the cache), and the embed or media link. If a transcript is pasted or uploaded in the same step, attendees are pre-filled from its speakers matched against the people cache (external ones flagged), and the duration from the last cue. Everything pre-filled is editable before saving. Meet, Teams and Zoom links are recognised as join links and stored as such.
- Tests: normalization with a Teams VTT containing continuation lines (talk time has no "Unknown"); SharePoint `?download=1` resolution with a fake server; the smart-add pre-fill from a title like "Acubooth <> Alisa - 12 Sep 2026".

### C10. Enrichment (#16)

Today: a queue of gaps, filtered by kind and search, exported and re-imported. Target: the place where the team runs data quality as work.

- **Filters** in one row: search, pod, FO (owner), tier, contact type, product, account, gap kind (multi, as today), priority, "in a campaign", and a Twenty tag; sort by name, account, number of gaps, last synced.
- **Views**: Contacts, Accounts, Imports (as today), plus **By account** (gaps grouped under the firm, so a whole account can be sent for research at once) and **Scorecard** (completeness per field, per pod, per FO, with a nightly snapshot so trend shows).
- **Actions on a selection**: export exactly the selected rows and gap fields for a vendor (CSV with ids), "Assign research to" a person (a Cadence-side owner on the gap, shown in the queue), "Not found" (closes the gap here with who said so and when; reopens if Twenty later fills it), and "Fix in Twenty" deep links per row.
- **Suggestions that are facts, not guesses**: a person's email domain matching a company domain in the cache proposes the account link; a company domain that is a free-mail domain is marked "not an account" (B5).
- **Imports**: mapping remembered per header signature ("Clay export" applies its last mapping), duplicate rows within a file flagged, and rows that change nothing shown as such before applying. The existing conflict check (CRM value moved since preview) stays.
- Tests for each filter, the scorecard maths, "not found" closing and reopening, and mapping memory.

### C11. Reports (#28, #29, #32)

- **Table view**: one KPI table with the roll-ups by pod, FO, campaign, sequence and channel over the chosen range, each with the previous period beside it and the change; sortable; range presets (this week, last 4 weeks, quarter, custom). Stalled and overdue lists stay.
- **Infographic view**: KPI tiles with a sparkline each (enrolled, touches, replies, meetings, reply rate), the funnel enrolled → touched → replied → meeting, the activity heatmap by weekday × FO, campaign progress bars (day of window, touches done), and the leaderboard. Built with the `dataviz` skill's palette and rules, light and dark, no chart junk.
- **Export** (#32): `GET /reports/export?…` returns one self-contained HTML file (inline CSS and SVG, no scripts) with the applied filters and range, the same tiles and charts, the tables, and "Generated 18 Sep 2026 14:02 by Ria" — printable to PDF. Same roles as Reports.
- Visibility (#29): as B6; verified live.
- Tests: totals in the table equal the export's; period comparison with a known seed; role gate for each seat.

### C12. Notification chime (#30)

- A short two-note chime (Web Audio, generated, no asset) plays when the unread count rises while the app is open, once per new notification id, after the user's first interaction (browsers block sound before that). A per-user switch in the bell's menu, on by default. `LiveRefresh` carries the unread count so the client sees it change without a reload.

### C13. Non-prospect accounts (#31)

- Settings > Blocked accounts gains two lists with defaults (B5): **Never prospects** (vendors and platforms; matched on domain and normalised name; applied as blocked accounts with reason "Known non-prospect", by a one-time job and on every sync for new companies) and **Not accounts** (free-mail domains; hidden from Accounts, people kept). Both editable; unblocking one adds an exception so the job does not re-block it.
- Test: a "Microsoft" and a "gmail.com" company; the first is blocked with its people gone, the second is absent from Accounts while its person remains in People.

### C14. Speed (#33)

Measure first, on the 20,000-person dataset, with server timing headers and the existing `nav-loop` script: TTFB and time-to-interactive per route, before and after. Targets: list pages under 300 ms server time; navigation p95 under 600 ms.

Changes, in the order they pay back:
1. Person and account pages render from the cache; live reads stream after paint (C8).
2. People tag options and Twenty option lists are cached for 60 seconds (`unstable_cache`) instead of a `distinct` scan per render.
3. Accounts aggregates: the list computes counts only for the sorted page when the sort does not need them; for people/replies sorts the grouped counts are cached 30 seconds.
4. Layout counts (today, overdue, unread, needs review) in one grouped query.
5. `LiveRefresh` polls a cheap `/api/version` (latest task/notification `updatedAt`) and refreshes only when it changed; interval 60 seconds; never within two seconds of a navigation.
6. Filter changes show a pending state immediately (`useTransition` is already there; the toolbar dims and the table keeps its height) so a click always answers at once.
7. Bundle: the rich-text editor loads only on pages that edit; check the client chunk of the task flow.

### C15. How often Cadence syncs (#17) - the answer

Four paths run at once. Twenty pushes **webhooks** (`/api/webhooks/twenty`) for people, companies, notes, messages, tasks and opportunities the moment they change - that is the instant path, provided the webhook is configured in the live workspace (Settings > Activity log > Inbound events shows whether any arrive; if none do, only the next path is working). The **worker** runs a continuous pass every 60 seconds (`CRM_SYNC_SECONDS`, 15–300) that fetches everything changed since the last pass. **Opening a person or account** re-reads that record live (kept, but moved after paint in C8). A **nightly reconcile** at 02:00 workspace time catches anything missed. Writes to Twenty happen immediately after the action, with a retry queue. Nothing here changes except the live-read behaviour; the round adds the inbound-events check to the deployed-health section of Settings so "are webhooks arriving" is a number.

### C16. Full diagnosis (#34)

After the workstreams: run the functional and design critics until both score 8/10 (the standing bar); a live walk of the hosted build with the four supplied seats through every section, filter and record page (`pnpm live:check`), reading every console error and failed response; the query-budget test on every list route; an accessibility pass (labels, focus order, contrast) on the redesigned record pages; the hydration and navigation loop scripts on a production build; and a fresh-install run. Findings are fixed in the same round and listed in the review document.

---

## D. Order of work

Four phases; each ends with the full suite green and a pushed commit, so the hosted build can be refreshed at any boundary.

**Phase 1 - foundations and the small fixes.** C1 counts, C2 search/sort/drag, C3 calendar model and migration, C13 non-prospect lists, C15 answer and health line, C14 items 1–5 (they are independent of the campaign work and the lag is felt every day). Also the person page live read (C8) since it is the same change as C14.1.

**Phase 2 - the campaign core.** C5 model and planner, engine changes, campaigns page and tabs, the form, the campaign page; C6 membership and the People/person-page controls; C4 editor. This is the largest phase and the one with the most decisions already made above.

**Phase 3 - the surfaces.** C7 accounts, C8 record pages and sections, C9 meetings, C10 enrichment, C11 reports and export, C12 chime.

**Phase 4 - diagnosis.** C16, critics, live walk, review document.

Dependencies: C5 needs C3 (durations in calendar days) and C6 (membership) needs C5's model. C7 and C8 need C6. C11's infographic needs the campaign window fields from C5 for progress bars. Everything in Phase 1 stands alone.

---

## E. Verification protocol for the round

- Every change carries unit or integration tests in `tests/` and, where it has a screen, a browser test in `e2e/`. New behaviour is asserted as an invariant the owner would notice, as the stress suites do.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e`, `pnpm build` green before each push; CI green before the hosted build is refreshed.
- `pnpm screens` captured and inspected after Phase 3 for every redesigned page; the owner's typography and no-subtext rules applied.
- `pnpm live:check` with the four seats after each phase's deployment; the numbers in section A.1 and A.4 checked live.
- Section C16 in full at the end.

---

## F. What the owner needs to provide

1. Confirmation or objections on section B (defaults apply otherwise).
2. Whether the dialpad accepts a phone number in the URL, and its parameter name (B7).
3. Three or four raw emails and notes from the live workspace that still render badly (C8), or permission to pull samples with `sync:diagnose --sample 5` against production.
4. Whether webhooks are configured in the live Twenty workspace (C15); if unknown, the round's health line will show it.
