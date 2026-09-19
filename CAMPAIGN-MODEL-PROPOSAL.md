# Campaigns and sequences: the core, and how it would change

Proposal for discussion, 19 September 2026. Nothing here is built; the owner asked to talk it
through first. Points refer to the September list (3, 17, 18, 19, 21, 22).

## What exists today

- A campaign is one sequence, one pod, a list of people, a start date and an optional end date.
  At launch every person gets an enrollment: person, sequence, FO, start day. Tasks are generated
  from the sequence's steps onto the FO's calendar.
- **One active campaign per person is already enforced at the lowest level**: the database allows
  one live enrollment (ACTIVE or PAUSED) per person, as a partial unique index. A second campaign
  that lists the same person shows them as "already active" or "scheduled elsewhere" and leaves
  them out. Finished enrollments do not occupy the slot, so a person can go through several
  sequences over time.
- FOs are not chosen. Every FO in the pod with a Twenty member id is a starter; people go to their
  Twenty owner (or to one fixed FO).
- Capacity works backwards from the end date. The last day anyone may start is the last working
  day from which every step still lands by the end date. Between the start and that day, each FO
  starts a fixed number of people per working day: the largest number whose worst day - every step
  of every start, on top of the work the FO already holds - still fits under their daily cap
  (Settings, default 20 touches). "Fits up to 135 people · 5 a day per FO · last start 30 Sept"
  meant three FOs, five starts each, nine starting days. The number was derived, not chosen, which
  is why it read as unclear.
- Sequences have no cap on steps; the plan's span is the last step's day.

## The proposal

### A. Starts per FO per day, chosen by the creator (18)

The campaign form gets one number, "Starts per FO per day", prefilled with a workspace default
and bounded by a workspace cap, both on Settings > Rules ("Default starts per FO per day",
proposed 5; "Most starts per FO per day", proposed 15). Above the cap the form refuses and shows
the cap. Behind "Set per FO", a table of the chosen FOs with a rate each, defaulting to the
campaign's number.

The planner then answers a plainer question: with this rate, does everyone fit between the start
and the end? The capacity line becomes "135 people at 5 a day across 3 FOs: 9 starting days,
finishes 14 Nov" - or, when the window is too short, "82 of 135 fit by 30 Oct; everyone fits by
14 Nov" with one click to take that end date. No "last start", no purple line.

### B. A cap on sequence steps (18)

Settings > Rules "Longest sequence": proposed 12 steps and 45 days. The sequence editor refuses a
step beyond either. Each campaign shows steps x people as its total touches.

### C. Start and end days linked (18)

End = start + starting days needed + the sequence's span, where starting days = people / (FOs x
rate), on working days. The form fills the end date when it is empty and recomputes when people,
rate, FOs or sequence change. A hand-set end date that is earlier shows how many fit (A above).

### D. Weekday utilisation view (18)

On the campaign page, a grid: one row per FO, one column per working day of the campaign,
grouped by week. A cell is the planned touches that day over the FO's daily cap, shaded light to
dark in the one green ramp, the number in ink; past days show done over planned. This is the data
the planner already simulates, drawn instead of summarised, and it replaces today's single
"elapsed" bar.

### E. Several sequences in one campaign (19)

A campaign has a default sequence and may carry others. At creation the people list gets a
"Sequence" column, the default preselected, settable per person or for a selection at once. When
a campaign has more than one sequence, "Add to campaign" on People asks which. Within a campaign
a person has exactly one sequence. Enrollments already store their sequence, so the campaign page
and Reports split by sequence without new counting.

### F. One active campaign; several sequences (3)

Two readings, and the difference decides the size of the work:

1. *Over time*: a person may go through several sequences, one live campaign at a time. This is
   the rule today, in the database. Nothing to build; the wording on People and the person page
   would say "one live campaign" where a conflict is refused.
2. *At once*: a person may be live in several sequences (say a nurture track beside outbound) but
   in one campaign. The unique index would move from person to person + sequence, "one campaign"
   would be enforced on the campaign instead, and a reply would have to finish every live sequence
   of that person, not one. Tasks, replies, the People "Campaign" column and Reports all change.

The proposal assumes reading 1 unless told otherwise.

### G. FOs chosen on the campaign (22)

The form lists the pod's FOs as checkboxes, all ticked. Assignment by Twenty owner stays, but
only among the ticked; a person whose owner is not ticked goes round-robin to the ticked FOs (or
the creator assigns by hand, if preferred). Stored on the campaign, shown on its page.

### H. Editing upcoming campaigns (17)

Until launch everything is editable: name, sequences, people, FOs, dates, rate. After launch:
name, description, end date and the hard-stop flag only; an extended end date re-plans nothing,
a shortened one is the existing hard stop. Active campaigns' sequences stay locked.

## Order and size

1. A, C and B together: settings, form, the simpler planner, the last-start marker gone. About a day.
2. G and H: half a day.
3. E: a day and a half, with the migration, the People flow and the per-sequence tables.
4. D: half a day.
5. F depends on the answer below.

## To decide

1. Default and cap for starts per FO per day: 5 and 15?
2. Longest sequence: 12 steps and 45 days?
3. Point 3: reading 1 (one live sequence, as today) or reading 2 (several live sequences, one campaign)?
4. A person whose Twenty owner is not among the chosen FOs: round-robin, or assigned by hand?
5. The utilisation grid: touches per day against the cap, or people started per day?
