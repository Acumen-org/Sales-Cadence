# Directory and CRM content review - 14 September 2026

## Confirmed counting rule

An Accounts pod filter selects companies containing at least one live contact in that pod. The people total then counts **all live contacts at those matching accounts**, including other pods. Each company is counted once. Contacts without a company only contribute to People. This is the behavior the owner explicitly selected; the summary now says **People at matching accounts** and each row says **People at account**. Accounts intentionally does not have the same contact membership as a pod-filtered People list.

## Requested changes

- Accounts replaces Industry, City and Owner columns with PODs, FOs and Product. Associations are deduplicated across the complete account, including contacts outside the selected pod. FOs combine CRM ownership and active/paused enrollment assignments; administrative CRM owners are not presented as FOs.
- People uses **Tags in Twenty** and removes the Recent activity column and timeline. Tag chips use deterministic colours and apply filters. Tier, contact-type and product tags reuse their existing filter. Other CRM tags have a directory-wide dropdown; list categories have their own dropdown. Filter choices survive refresh and pagination. Clearing an FO stays cleared when paging.
- Every existing sort selector (Accounts, People and Enrichment) supports ascending and descending. Sorting occurs before pagination; exports retain the chosen order. People's update sort uses the CRM modification timestamp instead of the latest sync timestamp.
- CRM email queries now request the mapped body field, which was previously omitted. Email and note bodies open in full, with cursor navigation to older records. Emails separate From, To, Cc and Bcc, and sanitize HTML content before rendering. Notes retain their complete body and author. Missing source bodies and unavailable CRM responses remain explicitly identified.
- Sync feedback uses a dismissible, temporary portal toast. Its button keeps the same label and dimensions while running; completion feedback adds no content to the filter toolbar.

## Verification

- Production build, lint and type checking passed.
- 325 unit/integration tests passed, including full email/note query content, mixed-pod account counts, associations, both sort directions and enrichment ordering.
- The scale test exercised 20,000 contacts / 6,000 companies with 12 concurrent account-page reads; all pages contained the expected distinct records.
- 56 browser tests passed, including the sync button/search bounding-box check and automatic toast dismissal. Browser coverage includes tag click/reset/reload, account columns and numeric sort order, export direction, four simultaneous seats repeatedly visiting seven sections, and desktop/mobile layouts.
- Hosted read checks passed for the supplied Admin, POD Manager, Biz Ops and FO accounts across People, Accounts, Meetings and Enrichment: 16 successful routes, no browser errors. Those checks validate the deployed baseline; new behavior was verified against the local production build before pushing.

## Release boundary

The repository workflow builds and pushes an image to Harbor after checks pass. Its current configuration explicitly leaves deployment manual. A successful GitHub push or image build alone does not establish that the hosted site is running that commit.

---

# Table width, sorting, blocked accounts and email reading - 14 September 2026 (second pass)

## Accounts

- The table no longer scrolls sideways. Its nine columns have fixed shares that add up to the
  table, the padding is the denser one People already used, and the headers wrap instead of
  pushing the table wider. The account name column is the narrowest of the change: names truncate
  with the full name on hover. A browser check now measures the scroll width of both directories
  and fails if either overflows by more than a pixel.
- PODs, FOs and Product show one tag and then `+N`, which opens the rest in place - the same
  control People already used for Twenty tags, now shared by both (`src/components/pill-list.tsx`).
  A collapsed row never wraps, so every row is one line high.
- The search box says what people type into it: **Search name or domain**, not the industry and
  city columns that were removed.
- The `mine` badge is gone from the list rows. It was the last of the "Mine" chrome that was
  asked to be removed, and it competed with the account name for the narrower column. The account
  page still says so in its header.

## Sorting

The direction dropdown is gone everywhere (Accounts, People, Enrichment). In its place:

- One control: the sort menu with the direction as an arrow button attached to it. Clicking the
  arrow reverses the order; choosing a different field drops the explicit direction, so a date
  opens newest first and a name A-Z without anyone setting it.
- On Accounts, the columns sort themselves. Account, People at account, In sequence, Replied and
  Last touch are buttons; the one in force carries the arrow, and clicking it again reverses it.
  `aria-sort` is set on the header, and the control still drives the same `sort` and `dir`
  parameters, so a link or a reload lands on the same order.

## People

- **Any list category** is gone from the filter bar. The parameter still works, so a list-category
  tag clicked in the table still filters and still shows as a removable chip.
- The bar is one row: search, pod, FO, **Filters**, and the sort control. Product, tier, contact
  type, Twenty tag and sequence state live behind the Filters button, which carries a count when
  any of them is set and opens by itself when a URL arrives with one. Active filters stay visible
  as removable chips whether the panel is open or shut.
- The FO dropdown lists active users in a sales role (Junior FO, Senior FO, Sales Leader, Pod
  Manager) who belong to a pod. Admin and Biz Ops seats are deliberately not outreach owners, and
  a sales user who has not been put in a pod does not appear. Three names means three such users
  in Settings > Team & pods; adding more there adds them here.

## Blocking an account

An admin can take a firm out of Cadence, from a button on its account page or from
Settings > Blocked accounts (with an optional reason). Blocking:

