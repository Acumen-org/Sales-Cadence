# September checklist verification - 20 September 2026

Baseline: `d795ac6`, clean working tree, identical to GitHub main when reviewed. This reviews the current implementation rather than reapplying earlier changes. The attached 26-point list is the acceptance checklist.

| # | Result | Evidence / remaining work |
|---|---|---|
| 1 | Present | Tasks no longer includes the upcoming-campaign banner; checked in source and live. |
| 2 | Present, refined | MIP replaces Sequence, three empty-by-default pod/admin-controlled stars, first-row toggle. Filter now accepts the same case variants as the star renderer. Authorization and persistence have integration coverage. |
| 3 | Not complete; campaign discussion | The database enforces one live enrollment per person, which is stricter than one live campaign. Concurrent standalone sequences alongside campaign outreach require a coordinated migration. Do not mark this implemented. |
| 4 | Present | America/Chicago default, configurable in Settings > Rules; validated timezone setting and scheduling readers. |
| 5 | Present | Applied Account filters occupy a separate chip row. |
| 6 | Present, corrected | Accounts count observed inbound replies rather than only campaign status. Fixed historical reply attribution in Home/Reports: replies stay with the latest sequence that had started at the reply date, rather than moving to a future/newer campaign. Automatic replies remain excluded. |
| 7 | Present | Account detail headers use a stable record colour and seeded ornament within the existing design. |
| 8 | Present for sales roles; role clarification | Bulk selection is visible to everyone; sales members manage their pod, Admin manages all. Already-in-campaign bulk Add is disabled. Bulk Remove was red; per-row Remove is now red too. Biz Ops remains read-only pending clarification of the newer word "everyone" versus its existing read-only role. Opt-out/do-not-contact records remain excluded from outreach selection. |
| 9 | Present | Authenticated users can Sync now; the fixed-position toast slides in without moving controls. |
| 10 | Present | Contact detail headers use the same record colour/ornament system. |
| 11 | Present | Person campaign membership combines upcoming audiences and launched history; tab count and rows share that membership. Tasks no longer carries campaign announcements. |
| 12 | Improved, not instant | Existing changes cache directory options and reduce repeated CRM reads. Fixed the refresh poll's missing initial baseline and a refresh race while the user starts typing. Editing a meeting with an unchanged recording link now reuses its resolved media instead of refetching that provider. Network/CRM/provider calls still have real latency; no claim that every action is instant. |
| 13 | Present, corrected | People / Accounts / Scorecard only; priority/open-gaps controls and Imports navigation removed. Records links now include complete records so their totals match the scorecard. FO account grouping now uses the same company/contact ownership associations as the destination queue; filters/export retain that view. |
| 14 | Corrected | Owner label is concise; research/import stat boxes are gone. Address previously only checked City. It now checks the CRM street-address fields; full company address fields are requested. A migration schedules a complete cache refresh so unchanged records receive the additional fields. |
| 15 | Partial, extended | Analysis column, Cadence AI panel and live transcript talk share are present. Ready now requires actual saved model output. VTT/JSON/grouped parsing exists; a new browser test plays real audio, follows an uploaded VTT and seeks via timestamps. Direct audio links are supported. Public page captions, when explicitly provided as caption tracks, can autofill the transcript and speakers; discovered media/captions are persisted. Private provider recordings/transcripts still need provider access; a join URL alone contains no recording or transcript. The current analyzer is local talk-time statistics only: no model-backed summary integration is connected. A provider/contract has been requested. |
| 16 | Present, corrected | Recording link optional; Booked by required, editable and filterable. Server validation now requires a sales role, matching the picker, instead of accepting any active Admin/Biz Ops ID. Booker edits preserve existing analysis; changed transcripts invalidate it, and analysis finishing after a transcript edit cannot overwrite the newer state. |
| 17 | Not complete; campaign discussion | Full editing of upcoming campaigns is absent. Implement this with the coordinated planner changes requested for discussion in point 18; active planning fields should remain locked. Existing pause/stop/member controls are separate. |
| 18 | Discussion, not completed feature | Current planner accounts for action load and dates, but derives starting rates automatically. The creator-selected rate, authoring caps and explanatory FO/day utilisation view are not implemented. The revised proposal explains why reducing starts cannot fit a long sequence into a shorter date window. |
| 19 | Not complete; campaign discussion | Campaigns still have one sequence. Per-person sequence choice and simultaneous standalone sequences are specified in the revised proposal, not claimed shipped. |
| 20 | Present | Decorative question-mark hints removed; Help keeps an accessible name. |
| 21 | Present UI; planner discussion | Unexplained last-start marker/legend removed. Its useful meaning is documented in the capacity proposal; no hidden change to campaign date rules. |
| 22 | Not complete; campaign discussion | Explicit creator-selected FO roster is absent. Proposal preserves selected CRM owners, flags unselected-owner conflicts and balances only genuinely unowned contacts. |
| 23 | Present, completed | Visible report headings use Started rather than enrollment language. Removed the remaining "Direct enrollments" group label, replacing it with "Standalone sequences". |
| 24 | Present, corrected refresh | Sound toggle and test chime exist; new unread counts trigger sound after browser interaction. Refresh now records the initial data version immediately, avoiding the extra first polling interval. Browser audio permission and the user's sound preference still apply. |
| 25 | Reviewed and regression tested | Baseline build and 407 unit/integration tests passed. Added correctness and real-media regressions; final validation results are recorded below. This is a bounded audit, not a proof that no defect exists. |
| 26 | Present | Home no longer shows the upcoming-campaign banner. |

