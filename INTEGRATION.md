# Connecting Cadence to your Twenty workspace

Cadence reads people, notes, messages, tasks and opportunities from Twenty and writes back activity notes and mirrored tasks. Twenty stays the system of record. Follow these steps in order; each one is safe to redo.

## 1. Create an API key

In Twenty: **Settings > Developers > API keys > Create key**. Copy it once (Twenty does not show it again).

In Cadence `.env`:

```
TWENTY_MODE=graphql
TWENTY_API_URL=https://twenty.your-domain.tld     # base URL of your Twenty server, no trailing slash
TWENTY_API_KEY=eyJ...                             # the key you just created
```

Cadence calls `$TWENTY_API_URL/graphql` (data) and `$TWENTY_API_URL/metadata` (schema). If Twenty's frontend and API are on different hosts, use the API host here and set the frontend host in Settings > Twenty > Base URL so "Open in Twenty" links point to the UI.

You can also paste the key in **Cadence > Settings > Twenty** instead of the environment. Settings win over env. The key is stored in Cadence's Postgres in plain text, so prefer the environment on shared servers.

## 2. Register webhooks

In Twenty: **Settings > Developers > Webhooks > Create webhook**.

- **URL**: `https://<cadence-host>/api/webhooks/twenty`
  - If you set `CADENCE_WEBHOOK_TOKEN`, append `?token=<that value>`.
- **Secret**: if your Twenty version offers a webhook secret, generate one and put the same value in `TWENTY_WEBHOOK_SECRET`. Cadence then verifies the `X-Twenty-Webhook-Signature` header (HMAC-SHA256 over `timestamp:body`, plain body HMAC accepted as a fallback).
- **Events**: create, update and delete for
  - `message` and `messageParticipant` (native mailbox sync; outbound emails complete email steps, inbound emails mark replies)
  - `note` (activity notes: `[Email] Outbound email: ...`, `[CALL] Outbound Call by tw_...`, `Call Notes [31-Aug-2026]`)
  - `task` (mirrored Cadence tasks marked done in Twenty)
  - `opportunity` (meeting booked)
  - `person` (dnd flips, deletions, `assignedTo` and `podOwner` changes, cache updates)
  - `company` (account renames, owner changes, industry / size / city / LinkedIn, deletions - keeps the Accounts section current without waiting for the nightly refresh)

  If your Twenty only offers "all objects", that is fine: Cadence ignores objects it does not track.

With neither a secret nor a token configured the endpoint accepts any POST. Only do that on a private network.

Cadence stores every event once (object + id + updatedAt), so Twenty retries and duplicate deliveries are harmless. Settings > Activity log shows what arrived and what it did.

## 3. Optional: add `cadenceTaskId` to Task

**Settings > Data model > Tasks > Add field**: type Text, name `cadenceTaskId`. Then enable **Write the Cadence task id into Task.cadenceTaskId** in Cadence Settings > Sync out. Cadence stamps each mirrored Twenty task with its own task id so the two can always be matched, even if a mirrored task is edited in Twenty.

Without the field Cadence still matches mirrored tasks by the Twenty id it stored when creating them.

## 4. Confirm field names

The defaults in `src/lib/twenty/twenty-schema.ts` are **the real Acumen workspace**, verified
against a full export of Alisa's pod (934 people, 59 columns). Twenty derives a field's GraphQL
name from the label an admin typed, so "Next Action Due Date" is `nextActionDueDate`. Nothing
below is invented: if your workspace uses a different name, override it (see the end of this
section) rather than renaming the field in Twenty.

### Identity and contact, stock Twenty

| Twenty field | Type | Where it appears in Cadence |
|---|---|---|
| `name` | Full name | everywhere |
| `emails` | Emails | Reach them; reply matching |
| `phones` | Phones | Reach them; the calling code's zero-width joiner is stripped |
| `additionalNumber` | Phones (custom) | Contact details |
| `linkedinLink`, `xLink` | Links | Reach them |
| `jobTitle`, `city` | Text | person header, `{{jobTitle}}`, `{{city}}` |
| `company` / `companyId` | Relation to Company | Accounts, colleagues, `{{company}}` |
| `createdBy` | Actor | "Added by" on the record |