- removes the account from Accounts and its people from People, global search, enrichment and
  campaign audiences;
- refuses any new enrollment with its own reason, "Account blocked in Cadence";
- ends the sequences its people are in (`exitEnrollment`, reason `account_blocked`), which cancels
  the open tasks through the normal path and mirrors the cancellation to Twenty;
- leaves CRM people, companies and cache rows unchanged, so inbound activity still matches
  those people and the history stays intact.

The blocked account's page stays open to an admin, carrying a banner with who blocked it, when,
and why, and returns a 404 to everyone else; the people on it stay reachable for that admin alone.
Unblocking puts the account and its people back immediately. A sequence that ended stays ended:
restarting outreach is a decision somebody makes. Blocking is administration, so it lands in the
audit log and stays out of the Activity feed, beside settings, users and pods.

## CRM emails and notes

Each email is now its own framed card instead of a row in a divided list: a green edge and a
**Received** badge for what came in, a red edge and **Sent** for what went out, a grey one when
the sender is neither one of our users nor the person. The direction is the engine's own rule
(`classifyMessage`), not a second opinion. The header carries the direction, the subject, who sent
it and who it went to, and the date; the body sits below with its recipients, a readable measure,
quoted text set apart, and wide tables and images kept inside the card. Notes get the same framing
without the colour.

## Meetings

The Attendees column no longer breaks across two lines: the count and the "N external" tag sit on
one row, aligned, with the count in tabular figures.

## Verification

- Production build, TypeScript and lint pass.
- 330 unit and integration tests across 48 files pass, including a new file for blocking: the
  account and its people leaving every directory, the cache rows surviving, enrollment refusing
  them, the sequences ending with their tasks cancelled, who may open the page, and unblocking.
- 61 browser tests pass, including the new width measurement of both directories, the collapsed
  FOs column, header sorting in both directions, the Filters panel, and an admin blocking and
  unblocking an account end to end while a second seat is refused the control and the settings tab.
- Screens were captured and inspected for the accounts table, the people bar, the meetings table,
  the CRM email cards and the new settings tab.

## Verification review - 15 September 2026

Reviewed the uncommitted changes against the requested checklist and preserved the newer GitHub deployment/security commits through 77fad87. The hosted baseline still showed the previous direction dropdown; the local changes were not yet deployed. All four supplied seats could read the main directories, and each offered three eligible sales users in its FO dropdown.

Corrected duplicate React keys in the account column definitions and added error handling for blocked-account search/actions. Blocking, enrollment, campaign activation and task generation now coordinate account locks; block creation, enrollment exits, task cancellations and audit records commit together. A concurrent enrollment/blocking regression verifies that no active enrollment or pending task remains. Existing CRM task mirrors are resolved normally; CRM people and companies are unchanged.

The current GitHub workflow now builds AND deploys through Nomad, replacing the older manual release boundary described above. The release includes the BlockedAccount database migration, applied by the web task on startup.

Final verification: production build/type checking/lint passed; all 332 unit/integration tests passed against an isolated database; all 61 browser tests passed, followed by 8 release-build directory/permission checks after the final backend changes. Screens for account chips and CRM message framing were inspected. No live accounts were blocked and no live CRM data was edited during verification.


## Sorting, content completeness and workflow regression - 15 September 2026

People name ordering used surname-first keys even though the visible label is first-name-first. The cache now uses display order; migration `20260924000000_display_name_sort` backfills existing rows. Nameless accounts retain their position after named accounts but reverse their domain fallback when direction changes. Independent filter, tag, header and sort controls now share the pending URL, preventing rapid interactions from overwriting each other. Direction changes use that pending state rather than stale rendered props.

CRM note titles and email subjects wrap in full. The brief no longer cuts note bodies at 180 characters; contact activity preserves the source note body when the note is represented by a touch. Twenty reads request both markdown and BlockNote, decode nested paragraphs, links and table cells, and use the longer editor content when markdown contains a shorter summary. Email HTML renders with normal whitespace, safe paragraph boundaries and compact empty spacers. Plain messages retain paragraph breaks with excessive blank lines collapsed. The existing strict sanitizer still rejects scripts, event handlers and tracking images.

Validation: production build and lint passed; 337 unit/integration tests passed in an isolated migrated database. All 62 browser tests passed against the final production build. Browser coverage includes first-name ordering in both directions, a pending search plus sort change, clear/reload filter behavior, task draft editing and completion, call outcomes, mixed steps, sequence editing locks, campaign launch and follow-up approval, and role permissions. Engine stress coverage includes 16 concurrent enrollments, 32 duplicate webhook deliveries, simultaneous child-action completion, sequence-edit/generation races and campaign lifecycle gates. Twelve concurrent account queries over 20,000 people and 6,000 accounts completed in 579 ms locally; this is not a hosted capacity measurement.

Read-only live sampling covered 12 contacts, 109 notes and 121 emails. Many source note bodies appear unusually short; the exact reported truncated note has not been identified or compared with the original CRM record. The code removes known display truncation and reads the alternate editor body, but does not fabricate text absent from both source fields. No live tasks, campaigns or CRM records were modified during testing.
