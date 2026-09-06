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
  - `person` (dnd flips, deletions, `statusOfMeeting`, cache updates)

  If your Twenty only offers "all objects", that is fine: Cadence ignores objects it does not track.

With neither a secret nor a token configured the endpoint accepts any POST. Only do that on a private network.

Cadence stores every event once (object + id + updatedAt), so Twenty retries and duplicate deliveries are harmless. Settings > Activity log shows what arrived and what it did.

## 3. Optional: add `cadenceTaskId` to Task

**Settings > Data model > Tasks > Add field**: type Text, name `cadenceTaskId`. Then enable **Write the Cadence task id into Task.cadenceTaskId** in Cadence Settings > Sync out. Cadence stamps each mirrored Twenty task with its own task id so the two can always be matched, even if a mirrored task is edited in Twenty.

Without the field Cadence still matches mirrored tasks by the Twenty id it stored when creating them.

## 4. Confirm field names

The defaults in `src/lib/twenty/twenty-schema.ts` assume a stock workspace plus these custom Person fields:

| Cadence expects | Type | Used for |
|---|---|---|
| `dnd` | Boolean | never enrol; auto-exit when it flips to true |
| `podOwner` | Select (Alisa, Leigh, Andrew, Karson, Daniel, Ria ...) | pods |
| `owner` / `ownerId` | Relation to Workspace member | "assign by owner" |
| `tags` | Multi-select | shown in the brief |
| `eventSource` | Text or Select | "where we met", `{{eventSource}}` |
| `statusOfMeeting` | Select (optional) | meeting detection |

Open **Cadence > Settings > Twenty**. The default mapping is shown; enter only the names that differ as JSON overrides, for example:

```json
{ "person": { "owner": "accountOwner", "ownerId": "accountOwnerId", "statusOfMeeting": "meetingStatus" } }
```

Select values: Twenty stores the option *value* (often upper snake case such as `ALISA`), not the label. Pods must use the stored value; `verify:schema` prints the options so you can copy them.

## 5. Run `pnpm verify:schema`

From the repo (or `docker compose exec web pnpm verify:schema`):

```
Twenty mode: graphql (https://twenty.example.com)
Introspecting...
Source: metadata, 31 objects

✓ person (people): 19/19 fields ok
  podOwner options in Twenty: ALISA, LEIGH, ANDREW, KARSON, DANIEL, RIA
  i options without a Cadence pod yet: KARSON, DANIEL, RIA (create them in Settings > Users and pods)
✓ company (companies): 3/3 fields ok
! task (tasks): 9/10 fields ok
  ! task.cadenceTaskId -> "cadenceTaskId" missing [optional]
...
Smoke test: reading one person...
✓ Nina Halvorsen (nina@acme.example) dnd=false podOwner=ALISA

0 required problem(s), 1 optional field(s) missing.
```

Exit code 1 means a required object or field is missing or renamed; fix the mapping (step 4) and run again. Optional fields (`statusOfMeeting`, `cadenceTaskId`, `tags`, `eventSource`, `owner`) only warn; Cadence treats them as empty.

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

Never: person, company or opportunity fields (`dnd`, `podOwner`, emails, stages...), notes or tasks Cadence did not create, messages. Opt-out and bad-data flags set in Cadence stay in Cadence; set `dnd` in Twenty yourself if it should apply everywhere. Every write appears in **Settings > Activity log > Writes to Twenty**; `CADENCE_DRY_RUN=true` logs them without writing.

Sync is immediate in both directions: webhooks are processed as Twenty sends them, every Cadence write happens right after the action that caused it, and opening a person in Cadence re-reads that person from Twenty. The nightly reconcile only catches anything a webhook missed.

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
| Meeting detection | Settings > Rules | opportunity created, or `statusOfMeeting` in booked values |
| Completion notes / mirrored tasks | Settings > Sync out | on / on |
| Reconcile lookback | Settings > Rules | 3 days, nightly at `RECONCILE_HOUR` |