### Ownership

| Twenty field | Type | Where it appears in Cadence |
|---|---|---|
| `assignedTo` / `assignedToId` | Relation to Workspace member | **the owner of the relationship**: "My relationships", the Home tile, and `assignment: OWNER` when enrolling |
| `podOwner` | Select (`ALISA`, `ANDREW`, `LEIGH`, `KARSON`, `DANIEL`, `RIA` ...) | pods; a new value creates a pod on the spot |
| `rotationTracking` | Select (`ROTATED_OUT_LEIGH` ...) | a flag on the person: rotated out to another pod |
| `rotationChangedAt` | Date time | Ownership card |

Twenty has no standard owner on Person; this workspace calls it **Assigned To**. Nothing is
assigned without it, so if it is missing or renamed, "my relationships" and owner-based
assignment both come up empty.

### Consent and data quality

| Twenty field | Type | Where it appears in Cadence |
|---|---|---|
| `dnd` | **Select**, value `DO_NOT_DISTURB` | never enrol; auto-exit when it is set. It is a select in this workspace, not a boolean |
| `tags` | Multi-select, free-growing | its own row on the person panel |

Three tags carry a consequence and are read rather than duplicated as Cadence flags:
`DNC` (do not contact), `MISSING_EMAIL`, `MISSING_PHONE`. They are listed under
`personValues.doNotContactTags` / `missingEmailTags` / `missingPhoneTags`.

### Classification

| Twenty field | Type | Where it appears in Cadence |
|---|---|---|
| `leadSource` | Multi-select (`FPA_WISCONSIN_JULY_2026`, `LEADGEN`, `NIL` ...) | "Lead source"; `{{leadSource}}`, humanised |
| `leadSourceNotes` | Text | beside the lead source |
| `tier` | Select `LEVEL_1`..`LEVEL_4` | tier badge and the People filter; `LEVEL_1` is best |
| `contactType` | Multi-select (`PROSPECT`, `CLIENTS`, `CLIENT_S_CLIENT`, `PARTNER`, `ORGANIZATION`) | "In Twenty" column, People filter |
| `listCategory` | Select (`COLD_BD`, `BI_WEEKLY`, `MONTHLY`, `QUARTERLY`, `UNASSIGNED`) | how often the person should be touched; People filter |
| `previousCadence` | Select | shown as "(was Monthly)" beside the cadence |
| `pipelineStageField` | Select (`PROSPECT`, `QUALIFY`, `RETAIN`) | the standing badge, ahead of contact type |
| `productInterest` | Multi-select (`PHH`, `TOLLBOOTH`, `ACUBOOTH`, `GLYNAC`) | person panel; `{{product}}` |
| `primaryProduct` | Text | `{{product}}` when set |
| `onGoingCampaigns` | Multi-select (`AY_PHH_POST_WEBINAR`, `SPONSORSHIP`, `AUBURN_HILL_ACQUISITION`, `CE_PRESENTATION`) | "Campaigns in Twenty" - distinct from Cadence campaigns |
| `alisaCallingList` | Boolean | "on the pod owner's calling list" |
| `dealSignalStrength` | Select or text | Classification card |

### What happens next, as the CRM records it

| Twenty field | Type | Where it appears in Cadence |
|---|---|---|
| `nextAction` | Text ("FU-2", "Follow up 2") | **"What Twenty says next"**, top of the person panel |
| `nextActionDueDate` | Date | beside it, red once past |
| `nextStep` | Select (`EMAIL`, `LINKEDIN_MESSAGE`) | beside it |
| `nextActionDueDatePoc` | Date | beside it |
| `lastNote` | Text | quoted under the next action |

Cadence **reads** these and never writes them. They are shown above Cadence's own step so an FO
who is about to contradict the CRM's plan can see it first.

### Last touch and recordings

| Twenty field | Type | Where it appears in Cadence |
|---|---|---|
| `latestCallActivity` | Date time | the person's history, when no Cadence touch covers that moment |
| `lastEmailActivity` | Date time | same |
| `salesCallRecordingLink` | Links | "Recordings in Twenty" on the Meetings page; "Add with transcript" pre-fills the form with it |
| `meetingLink` | Links | join link on the person |
| `bookingId` | Text | shown beside them |

