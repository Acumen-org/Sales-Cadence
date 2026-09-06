# Connecting Cadence to your Twenty workspace

This guide is completed in phase 6 (real GraphQL client, `verify:schema`, dry run). The outline below is the plan of record so the pilot can be prepared in parallel.

## 1. Create an API key

Twenty > Settings > Developers > API keys > Create. Put it in `.env` as `TWENTY_API_KEY`, and set `TWENTY_API_URL` to your Twenty server's base URL (no trailing slash). Set `TWENTY_MODE=graphql`.

## 2. Register webhooks

Twenty > Settings > Developers > Webhooks. Target URL: `https://<cadence-host>/api/webhooks/twenty` (append `?token=<CADENCE_WEBHOOK_TOKEN>` if you set one). Subscribe to create, update and delete for:

- `message`, `messageParticipant` (native mailbox sync)
- `note` (activity notes in the `[Email] ...`, `[CALL] ...`, `Call Notes [...]` formats)
- `task`
- `opportunity`
- `person`

If your Twenty version supports a webhook secret, set the same value in `TWENTY_WEBHOOK_SECRET` so signatures are verified.

## 3. Optional: add `cadenceTaskId` to Task

Settings > Data model > Task > add a Text field named `cadenceTaskId`. When present (and `writeCadenceTaskIdField` is enabled in Settings > Twenty), Cadence stamps each mirrored Twenty Task with the Cadence task id so the two sides can always be matched.

## 4. Confirm field names

Open Settings > Twenty in Cadence and compare the mapping with your workspace. The defaults are in `src/lib/twenty/twenty-schema.ts`. The most likely differences are the person owner relation (`owner` / `ownerId`) and the meeting status field (`statusOfMeeting`).

## 5. Run `pnpm verify:schema`

Introspects the workspace and reports every missing or renamed field against the effective mapping, plus the `podOwner` select options so pods can be created to match.

## 6. Dry run

Set `CADENCE_DRY_RUN=true` and restart. Cadence reads from Twenty normally, processes webhooks, generates tasks, but logs every write it would make (notes, mirrored tasks) instead of making it. Review the log in Settings > Twenty.

## 7. Pilot with one pod

Create the pod, map its FOs to their Twenty workspace members, run a nightly-style reconcile by hand, enrol a handful of people, and watch that outbound emails and calls observed in Twenty complete the matching Cadence tasks. Then turn dry run off.