## Additional meeting-link safeguard

Link inspection previously followed arbitrary redirects after checking only the initial host, and did not reject private IPv6 addresses. It now validates every redirect, resolves and pins a public DNS address, limits the response body, and stops downloading media after headers. Regression cases cover private IPv4/IPv6 and redirect attempts. A public HTTPS metadata request was also checked successfully. No third-party recording library or provider bypass was added.

Address field names were verified against [Twenty's address schema examples](https://github.com/twentyhq/twenty/issues/20599). The public-link client uses [Node's HTTPS request options](https://nodejs.org/api/https.html) to keep the original TLS server name while connecting to the checked address.

## Live checks and limits

Read-only login and nine section visits for each supplied Admin, Pod Manager, Biz Ops and FO account: 36 responses with HTTP 200 and no captured page errors. No production campaign, outreach task, transcript, AI request or CRM record was created/edited for this review. These observations verify the existing deployed baseline; local fixes require deployment.

The campaign proposal is rewritten in `CAMPAIGN-MODEL-PROPOSAL.md`. Points 3/17/18/19/22 remain a coordinated design discussion because point 18 explicitly requests that before implementation. The core recommendation is separate new-start limits from daily action capacity, simulate every scheduled action through the deadline, explicitly select FOs, and support one campaign plus independent sequences without losing reply/history integrity.

## Final validation

- 417 unit/integration tests passed across 61 files, using an isolated database. This includes campaign concurrency, duplicate webhook delivery, combined-action completion, sequence edit protections and the new regression cases.
- 73 Chromium browser tests passed against the final production build. The meeting regression uploads a VTT, plays a real audio fixture, seeks by transcript timestamp and checks the active cue.
- Production build, TypeScript checks and ESLint passed; `git diff --check` was clean.
- The directory stress fixture covers 20,000 people and 6,000 accounts; 12 concurrent account-page queries completed in 1.295 seconds locally. This is a repeatable regression check, not a production throughput guarantee.
- Read-only live FO timing checks measured warm contact-tab transitions around 0.48–1.03 seconds and account-tab transitions around 0.43–0.45 seconds. The first cold contact document took 4.96 seconds (5.73 seconds through load), so point 12 is not fully achieved and needs further production profiling. No claim of instant navigation is made.

Local test logs and authenticated live captures remain in ignored `.review/` files and are not committed. The enrichment helper's embedded NUL separators were replaced with equivalent escaped separators, normalizing that file's line endings so Git can review it as ordinary text.