Twenty's `meetingTime` field is deliberately **not** read. The team does not use it, so nothing
in Cadence depends on it and a meeting is recorded the way every other meeting is: an FO adds it,
or an opportunity appears.

### Overrides

Open **Cadence > Settings > Twenty**. The default mapping is shown; enter only the names that
differ as JSON, for example:

```json
{ "person": { "assignedToId": "relationshipOwnerId", "callingList": "podCallingList" } }
```

Select **values** live under `personValues`, and an override replaces that list outright:

```json
{ "personValues": { "tier": ["A", "B", "C"], "dnd": ["DO_NOT_CONTACT"] } }
```

Twenty stores the option *value* (usually upper snake case such as `ALISA`), not the label.
Pods must use the stored value; `verify:schema` prints the options so you can copy them.
Cadence renders values as readable labels (`LEVEL_2` reads "Tier 2") and never shows a raw
constant on screen.

## 5. Run `pnpm verify:schema`

From the repo (or `docker compose exec web pnpm verify:schema`):

```
Twenty mode: graphql (https://twenty.example.com)
Introspecting...
Source: metadata, 31 objects

✓ person (people): 43/43 fields ok
  podOwner options in Twenty: ALISA, LEIGH, ANDREW, KARSON, DANIEL, RIA
  i options without a Cadence pod yet: KARSON, DANIEL, RIA (create them in Settings > Users and pods)
  dnd: DO_NOT_DISTURB
  tier: LEVEL_1, LEVEL_2, LEVEL_3, LEVEL_4
  listCategory: COLD_BD, BI_WEEKLY, MONTHLY, QUARTERLY, UNASSIGNED
  contactType: PROSPECT, CLIENTS, CLIENT_S_CLIENT, PARTNER, ORGANIZATION
✓ company (companies): 3/3 fields ok
! task (tasks): 9/10 fields ok
  ! task.cadenceTaskId -> "cadenceTaskId" missing [optional]
...
Smoke test: reading one person...
✓ Nina Halvorsen (nina@acme.example) dnd=false podOwner=ALISA

0 required problem(s), 1 optional field(s) missing.
```

Exit code 1 means a required object or field is missing or renamed; fix the mapping (step 4) and
run again. Every custom Person field is optional and only warns; Cadence treats a missing one as
empty and trims it out of its GraphQL queries, so a partial workspace still runs. `verify:schema`
also prints each select's option values against the ones the mapping expects, which is how a
renamed option is caught before an FO sees an empty filter.

## 6. Create pods and map users

**Settings > Users and pods**: add one pod per `podOwner` value you use, then create or edit users:

- Role: Admin, Senior FO (own pods) or Junior FO (own tasks).
- Twenty workspace member: pick the member this user is. Outbound emails and calls by that member complete this user's tasks.
- Aliases: handles that appear in note titles produced by other tools, e.g. `tw_alisa`.

Then **Settings > Twenty > Full refresh** to pull people and companies into the cache.

## 7. Dry run

Set `CADENCE_DRY_RUN=true` and restart (`docker compose up -d`). Cadence reads from Twenty and processes webhooks normally, but every write (completion notes, mirrored tasks) is only logged: console, and **Settings > Activity log > Writes to Twenty** with a "dry run" badge.

Use this phase to:

1. Create a small campaign for one pod (Campaigns > New campaign).
2. Send a real email and log a real call in Twenty for one enrolled person.
3. Confirm the Cadence tasks flip to done with source "observed" and the brief shows the touches.
4. Run **Settings > Twenty > Run reconcile now** and confirm it reports mostly duplicates.

Rescanning is always safe: `pnpm reconcile 7` replays the last 7 days through the same pipeline.

## 8. Pilot with one pod

Turn dry run off (`CADENCE_DRY_RUN=false`), remove `demo` from `SEED_PROFILE`, restart, and enrol one pod's people. Watch for a week:

