# Current requirements audit — 13 September 2026

This review starts from GitHub `de40e81`. It checks the two lists supplied in the latest request. The earlier eighteen points remain the baseline; this does not repeat the historical audit's claim that everything is production-ready.

## Deployed app versus source

Signed in successfully with the supplied Admin, Pod Manager, Biz Ops and FO accounts. Walked sixteen routes per account, including explicit clearing of directory filters, and inspected existing meeting records and contact CRM-history tabs. No outreach, real campaign, contact deletion or external call was created for this audit.

The deployed interface differs from GitHub: Accounts still has Mine and website subtitles; Meetings lacks the new filter toolbar/favourites; Enrichment still has inline missing-field controls. Those changes already existed in `de40e81`, whose GitHub CI passed. A green CI run is not evidence that the server deployed it. The current workflow runs checks; deployment is managed outside that workflow. The deployment-service details have been requested from the owner.

Live evidence at the start of this review:

- Twenty connection: reachable, dry run **off**, continuous sync reported healthy. Cached/Twenty counts matched: **8,371 people**, **4,931 companies**. These are raw CRM counts, before directory exclusions.
- Clearing both People filters produced **8,159 results** across the tested seats. Clearing Accounts filters produced **4,931 accounts** in the old build. Different directory and raw-cache counts can be intentional; internal/deleted records are excluded from prospect views.
- All four seats could read the same **three meetings**. Their SharePoint recordings were still rendered as frames by the deployed build; authenticated playback inside Microsoft 365 was not verified.
- Sample contact history pages returned real CRM notes and emails without a Twenty connection error. An empty history for another contact was displayed as empty, not fabricated.
- No live sequences, campaigns or tasks existed, so production outbound-email/call auto-completion and delegation could not be exercised on existing work. These were tested with isolated data.
- One Accounts navigation emitted React hydration error #418 on the old deployment. It was not reproduced by the updated local browser suite.

## First quoted list

| # | Requirement | Finding and current implementation |
|---|---|---|
| 1 | Team members excluded from People | Previously incomplete. Exclusions now cover member email/aliases, internal email domains and internal company membership, including a colleague with no email. The raw CRM records remain available for activity matching. Regression tested. |
| 2 | Pod Manager and Biz Ops roles | Roles already existed. Pod Managers manage their own pods and read other pods; admin settings remain restricted. Fixed Biz Ops meeting creation/editing, including records they previously created, and legacy assigned-task write access. Biz Ops can now inspect other members' enrichment imports without approving/applying them. Personal meeting favourites remain available. |
| 3 | Low-overhead recurring follow-up | Repeatable sequences already exist: use a repeat gap of 5/10/15 working days for 1/2/3 business weeks. The gap starts after the last touchpoint finishes. A new cycle preserves history and stops on reply/meeting/exit/opt-out. Combined-action repetition and explicit exit tested. **UI limitation:** adding people currently goes through campaign setup; one standing nurture campaign avoids creating a campaign each cycle. There is no separate campaign-free reminders inbox. |
| 4 | Delegate tasks | Existing delegation moves the selected current touchpoint to a pod colleague and preserves the enrollment owner for subsequent steps. Fixed eligibility so Admin/Biz Ops seats are not outreach assignees, and made the update fail atomically if a selected task changed concurrently. Pod-manager delegation, retained enrollment ownership and cross-pod rejection tested. |
| 5 | Mandatory user fields and role defaults | Name, email, initial password and sales-role pod requirements already exist. Tasks had the correct Junior FO self+pod defaults; People/Accounts did not. Fixed those directory defaults and People FO filtering to include CRM-owned contacts even with no campaign. Clearing both filters remains explicit through navigation/reload. Existing Senior FO semantics treat that role as a pod leader (pod default, all FOs); Junior FO defaults to self. |
| 6 | Missing companies | Live cache and Twenty both reported 4,931, not three. Source pagination already retrieves all companies. Fixed internal-domain exclusion so null-domain prospects remain visible and unrelated substring domains are not hidden. |
| 7 | People/Accounts ownership filters and sorting | Pod, FO, search, sorting and CRM classification filters exist. Account ownership can be reached through multiple contacts/pods. Fixed People FO filtering, excluded nonsales seats from FO selectors and reset Accounts pagination when changing filters. |
| 8 | Meetings visibility, recordings, transcripts | Shared visibility verified across all live seats. Upload/parsing already supports VTT, SRT, grouped text and supported JSON shapes. Fixed minute:second VTT timing, UUID cue identifiers leaking into dialogue, merging distant turns, and playback highlighting getting stuck on a cue with no end time. **Playback limitation:** transcript following works with the native direct-media player. SharePoint/Drive embeds do not expose that playback clock to Cadence. SharePoint sharing URLs need an external link or an actual embed URL with Microsoft access; Cadence cannot bypass provider restrictions. |
| 9 | Enrichment missing-information filters | Source already has a dropdown and multiple removable missing-field selections, with name/company/gap sorting and no City gap or priority filter. Multiple fields match **any** selected missing field. Fixed the chip's literal escape characters, search reset and multi-word search. Export now uses the same filters/sort as the displayed list. Relationship gaps explain that the link must be set in Twenty. |
| 10 | Continuous sync, deletion consistency, history and search | Live writes were enabled; no need to disable a dry-run flag. Worker defaults to a 60-second sync interval and has separate deletion/full reconciliation paths. Sync now exists for admins. Broad search and cross-seat reads verified; sampled CRM emails/notes returned successfully. No production contact was deleted to test this; deletion reconciliation has automated coverage. Actual latency depends on worker uptime and CRM response time. |
| 11 | Auto-close email/call actions, combined touchpoints | Existing ingestion observes Twenty messages/call evidence, matches the owner/evidence window and resolves the corresponding action. LinkedIn stays manual. A combined touchpoint does not advance/repeat with another required action pending. The automated engine tests cover evidence, duplicate events, replies and task transitions. **Live outbound transport remains unverified**, because there was no live work to exercise without creating outreach. |
| 12 | Tokens in authoring, clean task copy | Existing task creation personalizes supported tokens and retains a task-specific snapshot. The editor allows authoring tokens; task views are checked for unresolved placeholders. Existing browser tests also edit and persist actual task drafts. |
| 13 | Respect owners and balance unassigned contacts | Previously, an unavailable CRM owner silently fell through to balancing, and input order could overload owners. Fixed OWNER mode: unavailable owners produce an explicit conflict; eligible owner assignments are reserved first, then genuinely unowned contacts go to the least-loaded eligible salesperson. Explicit round-robin remains an intentional alternative assignment mode. |
| 14 | Strong campaign audience selection | Search, pod, FO, product, tier, type and sequence-state filters already existed. Added pagination so contacts beyond the first 300 can be inspected/selected; stale search responses cannot overwrite newer results. Bulk selection clearly states its 5,000-record limit; larger audiences need batches. Explicit/pasted internal contact IDs are also rejected at enrollment. |
| 15 | Product interest filters | Present in People and Accounts and backed by CRM product values. Accounts are matched through their contacts' interests. |
| 16 | Quality-of-life pass | Fixes above, permission-consistent meeting controls, visible FO dashboard filters, restored search inputs after reset/back navigation, filtered enrichment exports, and regression coverage for new roles. Existing UI/design retained rather than reapplying the earlier redesign. |

