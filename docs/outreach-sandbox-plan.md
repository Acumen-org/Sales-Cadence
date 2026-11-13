# Outreach sandbox, Bellwether push and Twilio calls: Cadence plan

Plan of 2 November 2026, updated 3 November 2026 with Rahul's answers (section 19, "Decisions
(2026-11-03)"); where the two disagree, the decisions win. Source: Rahul's brief of 2 November
2026 (`Tech Projects/cadence-outreach-sandbox-brief.md`) and his decisions
(`Tech Projects/rahul-decisions-2026-11-03.md`). Bellwether's plan
(`Scrapper/docs/outreach-sandbox-plan.md`) copies the section "Shared contract with Bellwether"
from this file. Cadence owns that contract. Rahul said go on 3 November 2026; everything below is
built in one pass (section 16) on the local branch `outreach-sandbox`, not in phases.

---

## 1. What gets built

- **One new section, Sandbox** (`/sandbox`). It holds contacts that are not in Twenty: Contacts,
  Work (today's sandbox tasks and next actions) and Campaigns. A contact page has its calls,
  emails, notes, campaign and next action.
- **Sandbox campaigns run on the existing campaign engine and studio.** An enrollment, a next
  action or a touch can point at a sandbox contact instead of a Twenty person. Reps can also work
  contacts one at a time with next actions.
- **Ownership.** Every sandbox contact has an owner (a Cadence user) and a pod, or is unclaimed.
  Reps claim and reassign contacts.
- **Move to CRM**, for one contact or many. Cadence checks each contact is CRM-ready, finds or
  creates the firm in Twenty, and creates the person with Assigned To, Pod Owner, lead source and
  the rest filled in. History goes across as Twenty notes. The person then shows in People like
  any other CRM contact. Up to 50 contacts per move. Moves are queued, audited and can be undone
  for one year.
- **Bellwether push API.** Bellwether pushes contacts (never firms) into the sandbox. Cadence
  dedupes them against the sandbox and the CRM and reports per contact. A check endpoint answers
  the same per-contact results without writing anything, so Bellwether's push preview can block
  contacts already in the CRM. A status endpoint lets Bellwether show "In Cadence", "Moved to
  CRM" or "Opted out" for each one.
- **Twilio call data, read only.** Calls keep going through the existing hosted dialpad
  (`https://h00ks.acm.acumen-strategy.com/admin/dialpad`); Call buttons open the configured
  dialpad URL with the number, as today. Cadence creates no Twilio app, number or webhook and
  records nothing itself. A worker job reads every call and its recordings from Twilio's REST API
  every 2 minutes and stores a `CallLog` for each, whether the contact is in the sandbox or the
  CRM: direction, numbers, timings, status, price, recording, caller, contact, task and campaign.
  Recordings play in Cadence through a signed-in proxy that streams from Twilio.
- **A post-call form after every call.** A call counts as complete only once its form is in. The
  form's next step, which always carries its date, creates the next action. For CRM contacts the
  form goes to Twenty as a note at once; for sandbox contacts it goes when the contact is moved.
- **Reports > Calls**: dials, connects, connect rate, talk time, outcomes, meetings booked, form
  backlog and best hours, split by rep, pod and campaign. Reports show sandbox numbers as their
  own section and combined with the rest of the platform.
- **Sandbox email steps close by themselves.** Cadence reads sent-mail and inbox metadata from the
  sales mailboxes through Microsoft Graph (application `Mail.Read`, limited by Exchange Online to
  the sales mailboxes) and matches recipients to sandbox contacts. Off unless its env vars are
  set. Cadence still never sends email.
- **Compliance**: one suppression list checked on push, in campaigns and before every call;
  opt-out from the call form, the contact page or the suppression list, each sent back to
  Bellwether as `opted_out`; calling hours checked on Cadence's own Call button; retention and
  erasure for contacts who never convert.

## 2. Today's rules this touches

| Rule today | Where | What happens |
|---|---|---|
| Twenty is the system of record. Cadence keeps no contact data of its own, and `PersonCache` is a read cache. The owner said on 2 Nov: "Cadence is not a record keeper". | README.md, DECISIONS.md | The sandbox is the one deliberate exception Rahul asked for: contacts that are not in Twenty yet. When a contact moves, it leaves Cadence. After the undo window the row keeps ids only, no personal data (section 8.8). Calls on CRM contacts still go to Twenty as notes, so reports built on the CRM keep seeing them. |
| "Cadence never sends email or automates LinkedIn." | README.md line 5 | Unchanged. Graph is used read-only (metadata of sent and received mail) and only for the sales mailboxes. No `Mail.Send`. |
| Calls open the dialpad (a `clickToCallUrl` template), or `startCallAction` POSTs to an endpoint. | `src/lib/calls.ts`, `src/lib/actions/calls.ts`, DECISIONS.md 18 Sep | Unchanged. The Call button still opens the configured dialpad URL with the number. Pressing it also records a call intent (who, which number, which task), so the imported call is linked to the task. Calls are read back from Twilio's REST API and every one gets a form. |
| Cadence writes only `[Cadence]` notes, mirrored tasks and reviewed enrichment, and never sets `assignedTo`, `podOwner`, `tier` and so on. | INTEGRATION.md "What Cadence writes to Twenty" | Move to CRM creates a Person, and a Company when needed, and sets those fields **on the records it creates, once, when it creates them**. Cadence still never edits a person it did not create. Undo deletes only what Cadence created. INTEGRATION.md gets new rows. |
| One active enrollment per person (partial unique index). | `prisma/migrations`, DECISIONS.md "Data and dates" | A twin index for sandbox contacts. |
| The owner wants to discuss changes to the campaign core before they are built. | memory, PLAN.md | Section 7 was that proposal; Rahul approved it on 3 Nov (decision 1). |
| Everyone can read every section; writes are limited to the user's pods. | DECISIONS.md 12 Sep | The sandbox follows the same rule (section 6). |

## 3. What changes in Cadence, by file

New code:

| Path | What it does |
|---|---|
| `src/lib/sandbox/normalize.ts` | Email, phone (E.164), LinkedIn, CRD and domain normalisation. One implementation shared by the push API, manual add, dedupe, call matching and Graph matching. |
| `src/lib/sandbox/contacts.ts` | Create, edit, claim, assign, remove and erase. Every write is audited (`logAudit`, entity `sandbox_contact`). |
| `src/lib/sandbox/dedupe.ts` | The match order in the contract (section 14.6), against the sandbox and `PersonCache`. |
| `src/lib/sandbox/ready.ts` | CRM-ready rules. Returns the list of what is missing, in plain words. |
| `src/lib/sandbox/move.ts` | Move preflight, the queued execution, attach-to-existing and undo. |
| `src/lib/sandbox/history-notes.ts` | Builds the Twenty notes for a moved contact. |
| `src/lib/sandbox/suppression.ts`, `retention.ts` | The suppression list, the retention purge and erasure. |
| `src/lib/sandbox/bellwether-api.ts` | zod schemas for the contract, request processing and responses. |
| `src/lib/sandbox/opt-out.ts` | The one opt-out path every source uses (call form, contact page, suppression list): status OPTED_OUT, `optedOutAt` (Bellwether's `statusChangedAt`), suppression hashes, sequences ended. |
| `src/app/api/integrations/bellwether/v1/{ping,contacts,contacts/check,contacts/status}/route.ts` | The four endpoints. |
| `src/lib/calls/twilio.ts` | A read-only Twilio REST client through `fetch` (Calls, Recordings, IncomingPhoneNumbers, recording media), basic auth with an API key. No `twilio` package, no access tokens, no webhooks. |
| `src/lib/calls/fake-twilio.ts` | An in-memory stand-in with the same interface, used by tests and whenever Twilio is not configured outside production. |
| `src/lib/calls/call-log.ts` | Upserting a call from Twilio (status only moves forward), linking it to a task, next action and campaign, and the touch. |
| `src/lib/calls/match.ts` | Matching the rep (caller number, then `tw_` alias) and the other party (sandbox contact or CRM person). |
| `src/lib/calls/import.ts` | The worker job `twilioImport`: Calls.json from the watermark minus 10 minutes, then each call's Recordings. |
| `src/lib/calls/form.ts` | Post-call form validation and what it causes: next action, opt-out, task close, notes. |
| `src/lib/calls/hours.ts` | The 8:00-21:00 local calling-hours check for Cadence's own Call button. |
| `src/lib/calls/analytics.ts` | Queries for Reports > Calls. |
| `src/lib/mail/graph-mail.ts` | Graph delta on Sent Items and Inbox, recipient matching, step closing, replies and bounces. Off unless `GRAPH_MAIL_ENABLED=true`. |
| `src/app/api/calls/[id]/recording/route.ts` | Streams a recording from Twilio to a signed-in user (needs a session). Nothing is stored; the Twilio credentials never reach the browser. |
| `src/app/(app)/sandbox/page.tsx`, `sandbox/[id]/page.tsx`, `sandbox/moves/[id]/page.tsx` | The section, the contact page and a move batch. |
| `src/components/sandbox/*` | Contacts table, toolbar, contact form, move dialog, assign and claim. |
| `src/components/calls/{post-call-form,pending-forms,call-row,recording-player}.tsx` | Calling UI. |
| `src/lib/actions/sandbox.ts`, `sandbox-move.ts`, `call-forms.ts` | Server actions. |
| `src/lib/sandbox/status.ts`, `bellwether-http.ts` | The status endpoint's answers and `changedSince` paging; the HTTP layer of the four endpoints. |
| `src/lib/sandbox/campaigns.ts`, `work.ts`, `query.ts` | Sandbox campaigns on the engine, Sandbox > Work and the Contacts list. |
| `src/lib/subject.ts` | Which rows a CRM view reads (a person) and which the Sandbox reads. |
| `src/lib/calls/gate.ts` | Whether Cadence's Call button may open the dialpad now: a form waiting, an opt-out, calling hours. |
| `src/app/api/test/fake-twilio/route.ts` | Seeds the Twilio stand-in for the browser test; answers 404 unless `CADENCE_FAKE_TWILIO=1` and mock mode. |

Changed code:

| Path | Change |
|---|---|
| `prisma/schema.prisma` + migration | Section 4. |
| `src/lib/env.ts`, `.env.example`, `nomad/cadence.hcl` (both the web and the worker template) | New variables (section 15). |
| `src/lib/settings.ts` | New sections `sandbox`, `calling` and `mail`. `rules.callDispositions` gets the flags `meetingBooked` and `doNotContact`, and gains "Not interested", "Meeting booked" and "Asked not to be contacted". |
| `src/middleware.ts` | `PUBLIC_PREFIXES` gains `/api/integrations`, which is authenticated by key. |
| `src/lib/auth/rbac.ts` | `canWorkSandboxContact`, `canClaimSandbox`, `canAssignSandbox`, `canMoveToCrm`, `canUndoMove`, `canEraseContact`, `canViewCalls`, each with a `whyNot*` twin in the existing style. |
| `src/components/sidebar.tsx` | "Sandbox" under Engagement, below Campaigns, with the signed-in user's due count. |
| `src/lib/twenty/client.ts`, `types.ts`, `graphql-client.ts`, `mock-client.ts`, the dry-run wrapper | `findPeople`, `findCompanies`, `createPerson`, `createCompany`, `deletePerson` and `deleteCompany`. Each write is a `TwentyWrite` row, so it is logged, retried and respects `CADENCE_DRY_RUN`. |
| `src/lib/twenty/twenty-schema.ts`, `scripts/verify-schema.ts` | Two optional fields, `person.cadenceSandboxId` (text) and `company.crd` (text). Neither is required. |
| `src/lib/person-cache.ts` | `personToCacheData` fills a new `phoneE164`. |
| `src/lib/engine/enrollment.ts`, `tasks.ts`, `campaigns.ts`, `outcomes.ts`, `sync-out.ts`, `observed-evidence.ts`, `delegate.ts` | Work with a subject that is either a person or a sandbox contact (section 7). `sync-out.ts` writes nothing to Twenty for a sandbox subject. `completeCall` takes a call form. |
| `src/lib/campaign-membership.ts`, `campaigns-query.ts`, `src/lib/actions/search.ts`, `src/lib/engine/campaigns.ts` | CRM campaign lists, audiences and Ctrl+K read `audience = CRM`; launching a campaign with `audience = SANDBOX` goes to `src/lib/sandbox/campaigns.ts`. The studio is unchanged. |
| `src/lib/next-actions.ts` | Sandbox next actions never reach Twenty until the contact moves (`syncNextActions` skips rows without a `personId`). |
| `src/lib/tasks-query.ts`, `home-query.ts` | CRM only, always. There is no Sandbox or All filter in Tasks, Today (Home) or any CRM view (decision 2); sandbox work is worked in Sandbox > Work. |
| `src/lib/reports-query.ts`, `reports-bundle.ts` | The existing numbers stay CRM. Reports gains a Sandbox section with the sandbox numbers on their own, and a Platform total that combines CRM and sandbox (decision 2). |
| `src/components/tasks/task-actions.tsx` | The "Log call" panel becomes the post-call form. Call still opens the dialpad URL. |
| `src/components/tasks/task-brief.tsx` | The person panel also accepts a sandbox contact. |
| `src/lib/actions/calls.ts` | A new `recordCallIntentAction` stores who pressed Call, for which number and which task or contact, so the imported call links to it. The endpoint and dialpad behaviour stay as they are. |
| `src/lib/actions/search.ts` | Unchanged: Ctrl+K stays CRM only. The Sandbox section has its own search. |
| `src/worker/index.ts` | Jobs: `sandboxMoves` (every tick), `twilioImport` (2 min), `graphMail` (2 min, only when enabled), `sandboxRetention` (nightly, also clears moved contacts' personal data after the one-year undo window), `pushRetention` (nightly, drops idempotency records older than 7 days), `phoneE164Backfill` (once, guarded by a Setting key, as `sharePointPlayers20261029` was). |
| `src/app/(app)/reports/page.tsx` | The Calls view, the Sandbox section and the Platform totals. |
| `src/app/(app)/settings/page.tsx` | New tabs Calling and Sandbox. Sign-in gets a row for the mail permission. |
| `package.json` | No new packages. Phone numbers are normalised by a small built-in parser (North American numbers, and any number written with a leading `+` and a country code), which is all Bellwether sends today. `libphonenumber-js` can replace it later without a contract change. |
| README.md, INTEGRATION.md, DECISIONS.md, DEPLOY.md | Documented as part of the build. |

## 4. Data model and migration

### 4.1 New models

```prisma
enum SandboxStatus {
  ACTIVE     // workable in the sandbox
  MOVED      // in Twenty now; the row is a tombstone
  OPTED_OUT  // asked not to be contacted
  REMOVED    // deleted by a user or by retention; personal data cleared
}

enum ContactSource { BELLWETHER MANUAL CSV CALL }

/// A contact that is not in Twenty. Holds the firm flat on the row: the sandbox works people, and
/// the firm only matters again when the contact moves to Twenty (section 8.4).
model SandboxContact {
  id                  String        @id @default(uuid())
  status              SandboxStatus @default(ACTIVE)
  source              ContactSource
  firstName           String
  lastName            String
  sortName            String?
  jobTitle            String?
  email               String?       /// lower-cased
  emailVerification   String?       /// valid | risky | unknown
  additionalEmails    String[]      @default([])
  phone               String?       /// E.164
  phoneType           String?       /// direct | mobile | office | main | toll_free | unknown
  phoneExtension      String?
  additionalPhones    Json          @default("[]")  /// [{ number: E.164, type }]
  linkedinUrl         String?       /// linkedin.com/in/<slug>
  city                String?
  state               String?
  country             String?       /// ISO 3166-1 alpha-2
  individualCrd       String?
  designations        String[]      @default([])
  productInterest     String[]      @default([])  /// Twenty productInterest values
  tags                String[]      @default([])
  companyName         String?
  companyDomain       String?
  companyWebsite      String?
  companyCrd          String?
  companyCity         String?
  companyState        String?
  companyCountry      String?
  companyPhone        String?
  companyAumUsd       Decimal?      @db.Decimal(24, 2)
  companyEmployees    Int?
  ownerId             String?
  owner               User?         @relation("SandboxOwner", fields: [ownerId], references: [id], onDelete: SetNull)
  podId               String?
  pod                 Pod?          @relation(fields: [podId], references: [id], onDelete: SetNull)
  claimedAt           DateTime?
  bellwetherContactId String?       @unique
  bellwetherUrl       String?
  sourceNote          String?
  collectedAt         String?       /// LocalDate the source collected it
  pushedByEmail       String?
  createdById         String?
  badEmail            Boolean       @default(false)
  badPhone            Boolean       @default(false)
  optedOutAt          DateTime?
  optOutReason        String?
  /// When the status Bellwether reads (14.12) last changed: every opt-out, move, undo and removal
  /// sets it in the same write that changes the status.
  statusChangedAt     DateTime      @default(now())
  lawfulBasis         String?       /// legitimate_interest | consent; set for EEA/UK contacts
  lastActivityAt      DateTime?     /// last call, email, note or task: drives retention
  movedAt             DateTime?
  movedById           String?
  twentyPersonId      String?       @unique
  twentyCompanyId     String?
  piiClearedAt        DateTime?
  createdAt           DateTime      @default(now())
  updatedAt           DateTime      @updatedAt

  enrollments Enrollment[]
  nextActions NextAction[]
  touches     Touch[]
  calls       CallLog[]
  notes       SandboxNote[]
  emails      SandboxEmail[]

  @@index([status, ownerId])
  @@index([status, podId])
  @@index([status, lastActivityAt])
  @@index([statusChangedAt])
  @@index([email])
  @@index([phone])
  @@index([linkedinUrl])
  @@index([individualCrd])
  @@index([companyDomain])
  @@index([sortName])
}

model SandboxNote {
  id               String         @id @default(uuid())
  sandboxContactId String
  contact          SandboxContact @relation(fields: [sandboxContactId], references: [id], onDelete: Cascade)
  authorId         String?
  body             String
  twentyNoteId     String?        /// set when the contact moves
  createdAt        DateTime       @default(now())

  @@index([sandboxContactId, createdAt])
}

/// Never contact again. Values are SHA-256 of the normalised value, so an erased contact leaves no
/// readable personal data behind and a later push of the same person is still refused.
model Suppression {
  id               String   @id @default(uuid())
  kind             String   /// email | phone | linkedin | bellwether_id
  valueHash        String
  reason           String   /// opted_out | erased | do_not_contact
  sandboxContactId String?
  createdById      String?
  createdAt        DateTime @default(now())

  @@unique([kind, valueHash])
}

enum CallDirection { OUTBOUND INBOUND }
enum CallStatus { QUEUED INITIATED RINGING IN_PROGRESS COMPLETED BUSY NO_ANSWER FAILED CANCELED }
enum CallSource { TWILIO_IMPORT MANUAL }

/// Every call, sandbox or CRM: read from Twilio's REST API (calls placed through the hosted
/// dialpad or any other app on the account), or logged by hand. Cadence places no calls itself.
/// One row per conversation: the Twilio leg that reaches the phone network.
model CallLog {
  id               String          @id @default(uuid())
  source           CallSource
  direction        CallDirection
  twilioCallSid    String?         @unique   /// the leg to or from the phone network
  parentCallSid    String?                   /// the dialpad's browser leg, when there is one
  fromNumber       String?                   /// E.164
  toNumber         String?
  repIdentity      String?                   /// client:<identity> seen on the call or its parent, e.g. tw_alyssa
  status           CallStatus      @default(QUEUED)
  statusRank       Int             @default(0)  /// imports overlap; status never moves back
  twilioStatus     String?                   /// Twilio's own word, kept as read
  startedAt        DateTime?
  endedAt          DateTime?
  talkSec          Int?                      /// Twilio's duration; 0 when nobody answered
  priceUsd         Decimal?        @db.Decimal(10, 4)
  userId           String?
  user             User?           @relation("CallUser", fields: [userId], references: [id], onDelete: SetNull)
  repMatchedBy     String?                   /// caller_number | alias | intent | chosen | none
  personId         String?
  person           PersonCache?    @relation(fields: [personId], references: [id], onDelete: SetNull)
  sandboxContactId String?
  sandboxContact   SandboxContact? @relation(fields: [sandboxContactId], references: [id], onDelete: SetNull)
  matchedBy        String?                   /// dialed | number | chosen | ambiguous | none
  candidates       Json?                     /// ambiguous: the possible contacts
  taskId           String?
  nextActionId     String?
  enrollmentId     String?
  campaignId       String?
  touchId          String?         @unique
  recordingSid     String?                   /// Twilio's recording; played through the proxy, never copied
  recordingSec     Int?
  recordingCount   Int             @default(0)
  formDueAt        DateTime?                 /// set when a matched rep's call has ended
  formDoneAt       DateTime?
  importedAt       DateTime?
  createdAt        DateTime        @default(now())
  updatedAt        DateTime        @updatedAt

  form CallForm?

  @@index([userId, startedAt])
  @@index([userId, formDoneAt])
  @@index([personId, startedAt])
  @@index([sandboxContactId, startedAt])
  @@index([campaignId, startedAt])
  @@index([startedAt])
  @@index([toNumber])
  @@index([fromNumber])
  @@index([parentCallSid])
}

/// A press of Cadence's Call button: who, which number, for which task or contact. The dialpad
/// knows none of this, so the import links the Twilio call to the newest intent by the same rep
/// to the same number within 30 minutes before the call started.
model CallIntent {
  id               String   @id @default(uuid())
  userId           String
  toNumber         String   /// E.164
  personId         String?
  sandboxContactId String?
  taskId           String?
  nextActionId     String?
  callId           String?  @unique  /// set once a call has claimed it
  createdAt        DateTime @default(now())

  @@index([userId, toNumber, createdAt])
}

model CallForm {
  id                String   @id @default(uuid())
  callId            String   @unique
  call              CallLog  @relation(fields: [callId], references: [id], onDelete: Cascade)
  userId            String
  outcome           String   /// key in settings.rules.callDispositions
  rating            Int?     /// 1-5, required when the outcome is answered
  notes             String?  /// required when the outcome is answered
  /// The next step together with its date: one field in the form (decision 6), two columns here.
  nextStep          String   /// call_again | email | linkedin | meeting | none
  nextStepDate      String?  /// LocalDate; required for every next step except none
  interest          String?  /// hot | warm | cold
  productsDiscussed String[] @default([])
  decisionMaker     String?  /// yes | no | unknown
  nextActionId      String?
  twentyNoteId      String?  /// CRM contact: at once. Sandbox contact: when moved.
  submittedAt       DateTime @default(now())
  updatedAt         DateTime @updatedAt
}

enum SandboxEmailKind { SENT REPLY AUTO_REPLY BOUNCE }

/// Mail seen in a sales mailbox to or from a sandbox contact. Nothing else is stored.
model SandboxEmail {
  id                String           @id @default(uuid())
  sandboxContactId  String
  contact           SandboxContact   @relation(fields: [sandboxContactId], references: [id], onDelete: Cascade)
  userId            String?          /// whose mailbox
  kind              SandboxEmailKind
  internetMessageId String
  conversationId    String?
  subject           String?
  at                DateTime
  taskId            String?          /// the step it closed
  touchId           String?
  createdAt         DateTime         @default(now())

  @@unique([internetMessageId, sandboxContactId])
  @@index([sandboxContactId, at])
  @@index([conversationId])
}

model MailboxCursor {
  userId    String
  folder    String    /// sentitems | inbox
  deltaLink String?
  lastRunAt DateTime?
  error     String?

  @@id([userId, folder])
}

/// One push request from Bellwether, kept 7 days for idempotent replay. Check requests (14.14)
/// write nothing and have no row.
model BellwetherPush {
  id             String   @id @default(uuid())
  idempotencyKey String   @unique
  bodyHash       String
  state          String   /// PROCESSING | DONE
  pushedByEmail  String
  ownerId        String?
  contactCount   Int
  response       Json?
  createdAt      DateTime @default(now())

  items BellwetherPushItem[]

  @@index([createdAt])
}

/// Per-contact result of a push, kept as long as the contact's status may be asked for.
model BellwetherPushItem {
  id                  String         @id @default(uuid())
  pushId              String
  push                BellwetherPush @relation(fields: [pushId], references: [id], onDelete: Cascade)
  bellwetherContactId String
  result              String
  reason              String?
  sandboxContactId    String?
  crmPersonId         String?
  createdAt           DateTime       @default(now())

  @@index([bellwetherContactId, createdAt])
}

/// One Move to CRM: up to 50 contacts (decision 10). Each item can be undone for one year.
model SandboxMove {
  id          String    @id @default(uuid())
  createdById String
  count       Int
  state       String    /// QUEUED | RUNNING | DONE
  createdAt   DateTime  @default(now())
  finishedAt  DateTime?

  items SandboxMoveItem[]
}

model SandboxMoveItem {
  id               String      @id @default(uuid())
  moveId           String
  move             SandboxMove @relation(fields: [moveId], references: [id], onDelete: Cascade)
  sandboxContactId String
  state            String      /// QUEUED | DONE | FAILED | DRY_RUN | UNDONE
  mode             String      /// create | attach
  companyAction    String?     /// linked | created | none
  twentyPersonId   String?
  twentyCompanyId  String?
  notesWritten     String[]    @default([])  /// Twenty note ids, for undo
  personUpdatedAt  String?     /// Twenty's updatedAt after Cadence's last write, for undo
  snapshot         Json        /// the contact as it was moved
  error            String?
  attempts         Int         @default(0)
  doneAt           DateTime?
  undoneAt         DateTime?
  undoneById       String?

  @@index([moveId])
  @@index([sandboxContactId])
  @@index([state])
}
```

### 4.2 Changes to existing models

| Model | Change |
|---|---|
| `Campaign` | `audience CampaignAudience @default(CRM)` (`enum CampaignAudience { CRM SANDBOX }`), with an index. |
| `Enrollment` | `personId String?` (was required), `person PersonCache?`, `sandboxContactId String?`, and a relation to `SandboxContact`. |
| `NextAction` | Same pattern: `personId` becomes optional and `sandboxContactId` is added. |
| `Touch` | Same pattern. `externalId` stays unique. |
| `PersonCache` | `phoneE164 String?` with an index. `calls CallLog[]`. |
| `User` | `callerNumber String? @unique` (the rep's Twilio number, E.164). Read from Twilio's IncomingPhoneNumbers and confirmed against the rep by an admin in Settings > Calling. Plus back relations. The `tw_` handles in `aliases` keep matching too. |
| `Pod` | `sandboxContacts SandboxContact[]`. |

### 4.3 The migration

One migration, `prisma/migrations/20261103000000_outreach_sandbox/`. Prisma generates the tables,
enums and columns. These parts are added to the SQL by hand, the way the first migration added
the partial index:

- Three CHECK constraints: `"personId" IS NOT NULL OR "sandboxContactId" IS NOT NULL` on
  `Enrollment`, `NextAction` and `Touch`. Each is added `NOT VALID` and then `VALIDATE`d, so the
  table is never locked for a full scan.
- `CREATE UNIQUE INDEX "Enrollment_one_active_per_sandbox_contact" ON "Enrollment"("sandboxContactId") WHERE status IN ('ACTIVE','PAUSED') AND "personId" IS NULL;`
- `DROP NOT NULL` on the three `personId` columns. Postgres only changes metadata, so this is instant.

No data is rewritten. `Campaign.audience` defaults to CRM for every existing campaign.
`PersonCache.phoneE164` is filled by the worker's one-time backfill and by every refresh after it.
Every object is new or optional, so the migration is safe to apply on the live database with the
app running.

When a row has both `personId` and `sandboxContactId`, it belonged to a sandbox contact that has
since moved. CRM queries read `personId`. Sandbox queries read
`sandboxContactId IS NOT NULL AND personId IS NULL`.

## 5. UI

The desktop layout only. The owner's table rules apply: fits the width, one row for search and
filters, a Filters button for the rest, chips below. No bold in running UI, no stripe on the left
edge, no explanatory subtext.

**Sidebar.** "Sandbox" under Engagement, below Campaigns. Its count is the signed-in user's
sandbox tasks and next actions due today or overdue.

**`/sandbox`**, three tabs:

1. **Contacts** (default).
   - Columns: Name (title under it), Firm, Owner, Ready for CRM ("Ready", or the first missing
     item and "+N"), Campaign, Next action (what and when), Last touch, Calls, Source ("Bellwether
     · 2 Nov").
   - Toolbar, one row: search, Owner (opens on "Mine"), Status (Active, Unclaimed, Moved to CRM,
     Opted out, Removed), Ready for CRM, Pod, Source.
   - Bulk bar: Claim, Assign to, Start campaign, Add to campaign, Move to CRM, Remove. A next
     action is set per contact, on its page.
   - Header: Add contact. CSV import is not in this build: Bellwether is the source, and a file can
     come later through the enrichment mapping without a schema change.
   - The Moved to CRM status lists tombstones with a link to the person in People, and Undo while
     the one-year window is open.
2. **Work**. The sandbox's own steps and next actions, overdue first, with Call (calls), Done
   (email and LinkedIn steps, next actions) and Skip with a reason. Call opens the dialpad URL with the number, as everywhere
   else, and every call ends in the post-call form once the import has read it from Twilio.
3. **Campaigns**. The campaigns with `audience = SANDBOX`. A campaign is started from the Contacts
   tab: select contacts, Start campaign (name, sequence, pod, start day, new people a day per FO).
   It runs on the existing engine (decision 1); the studio's calendar planner stays CRM only in this
   build. A sandbox campaign has its own page (`/sandbox/campaigns/[id]`) with Approve, Pause,
   Resume and Stop. The main Campaigns page lists CRM campaigns only.

**Contact page `/sandbox/[id]`.**
- Header band: name, title, firm, owner, pod, the Ready for CRM chip, Call, and Move to CRM (the
  primary button once the contact is ready).
- Overview: the fields grouped as Twenty groups them (Contact, Firm, Classification), editable in
  place, because sandbox data belongs to Cadence. Also the next action card, and a link to the
  contact in Bellwether.
- Activity: one timeline of calls (outcome, rating, duration, recording player, the form), emails
  seen through Graph, notes and task completions.
- Campaigns and Notes tabs.

**Move to CRM dialog** (section 8.6) and the batch page `/sandbox/moves/[id]`.

**No softphone.** Calls are placed in the hosted dialpad, which opens in its own tab as today.

**Post-call form** (section 10). It is due as soon as the import has read the ended call from
Twilio and matched it to the rep (within about 2 minutes). While a call of yours has no form, a
bar above the page content names it ("Your call with Jane Doe, 14:05") and opens the form, and
Cadence's Call buttons are disabled until the form is in.

**Reports > Calls** (section 11), the Reports **Sandbox** section and the **Platform** totals.

**Settings.**
- New tab **Calling**: whether Twilio is connected (the env vars are present, and the last
  import's time and error), the account's numbers read from Twilio's IncomingPhoneNumbers each
  with its rep (suggested from the number's friendly name, confirmed by the admin, stored as
  `User.callerNumber`), "Import calls now", the calling-hours rule (block or warn), and the
  outcomes and form rules.
- New tab **Sandbox**: CRM-ready rules, the values Move to CRM writes to Twenty, the bulk limit
  (at most 50), the undo window (one year), retention, the suppression list (add an email, phone
  or LinkedIn URL; each entry opts the matching contact out), and the Bellwether connection (key
  present yes/no, last push, pushes in the last 7 days).
- **Sign-in** gains a `Mail.Read` row, worked the way the `Files.Read.All` row works.

## 6. Ownership, visibility and roles

- **Visibility.** Everyone sees every sandbox contact, as with every other section. Lists open on
  the reader's own contacts. Biz Ops reads only.
- **Owner and pod.** Each contact has an owner (a Cadence user) and a pod, or it is unclaimed.
  The pod decides who may change the contact, which is the same rule as everywhere else. A
  contact has no pod until it has an owner. A pod is required before Move to CRM, because Twenty's
  Pod Owner comes from it.
- **Arriving from Bellwether.** Everyone in Bellwether may push (decision 16). The owner is
  `assignTo`, or else the person who pushed (the rules are in section 14). If that user cannot own
  contacts in Cadence, each new contact is refused (`owner_not_found`), never created unclaimed.
- **Claiming.** Any sales role can claim an unclaimed contact, and the first claim wins. On
  launch, a sandbox campaign gives each unclaimed contact in its audience to the FO it assigns,
  who becomes the owner.
- **Two reps, one person.** The first push or claim owns the contact. A second push gets
  `duplicate_in_sandbox`, and the response names the owner. Changing hands is a reassignment.

| Action | Junior FO | Senior FO | Sales Leader / Pod Manager | Admin | Biz Ops |
|---|---|---|---|---|---|
| See sandbox contacts, calls, campaigns | yes | yes | yes | yes | yes |
| Add, edit, note, call, set next action | own and unclaimed | own pods | own pods | all | no |
| Claim unclaimed | yes | yes | yes | yes | no |
| Assign to someone else | release own only | own pods | own pods | all | no |
| Sandbox campaigns | as CRM campaigns today (`canCreateCampaign`, `canEditCampaign`, `canApproveCampaign`) | | | | read |
| Move to CRM, one or up to 50 | own | own pods | own pods | all | no |
| Undo a move (one year) | own moves | own pods | own pods | all | no |
| Remove a contact | own | own pods | own pods | all | no |
| Erase a contact (GDPR) | no | no | no | yes | no |
| Reports > Calls | no (sees own calls on contact pages) | yes | yes | yes | yes |
| Settings > Calling and Sandbox, suppression list | no | no | no | yes | no |
| Opt a contact out (contact page, call form) | own and unclaimed | own pods | own pods | all | no |

Every refusal names who can, through new `whyNot*` helpers in `rbac.ts`.

## 7. Sandbox campaigns and next actions: the engine proposal

The owner asked to discuss campaign-core changes before they are built. This was the proposal,
and Rahul approved it on 3 November 2026 (decision 1), together with the default for a contact
moved mid-campaign (decision 3).

**Decided: reuse the engine and studio, with a subject that is either a person or a sandbox
contact.** The studio (`campaign-planner.ts`, `campaign-fit.ts`, `engine/campaign-calendar.ts`,
`capacity.ts`) already works on lists of ids. A second engine for the sandbox would duplicate
roughly six thousand lines that took a month to get right. With a shared engine:

- `Campaign.audience` says which table `personIds` refers to. A campaign's audience is all
  sandbox or all CRM, and never mixed.
- `Enrollment`, `NextAction` and `Touch` carry `sandboxContactId` when the subject is a sandbox
  contact (section 4.2). Making `personId` optional turns every place that assumes a person into
  a type error, so `pnpm typecheck` lists the full work list. Each place gets a small
  `subjectOf(enrollment)` helper that returns the same shape (name, email, phone, company, title,
  city) for either kind. That shape also covers `personalize.ts` tokens such as `{{company}}`.
- The audience rules in `campaign-audience.ts` gain sandbox reasons: opted out, already moved to
  CRM, in another sandbox campaign, owned by someone outside the campaign's FOs. They reuse
  `whoAndWhy`, so a reason is never repeated per person.
- Assignment is owner-first, as for CRM people: the contact's sandbox owner works it. Unclaimed
  contacts go to the least-loaded FO on the campaign, who then owns them.
- `sync-out.ts` writes no `[Cadence]` notes and mirrors no tasks for sandbox subjects. There is no
  Twenty record to write to.
- Replies, bounces and answered calls end a sandbox enrollment by the same rules as CRM. The
  evidence comes from Graph (section 12) and from call forms.
- Sandbox next actions (`NextAction` with `sandboxContactId`) work exactly as now: one open per
  contact, repeat rules, worked in Sandbox > Work. They are not written to Twenty while the
  contact is in the sandbox.

**Contact moved to CRM mid-campaign (decided, the default).** Moving is graduation, so the
sandbox sequence ends with exit reason `moved_to_crm` and its open tasks are cancelled. A move
usually follows a reply or a booked meeting, which would end the sequence anyway. The open next
action, if any, goes with the contact. It gets the new `personId`, and from then on it is the
person's Twenty Next Action and Next Action Due Date through the existing sync. The rep can add
the person to a CRM campaign the same day. The enrollment keeps its `sandboxContactId` and gains
the `personId`, so the person's Campaigns tab shows the sandbox campaign and why it ended.

Because the campaign ends, the Move to CRM dialog asks for the next step (what, how, when; 3 Nov).
Move waits until it is given. It replaces each moved contact's open next action, for the contact's
owner, and goes across as above: in Tasks, and in Twenty as the Next Action. A person already in
Twenty with an open next action keeps theirs.

The alternative was to keep the person in the sandbox campaign after the move and write later
steps to Twenty. That puts a CRM person in a sandbox campaign, which blurs the one-section split,
and it was not chosen.

## 8. Move to CRM

### 8.1 CRM-ready rules

A contact may move only when every required rule passes. The rules are checked live as the
contact is edited and shown as "Ready" or as a list of what is missing. Admins can switch rules
in Settings > Sandbox.

Required, by default:
1. First and last name, neither empty nor an email address nor "Unknown".
2. Firm name.
3. A valid email (not marked bad, `emailVerification` not invalid), **or** a direct or mobile phone
   that parses to E.164.
4. An owner with a Twenty login (`User.twentyMemberId`), which becomes Assigned To.
5. A pod, which becomes Pod Owner.
6. Status ACTIVE: not opted out and not on the suppression list.
7. The firm is not a blocked account, not a "Never prospects" entry, and not one of our own
   domains.
8. No live Twenty person matches by email, LinkedIn or phone (the phone rule of 14.6 rule 4).
   Matching ones are offered "attach history" instead (8.5).

Shown as a warning, not a blocker: no job title, no LinkedIn, no city, an email that is only
"risky", and no product interest.

### 8.2 Field mapping, sandbox to Twenty Person

| Sandbox | Twenty Person (`twenty-schema.ts` name) | Note |
|---|---|---|
| firstName, lastName | `name { firstName, lastName }` | |
| email, additionalEmails | `emails { primaryEmail, additionalEmails }` | |
| phone (+ extension) | `phones { primaryPhoneNumber, primaryPhoneCallingCode, primaryPhoneCountryCode }` | split from E.164 |
| additionalPhones[0] | `additionalNumber` | |
| linkedinUrl | `linkedinLink { primaryLinkUrl }` | `https://www.` prefix restored |
| jobTitle | `jobTitle` | |
| city, state | `city` | "Chicago, Illinois", which is this workspace's form |
| owner.twentyMemberId | `assignedToId` | All People shows the assignee |
| pod.podOwnerValue | `podOwner` | |
| (setting, default `BELLWETHER`, falling back to `LEADGEN` when the option does not exist) | `leadSource` | decision 8 |
| source, Bellwether link, individual CRD, designations, push date | `leadSourceNotes` | one line each |
| productInterest | `productInterest` | only values Twenty has |
| tags | `tags` | only options that already exist; Cadence does not add options |
| (fixed) | `contactType: [PROSPECT]`, `listCategory: COLD_BD`, `pipelineStageField: PROSPECT` | settings, decision 8 |
| (none) | `tier` | left for the pod |
| sandbox id | `cadenceSandboxId` | only if the optional field exists; makes retries exact |
| company (8.4) | `companyId` | |
| open next action | `nextAction`, `nextActionDueDate` | through the existing next-action sync, after creation |

### 8.3 History as Twenty notes

These are written through the `TwentyWrite` outbox, linked to the person and to the company:
- One note per call: `[Cadence] Call 14 Oct 2026 by Alyssa - Connected (4/5)`. The body has the
  outcome, rating, notes, the next step with its date, duration, campaign, and a link to the call
  in Cadence (the recording stays in Twilio and plays in Cadence).
- One note per sandbox note: `[Cadence] Note 12 Oct 2026 by Alyssa`.
- One summary note: `[Cadence] Sandbox history`. It has the source, push date and who pushed, the
  sandbox campaign and how it ended, a dated list of emails sent, replied to and bounced (subjects
  only), and the steps done.

Twenty sets a note's created date to the time of writing, so each title carries the original date.
Cadence ignores its own `[Cadence]` notes when they come back in (existing rule), so nothing is
counted twice.

### 8.4 Firm and account link

Order, first hit wins:
1. The firm CRD, if Twenty's Company has the optional `crd` field.
2. The domain (from the website, else from the email when that domain is not a free-mail domain)
   matched to `CompanyCache.domain`.
3. A normalised exact name match ("LLC", "Inc.", punctuation and case ignored) when only one
   company matches. When several match, the dialog asks the rep to pick.
4. Otherwise Cadence creates the Company with name, `domainName`, `address` (city and state),
   `employees`, `aum` (if the field exists) and `linkedinLink`. Account Owner is left empty
   (decision 9). `upsertCompanyCache` runs straight away.

When the matched company is blocked, the move is refused for that contact, with the reason.

### 8.5 Already in Twenty at move time

Someone may have added the person in Twenty since the push. Preflight runs a live `findPeople` by
email, LinkedIn and phone (14.6 rule 4). When it finds a match, the dialog offers **Attach
history**: the notes of 8.3 are written to the existing person, the sandbox contact becomes MOVED
with that `twentyPersonId`, and nothing on the person is changed. Assigned To and Pod Owner stay
as Twenty has them, because Cadence never edits a person it did not create.

### 8.6 Flow, bulk limits and errors

1. **Preflight** (the dialog). The rep selects contacts and opens Move to CRM. Each contact shows
   one of: Ready; Needs (the missing items, each linking to the field); Already in Twenty (Attach
   history); Firm (links to "Acme Advisors", will create "Acme Advisors", or choose one of two).
   The footer button is "Move 37". Contacts that are not ready are left out and grouped by reason.
2. **Queue.** One `SandboxMove` and a `SandboxMoveItem` per contact. At most 50 contacts per move
   (decision 10; a setting that can be lowered, never raised above 50). A selection of more than
   50 is refused with the count, before anything is queued. The dialog closes and the batch page
   shows progress.
3. **Worker** (`sandboxMoves`, every tick). Items are processed one at a time and paced under
   Twenty's 100 requests a minute. A move costs about 4 to 8 requests, so 50 contacts take
   roughly 2 to 4 minutes. Per item:
   1. Look the person up again by email (and `cadenceSandboxId` if present). Retries depend on
      this lookup to stay idempotent.
   2. Create the company if needed.
   3. Create the person.
   4. Store `twentyPersonId` at once.
   5. `upsertPersonCache` with Twenty's answer, so the person is in People without waiting for
      the sync.
   6. Move pointers in one transaction: `Touch`, `CallLog`, `NextAction` and the ended
      `Enrollment` get the `personId`.
   7. Queue the notes.
   8. Mark the contact MOVED.
   9. Write `AuditLog` (`sandbox_moved`).
4. **Errors.** A failed item stays in the sandbox with Twenty's error, and the rest of the batch
   carries on. The batch page has "Retry failed". The usual outbox rules apply to notes (backoff,
   Settings > Activity log).
5. **Dry run.** With `CADENCE_DRY_RUN=true`, nothing is created. Items end as DRY_RUN and the
   contact stays in the sandbox.

### 8.7 Audit and undo

- `SandboxMoveItem.snapshot` holds the contact as it was moved, plus every Twenty id created
  (person, company, notes). The same facts go to `AuditLog`, so Activity shows "Alyssa moved 37
  contacts to the CRM".
- **Undo** is allowed for one year from the move (decision 10), per item or for the whole batch,
  by the mover, a pod leader of the pod, or an admin. After a year it is refused, with the date
  the window closed. It is allowed only while Twenty's `updatedAt` on the person still equals
  `personUpdatedAt` and the person has no activity other than Cadence's notes; over a year this
  usually stops being true, and the refusal then says what changed in Twenty.
- Undo deletes Cadence's notes. It soft-deletes the person, and the company too when Cadence
  created it and nobody else is linked to it. It points the rows back to the sandbox contact and
  makes it ACTIVE again. Otherwise the answer says what changed in Twenty, and who changed it.
- Undo of an "attach" removes only the notes.

### 8.8 After the move

The person is in People, Accounts, search and campaign audiences like any CRM person, with
Assigned To and Pod Owner set. In Twenty, they are in All People with the same fields. Their
calls, forms and next action follow them. Undo needs the sandbox row as it was, so the row keeps
its data for the one-year undo window; once the window has passed, the nightly
`sandboxRetention` job leaves only ids and dates (`piiClearedAt`), so the CRM is the only copy of
their data. The tombstone
remains so the dedupe and the Bellwether status still work.

### 8.9 Cleaning up people Twenty creates from mail and calendars

Twenty's contact auto-creation stays on (decision 11). When a rep emails or meets a sandbox
contact, Twenty may create a person for them. The worker's `sandboxCrmCleanup` job
(`src/lib/sandbox/crm-cleanup.ts`) runs every 5 minutes and looks at Twenty people where all of
these hold:

- `createdBy.source` is `EMAIL` or `CALENDAR`, read live from Twenty before anything happens;
- the email or an additional email matches a sandbox contact that is not MOVED, and no MOVED one;
- the person was created after that sandbox contact.

Candidates are found in the person cache, so a new person is seen within one CRM sync. Each one is
read live from Twenty. It is soft-deleted (restorable from Twenty's trash) only when nobody
touched it:

- `updatedAt` is within 10 minutes of `createdAt` (`SYNC_MARGIN_MS`, for the sync's own writes);
- it has no notes, tasks or opportunities in Twenty;
- it is in no Cadence campaign or enrollment, has no Cadence next action, call or meeting;
- no Move to CRM item and no sandbox contact points at it.

Otherwise it is left alone and the sandbox contact is flagged ("Also in CRM, created from email",
`crmAutoPersonId`, `crmAutoSource`, `crmAutoFlaggedAt`), with an audit row giving the reasons. A
flagged person is not read again. People created MANUAL, IMPORT or API, or by Cadence, are never
touched.

Each removal writes an audit row (`crm_auto_person_removed`) with the person id, name, email,
source and sandbox contact, and marks the person deleted in the cache, so dedupe and Move to CRM no
longer see it. In dry run nothing is deleted; one `crm_auto_person_would_remove` row is written per
person. Settings > Sandbox has the switch (on by default), the counts and a Clean up now button.
At most 50 people are read per run, to stay under Twenty's rate limit.

### 8.10 The daily check against Twenty (4 Nov)

A push is refused when Twenty has the person (14.6 rule 4), but someone can add them to Twenty
afterwards, by hand or by import. Each night the worker matches every ACTIVE sandbox contact
against Twenty again, by rule 4, asking Twenty itself first (up to 15 minutes; past that, or when
Twenty cannot be reached, Cadence's copy decides). A contact Twenty now has:

- is flagged on `crmMatchPersonId`, `crmMatchedOn` and `crmMatchedAt`, shown as "Also in CRM" on
  the contact and in the Contacts list, linking to the person;
- has its outreach stopped: a running sandbox campaign ends with exit reason `in_crm`, its open
  next action closes, no sandbox campaign takes it again and no next action can be set;
- reads as `already_in_crm` in the Bellwether status, with the person's id and owner.

The owner then uses Move to CRM, which attaches the history to that person. A person Twenty's mail
or calendar sync created is the cleanup's (8.9), unless the cleanup kept it because someone worked
it. When the person leaves Twenty, the next night clears the flag; stopped outreach is not
restarted. Audit rows `sandbox_in_crm` and `sandbox_in_crm_cleared`.

## 9. Twilio

Decisions 4, 5 and 14 set this section: no new Twilio app, no TwiML App, no Voice SDK, no new
numbers, no Cadence voice webhooks, and no recording or transcription in Cadence. Cadence only
reads.

### 9.1 What exists today

Calls go through Acumen's hosted Twilio webhook app, the dialpad at
`https://h00ks.acm.acumen-strategy.com/admin/dialpad`. Reps and their numbers are already set up
in Twilio, and Twilio already records the calls. The dialpad's code is in neither repository
(Cadence nor Bellwether), so Cadence must not depend on changing it, and does not. Twenty already
receives notes from the dialpad, titled `[CALL] Outbound Call by tw_<name>`, and Cadence's ingest
uses them to close call steps. `User.aliases` holds the `tw_` handles.

### 9.2 Placing a call

Unchanged. Every Call button and phone number opens the configured dialpad URL with the number
(`settings.rules.clickToCallUrl`, `src/lib/calls.ts`), in its own tab, as today. The button also
saves a `CallIntent` (who pressed it, the number in E.164, and the task, next action, CRM person or
sandbox contact it was pressed for). Before it opens the dialpad, Cadence checks its own rules:

- the contact is not opted out or suppressed (the button is disabled, with the reason);
- the rep has no call waiting for its form (section 10);
- calling hours (9.7).

Nothing is sent to Twilio or to the dialpad other than the number in the URL, which is what
happens today.

### 9.3 Reading calls from Twilio (`twilioImport`)

A read-only worker job, every 2 minutes, when `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID` and
`TWILIO_API_KEY_SECRET` are set. Admins can also run it from Settings > Calling ("Import calls
now"). It never writes to Twilio.

1. Read the watermark (Setting `twilioImport.watermark`; the first run starts 24 hours back).
2. Page `GET /2010-04-01/Accounts/{AccountSid}/Calls.json?StartTime>={watermark - 10 minutes}&PageSize=100`,
   following `next_page_uri`. The 10-minute overlap catches calls that started just before the last
   run. Calls already stored are updated, never duplicated (`twilioCallSid` is unique, and the
   status only moves forward).
3. Also re-read, by `GET .../Calls/{CallSid}.json`, every stored call that is not yet in a final
   status and started within the last 6 hours, so a long call that began before the overlap still
   ends.
4. Keep one `CallLog` per conversation: the leg whose other party is a phone number. A leg whose
   `from` or `to` is `client:...` or `sip:...` (the dialpad's browser leg) is not stored itself;
   its identity (`client:tw_alyssa`) is copied to the child leg as `repIdentity`, and its SID kept
   as `parentCallSid`.
5. For each stored call that has ended, `GET .../Calls/{CallSid}/Recordings.json` (and the same for
   its parent leg, since some apps record the parent). The newest completed recording's SID and
   length are stored on the call. The audio stays in Twilio.
6. Advance the watermark to the start of this run.

**Matching the rep.** In this order, among active users:
1. The caller number: for an outbound call its `from`, for an inbound call its `to`, equals
   `User.callerNumber` (`repMatchedBy caller_number`). The numbers come from Twilio's
   `IncomingPhoneNumbers`; an admin confirms which rep owns each in Settings > Calling. Cadence
   suggests the rep whose name or `tw_` handle appears in the number's friendly name, and stores
   nothing until the admin confirms.
2. The `tw_` alias: `repIdentity` (`client:tw_alyssa`) equals one of the user's `aliases`
   (`alias`).
3. A `CallIntent` by one rep to the same number within 30 minutes before the call started, when
   only one rep has such an intent (`intent`).
4. Otherwise `none`: the call is listed under Reports > Calls > Unmatched, where a pod leader or
   admin picks the rep (`chosen`).

**Matching the task.** The newest unclaimed `CallIntent` by the matched rep to the same number,
made within 30 minutes before the call started, gives the task, next action and contact
(`matchedBy dialed`) and is marked used.

**Pending form.** A call with a matched rep that has ended gets `formDueAt` and opens a pending
post-call form for that rep (section 10). A call whose rep is chosen later gets its form then.

**Touches.** Each matched call also creates a `Touch` with `externalId twilio:<CallSid>`. The
existing "one touch counts once" rule (six hours, same channel) merges it with the dialpad's
Twenty note, so a step closes once.

**Manual log.** "Log a call" with no Twilio call (a mobile phone, say) creates a `CallLog` with
`source MANUAL` and the same form. It has no recording.

### 9.4 Matching calls to contacts (sandbox and CRM)

1. From an intent: the subject is known (`matchedBy dialed`).
2. Otherwise the other party's E.164 number is matched against ACTIVE `SandboxContact.phone` and
   `additionalPhones`, and against `PersonCache.phoneE164` and `additionalPhone` (not deleted,
   not team members).
3. One hit links the call (`number`).
4. Several hits happen with shared main lines. Cadence prefers the contact whose open task or
   next action belongs to the caller. If that does not settle it, the call is `ambiguous` and
   goes to the Unmatched list with the candidates.
5. No hit: `none`, listed under Unmatched. There a user can attach the call to a contact, or
   create a sandbox contact from it (`source CALL`).

Office, main and toll-free numbers that came from Bellwether are kept on the contact but never
auto-match a call. They are shared by everyone at the firm.

### 9.5 Inbound and unknown numbers

Cadence does not touch inbound routing; the existing numbers keep their configuration. Inbound
calls on the account are read by the same job and matched the same way (the rep by the number
that was called). An answered inbound call with a matched rep gets a post-call form.

### 9.6 Recordings

- Twilio already records calls; Cadence adds no recording and no transcription. It reads the
  recording SID from `Recordings.json` and plays the audio through
  `GET /api/calls/{id}/recording`, which needs a session and the right to see the call. The route
  streams `.../Recordings/{RecordingSid}.mp3` from Twilio with the API key, passes `Range`
  through so seeking works, and stores no copy. The Twilio credentials never reach the browser.
- Cadence never deletes recordings. How long Twilio keeps them stays as Acumen has set it in
  Twilio.

### 9.7 Calling hours

Cadence's own Call button checks the contact's local time: 8:00 to 21:00, from the state (else the
area code, else the workspace clock). Outside it the button is disabled with the local time shown;
an admin can switch this to a warning in Settings > Calling. This is a check in Cadence only. It
needs no Twilio change and cannot stop a number dialled straight into the dialpad.

### 9.8 Cost

Reading the REST API costs nothing. Cadence adds no numbers, minutes or recordings.
`CallLog.priceUsd` (from the Calls API) makes the real cost of the existing calls a column in
Reports > Calls.

## 10. The post-call form

**When it appears.** It appears after every call: read from Twilio and matched to a rep, or logged
by hand. A call is complete only once its form is in (`formDoneAt`).

**Enforcement.** The form is due as soon as the import has the ended call (within about 2
minutes of hangup) and opens from the pending bar. Closing it leaves the call pending. While any
of the rep's calls is pending:
- Cadence's Call buttons are disabled, and the reason names the call.
- A bar above the page content lists the pending calls.
- Sandbox > Work and Tasks show the form before anything else.

Only the rep who made the call can submit its form. Pod leaders see pending forms in Reports >
Calls.

**Fields.** Outcomes come from `settings.rules.callDispositions`, editable as today.

| Field | Rule |
|---|---|
| Outcome | Required. Connected, Spoke to gatekeeper, Left voicemail, No answer, Busy / call back, Wrong number, Not interested, Meeting booked, Asked not to be contacted. Pre-filled from Twilio for busy, no answer and failed. |
| Rating 1 to 5 | Required when the outcome is answered. |
| Notes | Required when answered; optional otherwise. |
| Next step, with its date | One field (decision 6): the step and its date are chosen together. Steps: Call again, Email, LinkedIn, Meeting, No further action. The date is required for every step except No further action, defaults to 2 working days on, and cannot be in the past. "Not interested" and "Asked not to be contacted" pre-select No further action. |
| Interest | Hot, Warm or Cold. Optional. |
| Products discussed | Twenty `productInterest` values. Optional. |
| Decision maker | Yes, No or Unknown. Optional. |

A call that never connected (busy, no answer, failed, voicemail) needs only the outcome and the
next step with its date. The form is one screen with keyboard shortcuts, as the Log call panel
has today.

**What submitting does:**
- Closes the call step the call was for, through `completeCall`. An answered outcome ends the
  sequence as replied, as today (`answeredCallIsReply`).
- The next step creates the contact's next action on its date, or moves the open one there:
  - Call again: a CALL next action.
  - Email or LinkedIn: that channel.
  - Meeting: a CALL next action labelled "Meeting", the day of the meeting.
  - No further action: the open next action, if any, is closed.
  - The next action is the existing `NextAction`, so for a CRM person it is also written to
    Twenty's Next Action and Next Action Due Date.
- "Meeting booked" offers Add meeting (the Meetings form, pre-filled). For a sandbox contact it
  also offers Move to CRM, because a meeting is recorded in Twenty.
- "Asked not to be contacted" goes through the one opt-out path (`src/lib/sandbox/opt-out.ts`):
  - sandbox contact: status OPTED_OUT, `optedOutAt` and `statusChangedAt` set in the same write,
    and suppression entries for its email, phones, LinkedIn and Bellwether id. Bellwether's status
    sync then reads `opted_out` (decision 23);
  - CRM person: Cadence's existing `optedOut` flag, plus suppression entries, so a later push of
    the same person is refused as `suppressed`;
  - ends their sequences with reason `opted_out` and closes the open next action;
  - shows the rep a reminder to set `dnd` in Twenty for CRM people, because Cadence does not write
    `dnd`.
- Wrong number marks the phone as bad, as today.
- **Notes.**
  - CRM person: one `[Cadence] Call ... by <FO> - <outcome> (<rating>/5)` note goes to Twenty
    straight away, through the outbox. It replaces the completion note `sync-out.ts` would have
    written for the step, so there is one note per call.
  - Sandbox contact: the form is kept in Cadence and becomes that note on the move.

## 11. Call analytics view (Reports > Calls)

Filters: date range, pod, rep, campaign, direction and source. There is no audience filter
(decision 2): every tile shows the platform total, and the table under the tiles splits each
metric into CRM, Sandbox and Platform (both together). Each tile shows the previous period beside
it, like Reports today.

**The rest of Reports (decision 2).** The existing Reports numbers stay CRM numbers. A new
**Sandbox** section shows the sandbox numbers on their own (contacts pushed and added, claimed,
called, connected, meetings, moved to CRM, opted out, sandbox steps done), and a **Platform**
section shows the totals that exist on both sides (steps done, calls, connects, meetings booked,
next actions done) as CRM + Sandbox = Platform.

| Metric | Definition |
|---|---|
| Dials | Outbound calls placed, from any source. |
| Connects | Calls whose form outcome is answered. Before the form is in: talk of at least 30 seconds (a setting). |
| Connect rate | Connects ÷ dials. |
| Conversations | Connects with at least 2 minutes of talk (a setting). |
| Talk time | Total and average per connect (`talkSec`). |
| Outcomes | Count per disposition. |
| Meetings booked | Forms with "Meeting booked", beside meetings in the Meetings section booked by the same reps. |
| Average rating | Mean form rating. |
| Forms outstanding | Calls with no form, and the median time to a form. |
| Best hours | Connect rate by weekday × hour in the workspace clock. |
| Sandbox funnel | Pushed → called → connected → meeting → moved to CRM. |
| Cost | Sum of `priceUsd`. |

Breakdowns: by rep, pod, campaign, sandbox vs CRM, and number. Below the tiles there is a call
table (when, rep, contact, outcome, rating, duration, recording) that opens the call with its form
and recording. An Unmatched tab lists calls to attach to a rep or a contact. Charts follow the `dataviz` rules and the
existing Reports palette. The report HTML export includes the Calls view.

## 12. Sandbox emails: auto-close through Microsoft Graph

**How this fits "Cadence never sends email."** Reps keep sending from Outlook. Cadence reads the
metadata of sent and received mail in the sales mailboxes: addresses, subject, time and
conversation, never the body. For CRM people, Twenty's mailbox sync already does this job.
Sandbox contacts are not in Twenty, so Twenty cannot, and Graph fills that gap. No `Mail.Send`;
emails keep going out from Outlook (decision 12).

**Switch.** Off unless `GRAPH_MAIL_ENABLED=true` is set in Cadence's environment. It uses the
existing Microsoft app credentials (`MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID`,
`MICROSOFT_CLIENT_SECRET`, or the app saved in Settings > Sign-in). With the switch unset, or no
app, the job does nothing and Settings > Sign-in says which is missing.

**Permission (decision 12).** The application permission `Mail.Read` on the existing app
registration, read only, limited by Exchange Online to a mail-enabled security group that holds
the sales mailboxes. Cadence asks Graph only for the metadata fields below, never the body, even
though `Mail.Read` would allow it. Settings > Sign-in shows whether the permission works and keeps
Microsoft's last refusal, the way the `Files.Read.All` row does.

**Admin steps** (a Global or Exchange administrator, once; replace the example names and
addresses):

1. *Group.* In the Exchange admin center (or Exchange Online PowerShell after
   `Connect-ExchangeOnline`), create a mail-enabled security group for the sales mailboxes and add
   each rep's mailbox:
   ```powershell
   New-DistributionGroup -Name "Cadence mail tracking" -Alias cadence-mail-tracking -Type Security
   Add-DistributionGroupMember -Identity cadence-mail-tracking -Member alyssa@acumen-strategy.com
   ```
   A rep who joins later is added to this group; nothing changes in Cadence.
2. *Permission.* Microsoft Entra admin center > App registrations > the app Cadence signs in with
   (its Application (client) ID is the one in Settings > Sign-in) > API permissions > Add a
   permission > Microsoft Graph > Application permissions > `Mail.Read` > Add, then "Grant admin
   consent for Acumen". Do not add `Mail.Send` or `Mail.ReadWrite`.
3. *Limit it to the group* with an application access policy:
   ```powershell
   New-ApplicationAccessPolicy -AppId <application-client-id> `
     -PolicyScopeGroupId cadence-mail-tracking@acumen-strategy.com `
     -AccessRight RestrictAccess -Description "Cadence reads the sales mailboxes only"
   ```
4. *Check it* (allow up to an hour for the policy to apply):
   ```powershell
   Test-ApplicationAccessPolicy -Identity alyssa@acumen-strategy.com -AppId <application-client-id>   # AccessCheckResult: Granted
   Test-ApplicationAccessPolicy -Identity someone.else@acumen-strategy.com -AppId <application-client-id>   # AccessCheckResult: Denied
   ```
5. *Switch it on.* Set `GRAPH_MAIL_ENABLED=true` in the Nomad variable `nomad/jobs/cadence` and
   redeploy. Settings > Sign-in shows `Mail.Read` working, or Microsoft's refusal.

*Alternative to steps 2 and 3, RBAC for Applications* (Microsoft's newer replacement for access
policies). Do not grant the Entra consent of step 2 in this case, because an Entra grant is
tenant-wide and RBAC grants only add to it:
```powershell
New-ServicePrincipal -AppId <application-client-id> -ObjectId <enterprise-application-object-id> -DisplayName "Cadence"
New-ManagementScope -Name "Cadence sales mailboxes" -RecipientRestrictionFilter "MemberOfGroup -eq '<distinguished name of cadence-mail-tracking>'"
New-ManagementRoleAssignment -App <application-client-id> -Role "Application Mail.Read" -CustomResourceScope "Cadence sales mailboxes"
Test-ServicePrincipalAuthorization -Identity <application-client-id> -Resource alyssa@acumen-strategy.com
```

**Detection** (worker `graphMail`, every 2 minutes when switched on, for each active sales user
with a `microsoftId`):
- **Sent.** `GET /users/{id}/mailFolders/sentitems/messages/delta`, selecting `internetMessageId,
  conversationId, subject, sentDateTime, toRecipients, ccRecipients, bccRecipients`. The
  `deltaLink` is kept in `MailboxCursor`, and the first run starts from the day tracking is
  switched on. Any To, Cc or Bcc address that equals an ACTIVE sandbox contact's email or
  additional email (normalised) gives a `SandboxEmail` (SENT) and a `Touch` (EMAIL, OUTBOUND,
  `externalId graph:<internetMessageId>:sbx:<contactId>`). The existing evidence rules then close
  the step: only an open EMAIL step, only once the previous step is done, one email closes one
  step. An open EMAIL next action due today or earlier is closed too.
- **Replies.** The same delta on `inbox`. A message from a sandbox contact's address is a REPLY
  touch, so the sequence ends as replied and the rep is notified. The existing auto-reply rule
  (out of office, read receipts and the like, by subject) stores it as AUTO_REPLY and leaves the
  sequence running.
- **Bounces.** An inbox message from `postmaster@`, `mailer-daemon@` or the Exchange system
  sender, with an "Undeliverable" or "Delivery has failed" subject, matched to a SENT
  `SandboxEmail` by `conversationId`. If that fails, Cadence uses the subject within 72 hours.
  A match marks the email bad and skips the contact's email steps with the existing `bounced`
  reason. Several possible matches are flagged on the contact rather than guessed. Without the
  body this is a heuristic, which is why `badEmail` can be cleared by hand.
- **Privacy.** Messages that match no sandbox contact are never stored. Only the fields above are
  kept.

**Not in this build: Twenty message participants as a second source.** Twenty may sync messages
from these mailboxes with participants it could not link to a person, and `ingest.ts` could match
those to sandbox emails. It is left out of v1 so that there is one source of sandbox email
evidence; it can be added later behind the same matching code.

**Twenty's contact auto-creation stays on; Cadence cleans up after it.** With "contact
auto-creation" on, emailing or meeting a sandbox contact creates a Twenty person by itself. Rahul
keeps it on (decision 11, changed 3 Nov). Cadence removes those people again when nobody has
worked them, so what is in the sandbox stays in the sandbox: section 8.9.

## 13. Compliance

- **One suppression list** (`Suppression`). It holds hashes of email, phone, LinkedIn and
  Bellwether id. It is checked:
  - on push (`rejected` / `suppressed`),
  - on manual add,
  - in sandbox campaign audiences,
  - before every call: Cadence's Call button is disabled with the reason (a number typed straight
    into the dialpad is outside Cadence's reach),
  - before Graph closes steps.
- Sources of suppression entries, all through the one opt-out path (`src/lib/sandbox/opt-out.ts`):
  - the call form's "Asked not to be contacted",
  - an Opt out button on the contact,
  - an entry added to the suppression list in Settings > Sandbox (it opts out every sandbox contact
    whose email, phone or LinkedIn matches),
  - erasure,
  - Twenty `dnd` or a DNC tag found on a CRM match during dedupe.
- **Opt-out reaches Bellwether (decision 23).** Every path above that touches a pushed sandbox
  contact sets its status to OPTED_OUT and `statusChangedAt` in the same write, so the status
  endpoint (14.12) returns `opted_out` with that `statusChangedAt`, by id and through
  `changedSince`. Bellwether then blocks further pushes. A pushed contact that was refused as
  `already_in_crm` and is later opted out on the CRM side gets the same suppression entries; its
  status stays `already_in_crm`, and a new push of it is refused as `suppressed`.
- **Opted out in the CRM.** Twenty's `dnd` and DNC tag are already honoured for CRM people.
  Opted-out sandbox contacts cannot be moved.
- **Do-not-call.** B2B calls to firm lines about business services are generally outside the
  National Do Not Call Registry rules. Calls to personal mobiles may not be. Cadence ships no
  registry scrub, and there is no counsel sign-off step (decision 14). Calls are dialled by a
  person, one at a time, with no pre-recorded messages. Calling hours (9.7) apply to Cadence's
  Call button.
- **Email opt-out.** Sequence templates for the sandbox should carry an opt-out line. A reply
  that asks to stop is a reply: the sequence ends, and the rep marks the opt-out.
- **No recording announcement.** Recording is the existing Twilio setup's; Cadence adds no
  announcement and changes nothing in Twilio (decision 14).
- **GDPR and other privacy law.** Most contacts are US advisers. For a contact whose `country` is
  in the EEA or UK:
  - the lawful basis is legitimate interest (`lawfulBasis`),
  - the first email must say where the data came from (Article 14, within a month),
  - erasure requests are honoured.
- **Erase** (admin) deletes the contact's personal data, notes and emails in Cadence, unlinks its
  calls, and keeps only a suppression hash. Cadence's Twilio key is read only, so the erase
  confirmation lists the call recording SIDs for an admin to delete in the Twilio console when
  the request covers recordings. California deletion requests use the same action.
- **Retention for contacts who never convert.** The nightly `sandboxRetention` job removes ACTIVE
  sandbox contacts with no activity for 180 days, or never worked 90 days after the push (both
  settings). Personal data is cleared, status becomes REMOVED, and Bellwether's status shows
  `removed`. Opted-out contacts keep the tombstone (status, Bellwether id, dates) and the
  suppression hashes, so Bellwether keeps reading `opted_out`. Recordings are not Cadence's to
  delete (9.6).

## Shared contract with Bellwether

Section 14 of this plan; its parts are numbered 14.1 to 14.16. Version 1, with the additions of
contract 1.1 (cold outreach plan, 7.3, 6 Nov 2026). Cadence serves this API and Bellwether calls it.
Bellwether's plan copies this section word for word, and its test fixture
(`scripts/cadence_contract_fixture.json`) is generated from the JSON examples below; a test in each
app checks both. Changes within v1 are additive only (new optional request fields, new response
fields, new warning codes). Anything else is a v2 path.

**Contract versions.** `ping` lists the versions Cadence speaks in `contracts` (`["1", "1.1"]`), to
every caller. A caller that finds `"1.1"` there sends **`X-Cadence-Contract: 1.1`** on every
request and reads the 1.1 answers: the new fields and warning codes, and the status `refused`. A
request without the header gets exactly the v1 answer, so either app can be deployed, and rolled
back, on its own. The parts marked **(1.1)** below apply only to a request that carries the header.
The rules that decide who is refused, deduped or owned apply to every caller.

### 14.1 Base URL and transport

- Bellwether reads Cadence's base URL from env **`CADENCE_API_URL`**, for example
  `https://cadence.pmx.acumen-strategy.com`, with no trailing slash. HTTPS only.
- Requests and responses are `Content-Type: application/json; charset=utf-8`.
- Times are ISO 8601 UTC with `Z` (`2026-11-03T15:04:05Z`). Dates are `YYYY-MM-DD`.
- Cadence ignores request fields it does not know. Bellwether ignores response fields it does not
  know.
- **(1.1)** The header `X-Cadence-Contract: 1.1` asks for contract 1.1's answers.

### 14.2 Authentication

- Header **`X-Cadence-Api-Key: <key>`** on every request.
- Cadence reads the key from env **`BELLWETHER_API_KEY`**. During a rotation it also accepts env
  **`BELLWETHER_API_KEY_PREVIOUS`**. The comparison is constant-time.
- Bellwether reads the same key from env **`CADENCE_API_KEY`**.
- The key is at least 32 random bytes, base64url, generated by an admin. It is stored only in each
  app's environment (Nomad variables), never in code, docs, chat, logs or a database.
- A missing or wrong key gets 401. If `BELLWETHER_API_KEY` is unset in Cadence, every call gets
  503 `integration_disabled`.

### 14.3 Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/integrations/bellwether/v1/ping` | Key and connectivity check, and the contract versions Cadence speaks. |
| POST | `/api/integrations/bellwether/v1/contacts` | Push 1 to 500 contacts into the sandbox. |
| POST | `/api/integrations/bellwether/v1/contacts/status` | Status of pushed contacts, by id or by change time. |
| POST | `/api/integrations/bellwether/v1/contacts/check` | The per-contact results a push would give, without writing anything (14.14). |
| POST | `/api/integrations/bellwether/v1/contacts/suppress` | A Do not contact set in Bellwether opts the person out in Cadence (14.15). Contract 1.1. |
| GET | `/api/integrations/bellwether/v1/owners` | Who can own contacts, with their pods (14.16). Contract 1.1. |

**Ping**, 200. `contracts` is in every answer, so a caller learns of 1.1 before it sends the header:
```json
{ "ok": true, "version": "1", "sandboxEnabled": true, "maxBatch": 500, "serverTime": "2026-11-03T15:04:05Z", "contracts": ["1", "1.1"] }
```

### 14.4 Push request

Headers: `X-Cadence-Api-Key`, and **`Idempotency-Key: <UUID v4>`** (required).

Envelope:

| Field | Type | Required | Rules |
|---|---|---|---|
| `pushedBy` | object | yes | The Bellwether user who pressed Push. |
| `pushedBy.email` | string | yes | 3 to 254 characters; their sign-in email. Cadence lower-cases it. |
| `pushedBy.name` | string | no | ≤ 200. |
| `pushedBy.microsoftObjectId` | string | no | Entra ID object id (GUID). Matched first. |
| `assignTo` | object or null | no | Owner when it is not the pusher. |
| `assignTo.email` | string | yes, if `assignTo` is given | Matched to a Cadence user. |
| `pod` | string or null | no | A Twenty `podOwner` value such as `ALISA`, compared in any case. Used only when the owner works that pod. Bellwether sends the owner's pod: their only one, or the one the sender chose among those `GET /owners` lists. |
| `contacts` | array of Contact | yes | 1 to 500 items. |

Contact:

| Field | Type | Required | Rules |
|---|---|---|---|
| `bellwetherContactId` | string | yes | 1 to 200 characters, not only spaces, no control characters. Stable for the life of the contact in Bellwether. Compared exactly (case-sensitive). Recommended form: `<firmCrd>:<personKey>`. |
| `firstName` | string | yes | 1 to 100 characters after trimming. |
| `lastName` | string | yes | 1 to 100 characters after trimming. |
| `jobTitle` | string or null | no | ≤ 200. A longer one is cut at a word, with a warning. |
| `email` | string or null | no | ≤ 254, basic address syntax. |
| `emailVerification` | `"valid"`, `"risky"`, `"unknown"` or `"invalid"` | no | Default `"unknown"`. `valid`: a mail server confirmed the mailbox. `risky`: catch-all or accept-all. `invalid`: known to bounce; Cadence keeps it but never emails it. Addresses known to bounce are not sent. |
| `additionalEmails` | string[] | no | ≤ 5. |
| `phone` | string or null | no | ≤ 40. The person's own line, never the firm's switchboard (that goes only in `firm.phone`). E.164 preferred. Any format accepted; the region is taken from `country`, defaulting to US. |
| `phoneType` | `"direct"`, `"mobile"`, `"office"`, `"main"`, `"toll_free"` or `"unknown"` | no | Default `"unknown"`. |
| `phoneExtension` | string or null | no | Digits, ≤ 10. |
| `additionalPhones` | array of `{ "number": string, "type": phoneType }` | no | ≤ 5. |
| `linkedinUrl` | string or null | no | A person profile (`linkedin.com/in/...`). |
| `city` | string or null | no | ≤ 100. The contact's office city. |
| `state` | string or null | no | ≤ 100. Two-letter US state, or a region name. |
| `country` | string or null | no | ISO 3166-1 alpha-2. Default `"US"`. |
| `individualCrd` | string or null | no | FINRA individual CRD, digits. |
| `designations` | string[] | no | ≤ 20, each ≤ 20, e.g. `"CFP"`. |
| `productInterest` | string[] | no | Twenty `productInterest` values: `PHH`, `TOLLBOOTH`, `ACUBOOTH`, `GLYNAC`. |
| `tags` | string[] | no | ≤ 20, each ≤ 50. Kept in the sandbox only. |
| `notes` | string or null | no | ≤ 5000. Becomes the contact's first sandbox note. A longer one is cut at a word, with a warning. |
| `bellwetherUrl` | string or null | no | HTTPS link to the contact in Bellwether. |
| `source` | string or null | no | ≤ 200. Where Bellwether found the person, e.g. `"SEC IAPD"` or `"firm website"`. |
| `collectedAt` | string (date) or null | no | When Bellwether collected the data. |
| `doNotContact` | boolean | no | Default `false`. `true` (also `"true"`, `"yes"` or `1`) means the contact is rejected (`do_not_contact`). |
| `firm` | object | yes | The contact's firm. |
| `firm.name` | string | yes | 1 to 200 characters. |
| `firm.crd` | string or null | no | SEC/FINRA firm CRD, digits. |
| `firm.website` | string or null | no | URL. |
| `firm.domain` | string or null | no | Bare domain. Derived from `website` when absent. |
| `firm.city`, `firm.state`, `firm.country` | string or null | no | Main office. Same formats as the contact's. |
| `firm.phone` | string or null | no | Main office line (the switchboard). Kept for reference; never used to match. A contact phone equal to it is kept as the firm's line (type `main`), with a warning. |
| `firm.aumUsd` | integer or null | no | Regulatory AUM, whole US dollars, at most 22 digits. |
| `firm.employees` | integer or null | no | 0 to 2,147,483,647. |

**Validation.**
- Envelope problems are refused for the whole request with 422. Those are: no `Idempotency-Key`,
  no `pushedBy.email`, `contacts` missing or empty, an `assignTo` with no email.
- More than 500 contacts gets 413.
- A contact with a missing or invalid **required** field is `rejected` / `invalid_field`, with the
  field named in `detail` ("lastName is empty", "firm.name is longer than 200 characters"). The rest
  of the batch is still processed.
- An invalid **optional** field is dropped with a warning, and the contact is still created. This
  covers a bad email, phone or LinkedIn URL, and an unknown product value. Nothing is dropped or
  changed silently: a value over its limit, a country or option Cadence does not know (it then
  uses the default), or a number out of range carries `value_defaulted`, and a cut note
  `note_truncated` (1.1).
- Options (`emailVerification`, `phoneType`) are read in any case. Control characters are removed
  from every text.

### 14.5 Normalisation (Cadence applies it; Bellwether should apply the same before sending)

| Value | Rule |
|---|---|
| email | Trim, lower-case the whole address, drop a leading `mailto:` and a trailing dot. Dots and `+tags` are kept. The domain needs a top level of two letters or more. |
| phone | Parse to E.164 with the region from `country` (default US). The extension is split off. A North American number has 10 digits, or 11 with the leading 1; any other count is a typo and is dropped, never read as a foreign number. A `(0)` after the country code (`+44 (0)20 ...`) is dropped. |
| linkedinUrl | Percent-decode the slug, then lower-case. Remove the scheme, `www.` or a country subdomain, the query, the fragment and a trailing slash, giving `linkedin.com/in/<slug>`. Anything that is not `/in/` is dropped. |
| country | ISO 3166-1 alpha-2. `UK` is `GB`; an English country name or a common alias (`United Kingdom`, `USA`) is its code. |
| CRDs | Digits only, leading zeros removed. |
| domain | Lower-case. Remove the scheme, `www.` and any path. |
| firm name (compared) | Lower-case, letters of every alphabet kept, punctuation and legal suffixes (LLC, Inc., Ltd, Corp, LP) removed. |
| names, notes, titles | Plain text: HTML tags go, a markdown link keeps its words and an `https` address, any other address is dropped. Names lose brackets too. |

### 14.6 Dedupe rules (in this order; the first hit decides)

Before rule 4 is judged, Twenty itself is asked once per push (3 Nov): the people it has for the
pushed emails, phones and LinkedIn URLs go into Cadence's copy, and a copy hit Twenty no longer
has is marked deleted. When Twenty cannot be reached, the copy decides on its own.

1. **Within the request.** A second contact with the same `bellwetherContactId` is `rejected` /
   `duplicate_in_request`. So is a contact whose personal email another contact of the request
   keeps: the one whose firm's domain is the address's domain keeps it, else the first; `detail`
   names who has it. A shared inbox (`info@`, `sales@`, `office@` and the like) belongs to nobody
   and never makes a duplicate.
2. **Suppression.** Any key of the contact is on Cadence's suppression list: an email, **any phone
   whatever its type** (a firm's office, main or unknown line is suppressed for the one person it
   was suppressed for, never their colleagues), the LinkedIn URL, the `bellwetherContactId` or the
   individual CRD. So is a personal email, the CRD, the LinkedIn URL or a direct or mobile phone of a
   contact who asked not to be contacted. And a CRM person with the same first and last name at the
   same firm (by name, domain or CRD) who is marked Do not contact in the CRM or opted out in Cadence.
   Each is `rejected` / `suppressed`, and the status reads `opted_out`.
3. **Internal or blocked.** The email or firm domain is one of Acumen's own domains, or the firm
   name is one of its own (compared without legal suffixes): `rejected` / `internal_contact`. The
   firm is a blocked account or on the "Never prospects" list in Cadence (by domain or normalised
   name): `rejected` / `blocked_account`.
4. **CRM.** A live Twenty person in Cadence's copy (not deleted, not a team member) has the same
   email (primary or additional, in any case), the same LinkedIn URL, or the same phone (primary or
   additional). A pushed phone (`phone`, or an entry of `additionalPhones`, each judged by its own
   type) matches when its type is `direct` or `mobile`, and also when it is `office` or
   `unknown`, unless the number equals `firm.phone` or the main line of the matching person's
   company in Twenty. A phone typed `main` or `toll_free` never matches. Result
   `already_in_crm`, with `matchedOn` and `crmPersonId`. This includes contacts moved from the
   sandbox earlier; a contact moved to that very person keeps reading `moved_to_crm`.
5. **Sandbox.** An ACTIVE sandbox contact has the same `bellwetherContactId`, `individualCrd`,
   personal email, LinkedIn URL, or `direct`/`mobile` phone. Result `duplicate_in_sandbox`. Empty
   fields on the existing contact are filled from the push, and nothing is ever overwritten. When
   the push has the person at another firm, only their own details fill (emails, direct and mobile
   phones, LinkedIn, CRD), never the new firm's title, office line or address. The filled fields are
   listed in `filledFields`. The owner does not change. A note is added to the contact (an identical
   one is not added twice; `note_added`, 1.1). A different email, or a direct or mobile phone the
   contact does not have, is added to its extra emails and phones, and a new firm or title is only
   reported: the owner reads them in a note on the contact (`details_changed`, 1.1).
6. Otherwise the result is **`created`**. A sandbox contact REMOVED by retention does not block a
   new one.

Outside rules 2 and 4, phones typed `office`, `main`, `toll_free` or `unknown`, and `firm.phone`,
never match: they are shared lines. In rule 4, `main`, `toll_free` and `firm.phone` never match.
Name and firm alone never match. When Twenty has a person with the same first and last name at a
company with the same domain or CRD, the contact is still created and carries the warning
`possible_crm_match` with that person's id. When an active contact in Cadence has the same last
name at the same firm, or shares an office or unknown line, the contact is still created and
carries `possible_sandbox_duplicate` naming them (1.1).

### 14.7 Ownership on push

1. The owner is `assignTo` if given, else `pushedBy`. Cadence matches the user by
   `microsoftObjectId`, then email, then alias.
2. If that user is an active Junior FO, Senior FO, Sales Leader or Pod Manager in at least one
   pod, they own the new contacts. Otherwise (unknown, inactive, an admin, Biz Ops, in no pod) no
   contact is created unclaimed: each contact the push would create is `rejected` with reason
   `owner_not_found` (whether the owner came from `assignTo` or `pushedBy`), its `detail` saying who
   and why, and `owner` is null in the response. The owner is checked when the push or check
   arrives, so a list Bellwether read earlier, or a request it queued and sends later, never names
   an owner who has since left (agreed owner contract, 13 Nov 2026; audit U01, U02, U03).
   `POST /contacts/check` answers the same way before any send. `GET /owners` (14.16) lists exactly
   the people who can own.
   A contact already in Cold outreach (`duplicate_in_sandbox`) or in the CRM (`already_in_crm`)
   keeps its own owner rules: the push never changes its owner, and `ownerEmail` says who owns it
   (U05).
3. The pod is `pod` if the owner works that pod (by its value or its name, in any case), else the
   owner's only pod, else the first of their pods by name. A contact with an owner always has a pod.
4. A push is not a claim: the funnel's "Claimed" counts a later claim or assignment only.

### 14.8 Push response

HTTP 200 whenever the envelope was valid, even if every contact was rejected:

```json
{
  "pushId": "6f1c2a9e-1b7d-4c1e-9a55-2f0f1d3c8b10",
  "replayed": false,
  "receivedAt": "2026-11-03T15:04:05Z",
  "owner": { "email": "alyssa@acumen-strategy.com", "name": "Alyssa Example" },
  "summary": { "created": 1, "duplicate_in_sandbox": 1, "already_in_crm": 1, "rejected": 1 },
  "results": [
    { "bellwetherContactId": "105943:i:7712001", "result": "created",
      "cadenceContactId": "0b6a...", "reason": null, "detail": null, "matchedOn": null,
      "crmPersonId": null, "crmUrl": null,
      "ownerEmail": "alyssa@acumen-strategy.com", "ownerName": "Alyssa Example",
      "filledFields": [], "warnings": [] },
    { "bellwetherContactId": "105943:i:7712002", "result": "duplicate_in_sandbox",
      "cadenceContactId": "5d21...", "reason": null, "detail": null, "matchedOn": "email",
      "crmPersonId": null, "crmUrl": null,
      "ownerEmail": "leigh@acumen-strategy.com", "ownerName": "Leigh Example",
      "filledFields": ["linkedinUrl"], "warnings": [] },
    { "bellwetherContactId": "288810:n:jane doe", "result": "already_in_crm",
      "cadenceContactId": null, "reason": null, "detail": null, "matchedOn": "linkedin_url",
      "crmPersonId": "8e0f...", "crmUrl": "https://<twenty-host>/object/person/8e0f...",
      "ownerEmail": "andrew@acumen-strategy.com", "ownerName": "Andrew Example",
      "filledFields": [], "warnings": [] },
    { "bellwetherContactId": "288810:n:", "result": "rejected",
      "cadenceContactId": null, "reason": "invalid_field", "detail": "lastName is empty",
      "matchedOn": null, "crmPersonId": null, "crmUrl": null,
      "ownerEmail": null, "ownerName": null, "filledFields": [], "warnings": [] }
  ]
}
```

**(1.1)** The same push read with `X-Cadence-Contract: 1.1` carries `cadenceUrl` on each result and
the 1.1 warning codes:

```json
{
  "pushId": "6f1c2a9e-1b7d-4c1e-9a55-2f0f1d3c8b10",
  "replayed": false,
  "receivedAt": "2026-11-10T15:04:05Z",
  "owner": { "email": "alyssa@acumen-strategy.com", "name": "Alyssa Example" },
  "summary": { "created": 1, "duplicate_in_sandbox": 1, "already_in_crm": 0, "rejected": 1 },
  "results": [
    { "bellwetherContactId": "105943:i:7712003", "result": "created",
      "cadenceContactId": "7c40...", "reason": null, "detail": null, "matchedOn": null,
      "crmPersonId": null, "crmUrl": null,
      "ownerEmail": "alyssa@acumen-strategy.com", "ownerName": "Alyssa Example",
      "filledFields": [],
      "warnings": [{ "code": "possible_sandbox_duplicate", "field": null, "crmPersonId": null,
                     "detail": "Possibly the same person as Bob Okafor, already in Cold outreach at the same firm." }],
      "cadenceUrl": "https://cadence.pmx.acumen-strategy.com/cold-outreach/7c40..." },
    { "bellwetherContactId": "105943:i:7712002", "result": "duplicate_in_sandbox",
      "cadenceContactId": "5d21...", "reason": null, "detail": null, "matchedOn": "individual_crd",
      "crmPersonId": null, "crmUrl": null,
      "ownerEmail": "leigh@acumen-strategy.com", "ownerName": "Leigh Example",
      "filledFields": ["linkedinUrl"],
      "warnings": [{ "code": "note_added", "field": "notes", "crmPersonId": null,
                     "detail": "The person is already in Cold outreach, so the note was added to that contact." },
                   { "code": "details_changed", "field": null, "crmPersonId": null,
                     "detail": "Newer details from Bellwether: email jane@northstarwealth.com added; their firm there is Northstar Wealth." }],
      "cadenceUrl": "https://cadence.pmx.acumen-strategy.com/cold-outreach/5d21..." },
    { "bellwetherContactId": "288810:n:john roe", "result": "rejected",
      "cadenceContactId": null, "reason": "internal_error",
      "detail": "Cadence hit an error on this contact and finished the rest. Send it again; if it happens again, report it.",
      "matchedOn": null, "crmPersonId": null, "crmUrl": null,
      "ownerEmail": null, "ownerName": null, "filledFields": [], "warnings": [], "cadenceUrl": null }
  ]
}
```

`results` are in request order, one per contact. Each result:

| Field | Type | Meaning |
|---|---|---|
| `bellwetherContactId` | string | As sent (without control characters). |
| `result` | `"created"`, `"duplicate_in_sandbox"`, `"already_in_crm"` or `"rejected"` | |
| `cadenceContactId` | string (UUID) or null | The sandbox contact, for `created` and `duplicate_in_sandbox`. |
| `reason` | string or null | `rejected` only: `invalid_field`, `do_not_contact`, `suppressed`, `blocked_account`, `internal_contact`, `duplicate_in_request`, `owner_not_found` (nobody who can own contacts was named: 14.7), or `internal_error` (Cadence failed on this one contact and finished the rest; it may be sent again, and it is never kept as a refusal). `internal_error` reaches every caller. |
| `detail` | string or null | One plain sentence for a person to read. |
| `matchedOn` | `"bellwether_contact_id"`, `"individual_crd"`, `"email"`, `"linkedin_url"`, `"phone"` or null | Set for `duplicate_in_sandbox` and `already_in_crm`. |
| `crmPersonId` | string or null | `already_in_crm`: the Twenty person id. |
| `crmUrl` | string or null | `already_in_crm`: the person in Twenty. |
| `ownerEmail`, `ownerName` | string or null | The sandbox owner (`created`, `duplicate_in_sandbox`; null when the owner no longer has access), or the Twenty Assigned To (`already_in_crm`). |
| `filledFields` | string[] | `duplicate_in_sandbox`: payload field names written into empty fields. Otherwise `[]`. |
| `warnings` | array of `{ "code": string, "field": string or null, "crmPersonId": string or null, "detail": string }` | v1 codes: `email_dropped`, `phone_dropped`, `linkedin_dropped`, `product_dropped`, `pod_ignored`, `possible_crm_match`. (1.1) also: `owner_not_found`, `assign_to_not_found`, `note_added`, `details_changed`, `note_truncated`, `value_defaulted`, `no_reach` (no usable email, phone or LinkedIn is left), `possible_sandbox_duplicate`. A v1 caller gets only the v1 codes. |
| `cadenceUrl` | string or null | (1.1) The contact's page in Cadence, for `created` and `duplicate_in_sandbox`. |

### 14.9 Errors

Body: `{ "error": { "code": string, "message": string, "fields": [ { "path": string, "problem": string } ] } }`
(`fields` is present only for 422).

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_json` | The body is not JSON. |
| 401 | `unauthorized` | The key is missing or wrong. |
| 409 | `idempotency_conflict` | The same `Idempotency-Key` was used with a different body. |
| 409 | `idempotency_in_progress` | The same key is still being processed. Has `Retry-After: 5`. |
| 413 | `payload_too_large` | More than 500 contacts, more than 500 status ids, or a body over 2 MB. |
| 415 | `unsupported_media_type` | Not JSON. |
| 422 | `invalid_request` | Envelope validation (14.4). |
| 429 | `rate_limited` | Over the limit. Has `Retry-After` in seconds. |
| 503 | `integration_disabled` | The key is not configured in Cadence, or the sandbox is switched off. |
| 503 | `unavailable` | Cadence's database cannot be reached. Retry later. Nothing else is a 503: one contact Cadence fails on is that contact's `internal_error`, and the push still finishes. |
| 500 | `internal` | A bug. Retry once with the same key, then stop and report. |

### 14.10 Idempotency

- Every push request carries an `Idempotency-Key` (UUID v4). One user action gets one key. When
  Bellwether splits a large selection into several requests, each request gets its own key. Cadence
  compares the key in lower case.
- Cadence keeps the key, a SHA-256 of the raw body and the response for **7 days**.
  - Same key and same body: Cadence replays the stored response with `"replayed": true`, in the
    contract version the replay asked for.
  - Same key and a different body: 409 `idempotency_conflict`.
- After a timeout, a 5xx or a 429, Bellwether retries with the **same** key and body. The backoff
  is 5 s, 30 s, then 2 min, at most 3 retries, and Bellwether honours `Retry-After`.
- A push that stopped part-way (Cadence restarted, its database went away) is marked failed after
  10 minutes; a retry with its key runs it again, and what it created already is then
  `duplicate_in_sandbox`.
- Apart from the key, the dedupe rules alone mean a contact pushed again never makes a second
  sandbox contact.

### 14.11 Limits and timing

- 500 contacts per push. 500 ids per status request. 2 MB body.
- 30 push requests and 60 status requests per minute per key. Check (14.14) and suppress (14.15)
  requests count as push requests; owners (14.16) requests count as status requests.
- Cadence answers a 500-contact push within 30 seconds. Bellwether's client timeout is 60
  seconds.

### 14.12 Status endpoint

`POST /api/integrations/bellwether/v1/contacts/status`. The body is exactly one of:
- `{ "bellwetherContactIds": ["105943:i:7712001", "..."] }`, with 1 to 500 ids. The results come
  back in request order, and an id Cadence never received is `not_found`.
- `{ "changedSince": "2026-11-03T00:00:00Z", "cursor": null, "limit": 500 }`. This returns every
  contact ever pushed from Bellwether whose status changed at or after `changedSince`, oldest
  change first, up to `limit` (≤ 500). Follow `nextCursor` until it is null. Bellwether polls this
  way every 10 minutes, starting 15 minutes before the last `serverTime` it was given, and by id
  when a user opens a contact.

`statusChangedAt` and `serverTime` come from Cadence's database clock. `statusChangedAt` moves when
the status changes and also when the owner changes (claim, assignment, release, the owner losing
access), when a call outcome is filed, when an email bounces and when an opt-out is lifted, so a
read of changes carries each of them.

Response 200:
```json
{
  "serverTime": "2026-11-03T15:10:00Z",
  "nextCursor": null,
  "results": [
    { "bellwetherContactId": "105943:i:7712001", "status": "moved_to_crm",
      "cadenceContactId": "0b6a...", "ownerEmail": "alyssa@acumen-strategy.com", "ownerName": "Alyssa Example",
      "campaignName": null, "callCount": 3, "lastActivityAt": "2026-11-10T16:22:00Z",
      "movedToCrmAt": "2026-11-12T14:00:00Z", "crmPersonId": "a91c...",
      "crmUrl": "https://<twenty-host>/object/person/a91c...", "statusChangedAt": "2026-11-12T14:00:00Z" }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `status` | `"in_sandbox"`, `"moved_to_crm"`, `"already_in_crm"`, `"opted_out"`, `"removed"`, `"not_found"`, or (1.1) `"refused"` | `in_sandbox`: active in Cadence, claimed or not. `moved_to_crm`: a Cadence user moved it (an undo makes it `in_sandbox` again). `already_in_crm`: the push was refused because the person was already in the CRM. `opted_out`: asked not to be contacted; Bellwether should block further pushes. `removed`: removed in Cadence or by retention; may be pushed again. `not_found`: Cadence never received it. `refused` (1.1): the push was refused for another reason, in `reason`; a v1 caller never sees it (such an id reads as it would without the refusal). |
| `cadenceContactId` | string or null | |
| `ownerEmail`, `ownerName` | string or null | The sandbox owner, null when unclaimed or when the owner no longer has access. For `moved_to_crm` and `already_in_crm`, the Twenty Assigned To. |
| `campaignName` | string or null | The sandbox campaign the contact is in now. |
| `callCount` | integer | Calls logged in Cadence for this contact. |
| `lastActivityAt` | string or null | |
| `movedToCrmAt` | string or null | |
| `crmPersonId`, `crmUrl` | string or null | Set for `moved_to_crm` and `already_in_crm`. |
| `statusChangedAt` | string | When the row last changed (above). |

**(1.1)** Each row also carries these fields, always present and null when they do not apply:

| Field | Type | Meaning |
|---|---|---|
| `cadenceUrl` | string or null | The contact's page in Cadence. |
| `removedBy`, `removedAt`, `removedReason` | string or null | `removed`: the name of who removed it (null for retention), when, and the reason they gave (retention gives its own). |
| `erasedAt` | string or null | An admin erased the person; comes with `opted_out`. Bellwether blanks the person's emails and phones and keeps the public SEC record. |
| `emailBounced`, `emailBouncedAt` | string or null | The address that bounced in Cadence, and when. Bellwether marks that address invalid. |
| `possibleCrmPersonId` | string or null | A CRM person the push thought might be this contact. |
| `lastOutcome`, `lastOutcomeAt` | string or null | The latest post-call outcome and when it was filed: the form's outcome key, one of `connected`, `gatekeeper`, `voicemail`, `no_answer`, `busy`, `wrong_number`, `not_interested`, `meeting_booked`, `do_not_contact`, `no_conversation`, or a key an admin added in Settings, Rules. |
| `optOutLiftedAt` | string or null | When Cadence last lifted an opt-out of this contact (only an opt-out from the post-call form can be lifted), sent once the status is no longer `opted_out`. Bellwether then lifts only the suppression that opt-out wrote there. A Cadence lift never removes a Do not contact set in Bellwether, and a Bellwether lift never lifts a Cadence opt-out. |
| `reason` | string or null | `refused`: the push's reason (`invalid_field`, `do_not_contact`, `blocked_account`, `internal_contact`, `duplicate_in_request`, `owner_not_found`). |

```json
{
  "serverTime": "2026-11-10T16:30:00Z",
  "nextCursor": null,
  "results": [
    { "bellwetherContactId": "105943:i:7712001", "status": "in_sandbox",
      "cadenceContactId": "0b6a...", "ownerEmail": "alyssa@acumen-strategy.com", "ownerName": "Alyssa Example",
      "campaignName": null, "callCount": 1, "lastActivityAt": "2026-11-10T16:22:00Z",
      "movedToCrmAt": null, "crmPersonId": null, "crmUrl": null, "statusChangedAt": "2026-11-10T16:22:00Z",
      "cadenceUrl": "https://cadence.pmx.acumen-strategy.com/cold-outreach/0b6a...",
      "removedBy": null, "removedAt": null, "removedReason": null, "erasedAt": null,
      "emailBounced": "jane.doe@northstarwealth.com", "emailBouncedAt": "2026-11-10T09:00:00Z",
      "possibleCrmPersonId": null, "lastOutcome": "not_interested", "lastOutcomeAt": "2026-11-10T16:22:00Z",
      "optOutLiftedAt": "2026-11-09T12:00:00Z", "reason": null },
    { "bellwetherContactId": "105943:i:7712002", "status": "removed",
      "cadenceContactId": "5d21...", "ownerEmail": "alyssa@acumen-strategy.com", "ownerName": "Alyssa Example",
      "campaignName": null, "callCount": 1, "lastActivityAt": "2026-11-10T16:22:00Z",
      "movedToCrmAt": null, "crmPersonId": null, "crmUrl": null, "statusChangedAt": "2026-11-10T15:00:00Z",
      "cadenceUrl": "https://cadence.pmx.acumen-strategy.com/cold-outreach/5d21...",
      "removedBy": "Alisa Example", "removedAt": "2026-11-10T15:00:00Z", "removedReason": "Retired", "erasedAt": null,
      "emailBounced": null, "emailBouncedAt": null,
      "possibleCrmPersonId": null, "lastOutcome": "not_interested", "lastOutcomeAt": "2026-11-10T14:40:00Z",
      "optOutLiftedAt": null, "reason": null },
    { "bellwetherContactId": "288810:n:jane doe", "status": "refused",
      "cadenceContactId": null, "ownerEmail": null, "ownerName": null,
      "campaignName": null, "callCount": 0, "lastActivityAt": null,
      "movedToCrmAt": null, "crmPersonId": null, "crmUrl": null, "statusChangedAt": "2026-11-10T14:00:00Z",
      "cadenceUrl": null, "removedBy": null, "removedAt": null, "removedReason": null, "erasedAt": null,
      "emailBounced": null, "emailBouncedAt": null, "possibleCrmPersonId": null,
      "lastOutcome": null, "lastOutcomeAt": null, "optOutLiftedAt": null, "reason": "blocked_account" },
    { "bellwetherContactId": "288810:n:john roe", "status": "opted_out",
      "cadenceContactId": "9c3e...", "ownerEmail": "alyssa@acumen-strategy.com", "ownerName": "Alyssa Example",
      "campaignName": null, "callCount": 1, "lastActivityAt": "2026-11-10T16:22:00Z",
      "movedToCrmAt": null, "crmPersonId": null, "crmUrl": null, "statusChangedAt": "2026-11-10T13:00:00Z",
      "cadenceUrl": "https://cadence.pmx.acumen-strategy.com/cold-outreach/9c3e...",
      "removedBy": null, "removedAt": null, "removedReason": null, "erasedAt": "2026-11-10T13:00:00Z",
      "emailBounced": null, "emailBouncedAt": null,
      "possibleCrmPersonId": null, "lastOutcome": "connected", "lastOutcomeAt": "2026-11-09T10:00:00Z",
      "optOutLiftedAt": null, "reason": null }
  ]
}
```

### 14.13 Field mapping, Bellwether to sandbox

The source column is a suggestion from Bellwether's tables. Bellwether's plan is authoritative for
that column.

| Payload field | Sandbox column | Suggested Bellwether source |
|---|---|---|
| `bellwetherContactId` | `bellwetherContactId` | `<crd>:<person_key>` from `contact_point` / `person` |
| `firstName`, `lastName` | `firstName`, `lastName` | `person.first_name` / `last_name`, or a split of `contact_point.person_name` |
| `jobTitle` | `jobTitle` | `contact_point.title` / `contact.title` |
| `email`, `emailVerification` | `email`, `emailVerification` | `contact_point` kind `email`, `verify_status` |
| `additionalEmails` | `additionalEmails` | other usable email `contact_point`s |
| `phone`, `phoneType`, `phoneExtension` | `phone`, `phoneType`, `phoneExtension` | `contact_point` kind `phone`, `label` |
| `additionalPhones` | `additionalPhones` | other phone `contact_point`s |
| `linkedinUrl` | `linkedinUrl` | `contact_point` kind `linkedin` |
| `city`, `state`, `country` | `city`, `state`, `country` | `person_employment` (current) `city`, `state` |
| `individualCrd` | `individualCrd` | `person.indvl_pk` |
| `designations` | `designations` | `person.designations` |
| `productInterest` | `productInterest` | Bellwether product families mapped to Twenty values |
| `tags` | `tags` | Bellwether list names |
| `notes` | first `SandboxNote` | |
| `bellwetherUrl` | `bellwetherUrl` | |
| `source` | `sourceNote` | `contact_point.source` |
| `collectedAt` | `collectedAt` | `contact_point.found_at` |
| `firm.name` | `companyName` | `firm.business_name`, else `legal_name` |
| `firm.crd` | `companyCrd` | `firm.crd` |
| `firm.website`, `firm.domain` | `companyWebsite`, `companyDomain` | `firm.website` |
| `firm.city`, `firm.state`, `firm.country` | `companyCity`, `companyState`, `companyCountry` | `firm.city`, `state`, `country` |
| `firm.phone` | `companyPhone` | `firm.phone` |
| `firm.aumUsd` | `companyAumUsd` | `firm.raum` |
| `firm.employees` | `companyEmployees` | `firm.total_employees` |
| `pushedBy.email` | `pushedByEmail` | `app_user.email` |
| `pushedBy.microsoftObjectId` | (owner match) | `app_user.ms_oid` |
| `pod` | `podId` (the owner's pod) | the owner's pods from `GET /owners` |

Sandbox to Twenty is section 8.2.

### 14.14 Check before push

`POST /api/integrations/bellwether/v1/contacts/check`. Headers: `X-Cadence-Api-Key` only. There
is no `Idempotency-Key`; one that is sent is ignored.

- The body is the same as a push (14.4) and is validated the same way: the same 400, 413, 415 and
  422 answers, and the same per-contact `rejected` / `invalid_field` results.
- Cadence runs exactly the push's steps (14.5 to 14.7) at that moment, Twenty's own answer included,
  inside a transaction it then rolls back, and so **writes nothing**: no sandbox contact, no filled
  field, no note, no refusal, no change to its copy of the CRM, no idempotency record, no push
  record. Two contacts of one check that are the same person answer as they would in the push.
- Response 200 has the push response's shape (14.8), with `"pushId": null` and
  `"replayed": false`. Each result is the one the push would give now. `created` means "would be
  created", and its `cadenceContactId` is null; so is that of a contact the check matches to one it
  would create. `filledFields` on a `duplicate_in_sandbox` lists the fields a push would fill.
- It counts against the push rate limit (30 requests a minute per key, 14.11). The 500-contact and
  2 MB limits apply.
- Errors are as in 14.9; `idempotency_conflict` and `idempotency_in_progress` never occur.
- Bellwether calls it for the push preview and blocks every contact whose result is
  `already_in_crm` (the email or phone matched a CRM contact; `matchedOn` says which). The push
  itself still returns `already_in_crm` if the CRM changed in between.

### 14.15 Do not contact from Bellwether (1.1)

`POST /api/integrations/bellwether/v1/contacts/suppress`. A Do not contact set in Bellwether on a
person it has sent opts them out in Cadence: the cold contacts the id answers for, live ones with
the same personal email or individual CRD, moved contacts (through their CRM person) and CRM
people with the same email, the CRM's own Do not contact included. Its keys go on the suppression
list either way, so a later push of the person is refused; a phone protects only the people it
matched, never a colleague on the same line.

Request (1 to 500 contacts; each needs its `bellwetherContactId`, else 422 with
`contacts[i].bellwetherContactId`; `reason` is `opted_out`, `do_not_call`, `do_not_email` or
`other`; `actor` is required):
```json
{
  "contacts": [
    { "bellwetherContactId": "105943:i:7712001", "emails": ["jane.doe@northstarwealth.com"], "phones": ["+12125550142"], "individualCrd": "7712001" }
  ],
  "reason": "opted_out",
  "note": "Asked on a call",
  "actor": { "email": "karson@acumen-strategy.com", "name": "Karson Example" }
}
```

Response 200, one result per contact in request order: `opted_out` (something was opted out
now), `already_opted_out` (everything that matched was already), or `not_found` (Cadence has
nobody it covers). An id no cold contact answers for reads `opted_out` in the status from then on.
```json
{
  "results": [
    { "bellwetherContactId": "105943:i:7712001", "result": "opted_out", "cadenceContactId": "0b6a...", "crmPersonId": null }
  ]
}
```

A Do not contact set in Bellwether is marked on every record it reaches in Cadence, so lifting a
post-call-form opt-out in Cadence never takes it away. A 404 from a Cadence before 1.1 means the
person stays live there; Bellwether then shows "Still live in Cadence with <owner>".

### 14.16 Owners (1.1)

`GET /api/integrations/bellwether/v1/owners`. Who can own contacts pushed from Bellwether, by the
rules of 14.7 (active sales reps in at least one pod; never admins or Biz Ops), by name, each with
the pods they work as Bellwether sends them in `pod`. Bellwether's owner picker lists only these,
and asks for the pod when the owner has more than one.
```json
{
  "owners": [
    { "email": "alyssa@acumen-strategy.com", "name": "Alyssa Example", "pods": ["ALISA"] }
  ]
}
```

## 15. Credentials (names only)

New secrets go into the Nomad variable `nomad/jobs/cadence` and into **both** template blocks
(web and worker) of `nomad/cadence.hcl`. Locally they go in `.env`, and `.env.example` lists the
names with empty values. Never in the repository (it is public), docs, chat or memory.

| What | Env var | Where | Notes |
|---|---|---|---|
| Twilio account | `TWILIO_ACCOUNT_SID` | Cadence env | The account behind the hosted dialpad. |
| Twilio API key, read only | `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | Cadence env | A Restricted API key made for Cadence in the Twilio console, revocable on its own, with read permission only on Calls, Recordings (including media) and IncomingPhoneNumbers. Used as basic auth for the REST reads and the recording proxy. No auth token, TwiML App, caller ID or transcription service is needed. With any of the three unset, the import is off and Settings > Calling says so. |
| Twilio API host (tests only) | `TWILIO_API_URL` | test env | Points the client at a stand-in, like `MICROSOFT_GRAPH_URL`. Unset in production (defaults to `https://api.twilio.com`). |
| Fake Twilio (tests only) | `CADENCE_FAKE_TWILIO=1` | test env | Uses the in-memory fake (`src/lib/calls/fake-twilio.ts`) and enables its test-only seeding route. Refused when `NODE_ENV=production` unless `CADENCE_ALLOW_MOCK=true`, the way mock mode is guarded. |
| Bellwether key | `BELLWETHER_API_KEY`, `BELLWETHER_API_KEY_PREVIOUS` (rotation only) | Cadence env | Same value as Bellwether's `CADENCE_API_KEY`. Unset: every Bellwether call gets 503 `integration_disabled`. |
| Cadence for Bellwether | `CADENCE_API_URL`, `CADENCE_API_KEY` | Bellwether env | |
| Microsoft Graph mail switch | `GRAPH_MAIL_ENABLED` | Cadence env | `true` turns the `graphMail` job on. Unset or anything else: off. |
| Microsoft Graph mail app | existing `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_SECRET` (or Settings > Sign-in) | Entra ID | Add the application permission `Mail.Read` with admin consent, limited by an Exchange application access policy (or RBAC for Applications) to a mail-enabled security group of the sales mailboxes (section 12). No new secret. |
| Twenty | existing `TWENTY_API_KEY` | Nomad | The key's role must allow creating People, Companies and Notes, and deleting People and Companies (undo). Since 22 Oct this should be a key named for Cadence alone. `CADENCE_DRY_RUN=true` still stops every write. |
| Public URL | existing `APP_URL` | Nomad | Used in the links Cadence writes into Twenty notes. Nothing calls back into Cadence from Twilio. |

## 16. Build order (one pass)

Built in one pass on the local branch `outreach-sandbox`, from `main`. Nothing is pushed, merged
or deployed, and no production migration is run, until the whole pass has been reviewed. Every
outside service sits behind an adapter with a fake (Twenty: the existing mock client and dry-run
wrapper; Twilio: `fake-twilio.ts`; Graph: `fetchImpl`), so the app runs and every test passes with
no credentials at all.

1. **Schema and migration** (section 4). Make `personId` optional and fix every type error with
   `subjectOf()`. CRM behaviour must not change: the full existing suite passes unchanged.
2. **Foundations.** `env.ts`, the settings sections, `rbac.ts` helpers, `sandbox/normalize.ts`,
   `phoneE164` and its backfill, the suppression list and the one opt-out path.
3. **Sandbox contacts.** Model services, CRM-ready rules, the Contacts tab, the contact page,
   manual add, claim, assign and remove. Sidebar entry.
4. **Bellwether API**: the four routes (ping, push, check, status), auth with
   `BELLWETHER_API_KEY` and `BELLWETHER_API_KEY_PREVIOUS`, idempotency, limits, dedupe, ownership,
   status paging and the middleware prefix. Contract tests built from the JSON in section 14.
5. **Sandbox campaigns and next actions.** The audience switch in the studio and engine,
   `sync-out` skipping sandbox subjects, the Work tab, and the Campaigns tab.
6. **Twenty writes and Move to CRM.** Client methods (GraphQL, mock, dry run), firm resolution,
   the move queue (at most 50), history notes, undo for one year, the batch page, and the
   `twenty-schema.ts` optional fields.
7. **Twilio, read only.** The REST client and fake, `twilioImport`, rep matching by caller number
   and alias, contact matching, the Unmatched list, the recording proxy, the call intent behind the
   Call button, and calling hours.
8. **Post-call form.** The component, enforcement, `completeCall` from a form, the next step with
   its date, opt-out, and notes to Twenty for CRM people.
9. **Graph mail.** The permission row in Settings > Sign-in, the delta job behind
   `GRAPH_MAIL_ENABLED`, matching, step closing, replies and bounces.
10. **Compliance jobs.** Sandbox retention (including the personal data of moved contacts after
    the undo window), push-record retention, and erase.
11. **Reports**: Reports > Calls, the Sandbox section and the Platform totals.
12. **Settings**: the Calling and Sandbox tabs.
13. **Docs.** README.md, DECISIONS.md (one entry dated 2026-11-03), DEPLOY.md (each new env var
    and where it is set), `.env.example`, and this plan.
14. **Verification.** `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` and the new
    Playwright spec, all green. `pnpm screens`, the critics, a live walk with dry run on and a
    pilot with one pod follow the review, after a deploy that this pass does not do.

## 17. Test plan

**Unit and integration** (Vitest on the embedded Postgres, mock Twenty, fake Twilio, no network):
- `sandbox-crm-cleanup.test.ts`: each rule of 8.9 on its own: removed when untouched (email,
  calendar, additional emails on either side), kept and flagged when edited, with a note, task or
  opportunity, in a campaign, an enrollment or a move; never MANUAL, IMPORT, API or Cadence; not
  when created before the contact or matching a MOVED one; the switch; dry run; dedupe afterwards.
- `sandbox-normalize.test.ts`: emails, phones in every format with extensions, LinkedIn variants,
  CRDs, domains.
- `bellwether-api.test.ts`:
  - auth (missing, wrong, previous key accepted, unset gives 503);
  - every envelope 422; 413 at 501 contacts;
  - per-contact rejection for each reason;
  - the dedupe rules of 14.6, each on its own: within the request, suppression, internal and
    blocked, CRM by email, by LinkedIn and by phone (direct and mobile match; office and unknown
    match unless the number is `firm.phone` or the company's main line; main and toll-free never
    match), sandbox by each field, and created;
  - `filledFields`; ownership rules (14.7);
  - idempotent replay and conflict, and in-progress;
  - limits: rate limit with `Retry-After`, the check counting against the push limit;
  - the check endpoint: same results as the push that follows it, nothing written, `created`
    with a null `cadenceContactId`;
  - status by ids and by `changedSince`, paging with `nextCursor` until null.
- `sandbox-move.test.ts`:
  - create with a company linked by domain or name, and created when none matches;
  - the mapping written to the mock (Assigned To, Pod Owner, lead source and the rest);
  - history notes as Twenty notes; pointers moved; `PersonCache` filled at once; dry run writes
    nothing and leaves the contact in the sandbox;
  - 50 accepted and 51 refused;
  - undo within the year restores the contact; undo after one year is refused.
- `call-form.test.ts`:
  - the required fields per outcome;
  - the next step with its date: the date is required for every step except No further action,
    defaults to 2 working days on, and is refused in the past;
  - the next action created or moved for both kinds of contact;
  - the CRM note written once.
- `opt-out.test.ts`: the call form's "Asked not to be contacted", the contact page's Opt out and a
  suppression-list entry each set the pushed contact to `opted_out` with `statusChangedAt`, visible
  in the status endpoint by id and through `changedSince`.
- `calls-import.test.ts`, with the fake Twilio: paging from the watermark minus 10 minutes, the rep
  matched by caller number and by `tw_` alias, the browser leg folded into the network leg, the
  contact matched (sandbox and CRM), the recording read, the pending form for the matched rep, an
  unmatched call left without a form, a second run not duplicating, the intent linking the task.
- `sandbox-normalize.test.ts` also covers calling hours: the local-time window by state and area
  code, blocked and warned.
- The existing suite passes unchanged.

**Browser** (Playwright, the built-in fake CRM, `CADENCE_FAKE_TWILIO=1`):
- `e2e/outreach-sandbox.spec.ts`: a fake Bellwether pushes a contact through the API, and it shows
  in the sandbox with its owner; a fake Twilio call to the contact's number is imported; the
  post-call form is required (Call is disabled, the pending bar names the call) and is submitted;
  the contact is moved to the CRM and shows in People; the move is undone and the contact is back
  in the sandbox.

## 18. Risks

| Risk | Mitigation |
|---|---|
| Move to CRM creates duplicate people. The 22 Oct flood of copies came from another API key, but Cadence has never created a person before. | A live lookup before every create, `cadenceSandboxId` when the field exists, the twentyPersonId stored immediately, at most 50 per move, dry run honoured, an audit row per item, and undo for a year. |
| Twenty creates contacts from synced mail or calendars and bypasses Move to CRM. | Auto-creation stays on; the sandbox CRM cleanup (8.9) soft-deletes those people every 5 minutes when nobody worked them, and flags the rest on the sandbox contact (decision 11). |
| Optional `personId` touches the campaign engine everywhere. | The compiler lists every site. The existing unit and browser tests must pass unchanged. |
| The existing dialpad and its Twilio numbers break. | Cadence changes nothing in Twilio and nothing in the dialpad. Its key is read only. |
| The import misses a call or links it to the wrong rep. | A 10-minute overlap on every run, a re-read of unfinished calls, unique call SIDs, rep matching by the admin-confirmed caller number before the alias, and an Unmatched list for a person to decide. |
| The post-call form arrives late because calls are read every 2 minutes. | The pending bar appears on the next page load after the import; the form never blocks anything but Cadence's next Call. |
| Do Not Call, GDPR. | The suppression list, calling hours on Cadence's button, retention and erase. No counsel step (decision 14). |
| The Graph permission reads every mailbox in the tenant. | An Exchange application access policy (or RBAC for Applications) limits it to the sales group. Only matching metadata is requested and stored. Off unless `GRAPH_MAIL_ENABLED=true`. |
| Bounce detection without the message body. | Match by conversation, then by subject. Ambiguous cases are flagged, not guessed. `badEmail` can be cleared. |
| Calls to shared office lines matched to the wrong person. | Only direct and mobile numbers auto-match a call. Ambiguous calls wait for a person to decide. |
| Reps resent a form after every call, or forms pile up. | Two fields for a call that did not connect. Pending forms block only the next call. The backlog is a number in Reports > Calls. |
| The contract drifts between the two apps. | A versioned path, additive-only changes, and Bellwether's plan copying section 14 byte for byte by script. |
| Load on the one-CPU host. | Small jobs: Graph delta every 2 minutes per mailbox when on, the Twilio import every 2 minutes reading only the last few minutes, moves paced to Twenty's rate limit. No new polling from the browser. |
| The public repository leaks a secret. | Names only in code and docs. Real values only in Nomad variables. CI runs on fakes and needs none. |

## 19. Decisions (2026-11-03)

Rahul answered the open questions on 3 November 2026 (`Tech Projects/rahul-decisions-2026-11-03.md`)
and gave the go-ahead. Questions 1 to 15 were Cadence's; 16 to 25 were Bellwether's, and the ones
that change Cadence are noted.

1. **Campaign engine: default.** Sandbox campaigns run on the existing engine and studio, with
   enrollments, tasks, next actions and touches able to point at a sandbox contact (section 7).
2. **Where sandbox work shows: changed.** What is in the sandbox stays in the sandbox. There is no
   "Sandbox" or "All" filter in Tasks, Today (Home), People or any other CRM view; sandbox work is
   worked in Sandbox > Work. Reports show sandbox numbers as their own section and also combined
   with the rest of the platform (section 11).
3. **Moved mid-campaign: default.** The sandbox sequence ends as `moved_to_crm`, the open next
   action carries into Twenty, and the rep can add the person to a CRM campaign.
4. **Twilio: changed.** Build on the existing hosted dialpad
   (`https://h00ks.acm.acumen-strategy.com/admin/dialpad`) and the reps' existing numbers. No new
   Twilio app, TwiML App, Voice SDK, numbers or Cadence voice webhooks. The dialpad's code is in
   neither repository, so Cadence does not depend on changing it: Call buttons open the dialpad URL
   as today, and Cadence reads calls from Twilio's REST API with a read-only job every 2 minutes.
   Reps are matched by the caller number assigned to them in Twilio (IncomingPhoneNumbers, confirmed
   by an admin in Settings > Calling as `User.callerNumber`), then by the `tw_` alias (section 9).
5. **Recording and transcripts: changed.** Twilio already records. Cadence adds no recording or
   transcription and keeps no copy: it reads each call's recordings from Twilio and plays them
   through a signed-in proxy. No recording retention or deletion in Cadence.
6. **Post-call form: changed.** The default fields, except that the next step and the next call
   date are one field, the next step with its date. The date is required for every next step except
   No further action and defaults to 2 working days on (section 10).
7. **CRM-ready rules: default.** Moved contacts map to the CRM exactly like any other CRM contact
   (section 8.1, 8.2).
8. **Values written on a move: default.** The usual CRM values: lead source Bellwether (LEADGEN
   until the option exists), contact type Prospect, list category Cold BD, pipeline stage
   Prospect, tier empty.
9. **Firm not in Twenty: default.** Cadence creates the Company and leaves Account Owner empty.
10. **Moves: changed.** Up to 50 contacts per move, and a move can be undone for one year. The
    sandbox row keeps its data for that year so undo can restore it, then it is cleared.
11. **Twenty's contact auto-creation from mail: changed 3 Nov.** It stays on. Cadence removes the
    people it creates for sandbox contacts when nobody has worked them, and flags the others on
    the sandbox contact (section 8.9).
12. **Graph mail: read only, sales mailboxes only.** Application `Mail.Read`, limited by an
    Exchange Online application access policy (or RBAC for Applications) to a mail-enabled security
    group of the sales mailboxes. The exact admin steps are in section 12. Cadence never sends.
    Off unless `GRAPH_MAIL_ENABLED=true`.
13. **Retention: default.** Personal data cleared 180 days after the last activity, or 90 days
    after the push if never worked; a suppression hash is kept.
14. **Compliance: changed.** Calling hours 8:00 to 21:00 local stay, as a check on Cadence's own
    Call button only, because that needs no Twilio change. No recording announcement (it would need
    a Twilio change). No counsel sign-off step.
15. **Unclaimed contacts: default.** Everyone sees every sandbox contact, and the first rep to claim
    an unclaimed one owns it. Changed 13 Nov 2026 (agreed owner contract): a push whose owner
    cannot own contacts is refused contact by contact (`owner_not_found`), never created unclaimed.
16. **Who may push (Bellwether): changed.** Everyone can push; admins get no special permission or
    narrowing. Nothing changes in Cadence: the contract never checked the pusher's Bellwether role.
17. **Customer and Disqualified firms (Bellwether): default, plus a CRM check.** Before a push,
    Bellwether checks each contact's email and phone against the CRM and blocks it when either
    matches a CRM contact. For Cadence this means two additive contract changes: 14.6 rule 4 now
    also matches office and unknown phones (unless the number is the firm's main line), and the new
    check endpoint (14.14) gives the preview the push's results without writing anything.
18. **Default** (Bellwether side; see Bellwether's plan).
19. **Default** (Bellwether side).
20. **Default** (Bellwether side).
21. **Default** (Bellwether side).
22. **Default** (Bellwether side).
23. **Opt-out sync: default, plus.** A contact opted out in Cadence must show as opted out in
    Bellwether. Every opt-out path in Cadence (the call form's "Asked not to be contacted", the
    contact page's Opt out, the suppression list, erasure of an opted-out contact) sets the pushed
    contact's status to `opted_out` with `statusChangedAt`, which the status endpoint (14.12)
    already returns, by id and through `changedSince`.
24. **Default** (Bellwether side).
25. **ATS and Tollbooth (Bellwether): changed.** Bellwether sends neither the `list:ATS` tag nor
    `TOLLBOOTH`. Note only: `TOLLBOOTH` stays a valid `productInterest` value in Cadence, and
    nothing changes in the contract or in Cadence.

**Defaults taken during the build** (no question asked; written here so they can be changed):
- No new npm packages: a built-in phone parser (North American numbers and `+` international
  numbers) instead of `libphonenumber-js`.
- Ctrl+K search stays CRM only; the Sandbox section has its own search.
- A press of Call saves a `CallIntent` so the imported call links to its task.
- Twenty message participants are not used as a second source of sandbox email evidence in v1.
- Erase cannot delete recordings in Twilio (the key is read only); it lists their SIDs for an
  admin.
- Sandbox campaigns are started from the Contacts tab with a short form; the studio's calendar
  planner stays CRM only. No CSV import and no bulk "set next action" in this build.
- The Activity log shows sandbox steps with links to the Sandbox; its touch feed and counts stay CRM.
- A sandbox contact's reply rings its owner's bell, like a CRM reply.
- Calls made before the first Twilio import run are logged without a form, so the first day does
  not open a form for every call of the previous 24 hours.

**Changed by the cold outreach redesign (released together, November 2026).** The owner's answers of
5 November 2026 and the redesign plan (`Notes/cold-outreach-2026-11-04/PLAN.md`, `BUILD.md`) replace
these decisions and defaults; where they differ from the text above, they win:
- The section is **Cold outreach** at `/cold-outreach` (code and table names keep "sandbox"). Every
  `/sandbox` address redirects there with a 307. The old Sandbox pages, the Work tab and its
  `sandboxWork`, `WorkRow` and `sandboxDueCount` are gone.
- **Decision 2 is replaced by D2 (a), with a limit.** `/tasks` lists CRM and cold work together;
  Home, Reports (All outreach, CRM, Cold outreach), Activity, Ctrl+K and the campaign page include
  cold work. Creating cold work stays inside Cold outreach.
- **Cold campaigns are built in the campaign studio** and need no approval: publishing schedules
  one. The old Start campaign form, its approval and its launcher are gone; cold campaigns made
  with it were moved onto the studio by the release (migration `20261106300000`).
- Every call closes its due call step within the rules of PLAN 8.7; the post-call form is the one
  for cold and CRM calls, and the CRM's quick Log call stays as it was.
- Retention is always on, re-hashes old opt-outs itself and never removes a contact with activity
  in its window; Settings > Cold outreach shows what it would remove in the next 30 days.
- A cold contact's reply rings the campaign's rep, the mailbox owner and the owner (or the pod's
  leaders when nobody owns it). Twenty's mail sync is a second source of cold email evidence (N028).