- **Tasks page** every morning: caps hold (default 40/day), overdue is visible and shrinking.
- **Settings > Activity log**: events needing review (unknown actors, failed events). Add aliases or fix mappings, then mark reviewed.
- **Reports > By channel**: the observed vs manual split tells you whether Twenty is seeing the team's emails and calls. A low observed share usually means a mailbox is not connected in Twenty or note titles do not match the patterns in Settings > Rules and matching.
- **Twenty timelines**: each completed action appears as `[Cadence] Email 2 sent by Alisa`; open tasks appear as `Cadence: Email 1 - <name>` assigned to the FO.

When the pilot pod is happy, add the other pods.

## What Cadence writes to Twenty (and what it never touches)

Writes, and only these:

| When | What Cadence creates or edits in Twenty |
|---|---|
| An FO completes an action (or Twenty activity completes it) | One **Note** on the person: `[Cadence] Email 2 sent by Alisa`, `[Cadence] Call 1 made by Alisa - Left voicemail`. Body: sequence, step, outcome, the FO's notes, source. |
| A Cadence task is generated (setting *Mirror open tasks*, on by default) | One **Task**: `Cadence: Email 1 - Dummy One`, assigned to the FO, due on the task day, linked to the person. |
| That Cadence task is done / skipped / cancelled | The mirrored Task is marked done, or deleted (setting *Delete mirrored task on skip*). |

Never: person, company or opportunity fields - not `dnd`, `podOwner`, `assignedTo`, `tier`,
`listCategory`, `nextAction`, `nextActionDueDate`, `tags`, emails or stages - nor notes or tasks
Cadence did not create, nor messages. In particular the CRM's own next action is read and
displayed, never rewritten: the pod plans in Twenty and Cadence shows that plan beside its own. Opt-out and bad-data flags set in Cadence stay in Cadence; set `dnd` in Twenty yourself if it should apply everywhere. Every write appears in **Settings > Activity log > Writes to Twenty**; `CADENCE_DRY_RUN=true` logs them without writing.

The relationship layer is Cadence's own and is never written back, because Twenty has no field for it: who reports to whom, each contact's stance on the account, the relationship note, and everything about meetings (the recording link, the transcript and any analysis). Meetings link to a Twenty company so they show on that account's timeline; they are not created in Twenty.

Sync is immediate in both directions: webhooks are processed as Twenty sends them (people, companies, notes, messages, tasks and opportunities), every Cadence write happens right after the action that caused it, and opening a person in Cadence re-reads that person from Twenty. An account page has a **Sync from Twenty** button that pulls the company and its people on demand. The nightly reconcile only catches anything a webhook missed.

Tested against **Twenty 1.23** and **Postgres 18**.

## Pods follow Twenty

A pod is a `podOwner` value. Cadence keeps its pod list aligned with Twenty automatically:

- a person arriving with a value Cadence has never seen creates the pod at once, marked "discovered from Twenty" in Settings > Users and pods;
- **Sync pods from Twenty** (also run on every cache refresh and nightly) reads the select's options and creates or renames pods: the option *label* becomes the pod name, the *value* stays the key. Rename a label in Twenty and the pod renames here;
- Cadence never deletes a pod by itself; retire an emptied pod in Settings.

Which FOs work a pod, and who can log in, is Cadence configuration (Settings > Users and pods, Admin only).

## Reference

| Setting | Where | Default |
|---|---|---|
| Daily cap | Settings > Rules | 40 actions per FO per day |
| Working days | Settings > Rules | Mon to Fri, FO timezone |
| Clock mode | Settings > Rules | shift (late steps push later steps) |
| Note title regexes | Settings > Rules and matching | `^\[Email\]\s*Outbound email`, `^\[CALL\]\s*Outbound Call`, `^Call Notes\s*\[...\]` |
| Reply from colleague pauses company | Settings > Rules | off |
| Meeting detection | Settings > Rules | an opportunity created for the person |
| Our own email domains | Settings > Rules | `acumen-strategy.com`, `prairie-hill.com`, `glynac.ai`, `acubooth.com` (a meeting counts as booked only when someone outside these attends) |
| Completion notes / mirrored tasks | Settings > Sync out | on / on |
| Reconcile lookback | Settings > Rules | 3 days, nightly at `RECONCILE_HOUR` |