## Second quoted list

| Requirement | Finding and current implementation |
|---|---|
| Working enrichment dropdowns | Already in GitHub, absent from the deployed UI at audit time. Multi-selection/reset/export tested in the browser after the fixes. |
| Hide Acumen Strategy, Glynac, Prairie Hill and Acumen Talent | Existing domain-only filtering was incomplete. Configurable **Our own organisations** in Settings matches normalised CRM names, including hyphenated names, alongside exact/subdomain website matching. Prairie Hill Holdings is included as a known name. This filters prospect directories and enrichment; it does not delete cache records, rewrite CRM data or block inbound ingestion. Additional aliases can be configured when identified. |
| Meeting favourites and favourite filter | Already implemented in GitHub with per-user favourites; absent live at audit time. Tested persistence, filtering and Biz Ops access locally. |
| Remove Mine filters | Source toolbar tabs were already removed, but hidden `scope=mine`/`owner=mine` state remained behind dashboard links. Dashboard links now select the visible FO filter; the directory routes no longer apply the hidden restrictions. |
| Clearing automatic filters shows the wider data | Live explicit empty values already worked. Fixed inconsistent initial FO selections and CRM-owner matching. Browser checks clear both controls, reload and verify that the cleared state persists. |
| Meetings product, attendees, date range, favourites; no added-by-me/this-week filter | All exist in current source. Attendee matching uses the search field (also title/account); date boundaries use Central Time. These new filters were absent from the hosted interface at audit time. |
| Remove account website subtitles | Already removed from current source. Still present live at audit time. Website/domain remains available for search and in account details. |

## Validation

- Baseline: 305 tests passed before changes.
- Updated: **315 tests across 45 files passed**, using isolated PostgreSQL with all migrations applied.
- Production build and TypeScript/lint checks passed.
- **48 browser tests passed** in the final full run (2.3 minutes, no retries). The suite covers all six roles locally, real form submissions, tasks, sequences, campaigns, meetings, filters, exports and responsive layouts.
- Live walkthrough: 64 route visits across the four supplied seats plus existing meeting/contact-history/internal-company searches. Raw captures remain local and ignored; no credentials or customer transcripts are committed.

The historical `AUDIT.md` contains earlier point-in-time claims. This document supersedes them for these two lists. Remaining deployment and external-provider limitations must not be represented as verified production behaviour.
