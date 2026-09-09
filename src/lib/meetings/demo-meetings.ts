/**
 * Dummy meetings and the dummy relationship map, used by the demo seed only.
 *
 * These are Cadence-local records, not Twenty objects: a meeting is a link somebody pasted plus
 * whatever transcript they had. One meeting of each shape is included so the player is visible in
 * every mode it supports:
 *
 *   - FILE        a direct media file, played inline with <video> (the only one that really plays)
 *   - SHAREPOINT  a Stream/SharePoint recording, framed with ?embed=true
 *   - ZOOM        a cloud recording page, which refuses framing, so it renders as a link-out card
 *   - GOOGLE_MEET a join link, which is not a recording at all
 *
 * Attendee addresses matter: an attendee outside settings.rules.internalDomains is what makes a
 * meeting count as "booked" on Home. Colleagues therefore use an internal domain here, and those
 * same addresses are added to the demo users' aliases by the seed so they still match a user.
 */

export type DemoAttendee = { name: string; email: string; host?: boolean };

export type DemoMeeting = {
  key: string;
  title: string;
  sourceUrl: string;
  /** Days before today. The seed keeps the clock time and drops it into the current week. */
  daysAgo: number;
  /** Hour of the day, UTC. */
  hour: number;
  durationMin: number;
  companyId: string;
  notes?: string;
  transcript?: string;
  attendees: DemoAttendee[];
};

const INTRO_TRANSCRIPT = `WEBVTT

00:00:02.000 --> 00:00:11.500
<v Alisa Senior>Thanks for making the time. I know the quarter close is on you, so I will keep this to twenty minutes unless you want to go longer.

00:00:12.000 --> 00:00:29.000
<v Dummy Eight>No, twenty is fine. I read the note you sent. The part that caught my eye was the reporting pack, because we rebuild that by hand every month.

00:00:29.500 --> 00:00:44.000
<v Alisa Senior>That is the usual reason people call us. How many people touch that pack before it goes out?

00:00:44.500 --> 00:01:04.000
<v Dummy Eight>Three. My analyst pulls the numbers, I check them, and then it goes to Dummy Seven for sign-off. It is two days of work every month and the numbers still move after sign-off.

00:01:04.500 --> 00:01:18.000
<v Alisa Senior>And when the numbers move, who finds out first, you or the client?

00:01:18.500 --> 00:01:33.000
<v Dummy Eight>Honestly, sometimes the client. That is the bit I want to stop. It costs us credibility even when the underlying position is fine.

00:01:33.500 --> 00:01:52.000
<v Alisa Senior>Understood. Two things worth checking before we go further. First, is the data already in one system, or is it spread across the fund admin and your own ledger?

00:01:52.500 --> 00:02:12.000
<v Dummy Eight>Spread. Fund admin has the positions, our ledger has the fees, and the commentary lives in a shared document that nobody owns.

00:02:12.500 --> 00:02:26.000
<v Alisa Senior>That is workable. Second, who signs a contract of this size at Dummy Company C?

00:02:26.500 --> 00:02:41.000
<v Dummy Eight>Dummy Seven signs anything under two hundred thousand. Above that it goes to the investment committee, which meets monthly.

00:02:41.500 --> 00:02:58.000
<v Alisa Senior>Then let us aim under that line for the first phase. I will put a two-page outline together with the reporting pack as phase one.

00:02:58.500 --> 00:03:14.000
<v Dummy Eight>Send it by Thursday and I will walk Dummy Seven through it on Friday. If it lands, we can talk about the wider rollout in the new year.

00:03:14.500 --> 00:03:24.000
<v Alisa Senior>Thursday works. I will also include two references from firms your size.

00:03:24.500 --> 00:03:33.000
<v Dummy Eight>Perfect. One thing, please do not copy the whole committee yet. Just me.
`;

const FOLLOW_UP_TRANSCRIPT = `[00:00:03] Andrew Senior: Quick one before we start, is Dummy Nine joining?
[00:00:07] Dummy Seven: He is on a flight, so it is you and me. He asked me to cover the commercials.
[00:00:15] Andrew Senior: Then let us do commercials first and I will send him the technical piece separately.
[00:00:23] Dummy Seven: The number in your outline is fine. What I cannot do is the twelve-month commitment. Six with a break clause, and we will talk about twelve at renewal.
[00:00:39] Andrew Senior: Six with a break at four is something I can put forward. Below four it stops being worth setting up.
[00:00:50] Dummy Seven: Four is acceptable. The other open point is who owns the migration. I do not have a person for it.
[00:01:02] Andrew Senior: We do the migration. You give us one contact for questions, that is all we need from your side.
[00:01:12] Dummy Seven: Then we are close. Send the revised paper and I will get it into next week's committee.
[00:01:20] Andrew Senior: I will have it with you tomorrow morning.
`;

export const DEMO_MEETINGS: DemoMeeting[] = [
  {
    // A real, public sample clip stands in for a recording so playback is actually demonstrable.
    key: 'dummy-meeting-intro',
    title: 'Dummy Company C - intro call',
    sourceUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeetings.mp4',
    daysAgo: 2,
    hour: 10,
    durationMin: 21,
    companyId: 'dummy-co-c',
    notes: 'Reporting pack is the pain. Dummy Seven signs under 200k. Two-page outline due Thursday.',
    transcript: INTRO_TRANSCRIPT,
    attendees: [
      { name: 'Alisa Senior', email: 'alisa@acumen-strategy.com', host: true },
      { name: 'Dummy Eight', email: 'dummy.eight@dummy-c.example' },
    ],
  },
  {
    key: 'dummy-meeting-commercials',
    title: 'Dummy Company C - commercials follow-up',
    sourceUrl: 'https://acumenstrategy.sharepoint.com/sites/recordings/Shared%20Documents/dummy-company-c-follow-up.mp4',
    daysAgo: 1,
    hour: 15,
    durationMin: 14,
    companyId: 'dummy-co-c',
    notes: 'Six months with a break at four. We own the migration. Revised paper due tomorrow.',
    transcript: FOLLOW_UP_TRANSCRIPT,
    attendees: [
      { name: 'Andrew Senior', email: 'andrew@acumen-strategy.com', host: true },
      { name: 'Dummy Seven', email: 'dummy.seven@dummy-c.example' },
    ],
  },
  {
    key: 'dummy-meeting-zoom',
    title: 'Dummy Company A - operations review',
    sourceUrl: 'https://acumen.zoom.us/rec/share/dummy-recording-id',
    daysAgo: 3,
    hour: 13,
    durationMin: 32,
    companyId: 'dummy-co-a',
    notes: 'Zoom cloud recordings cannot be framed, so this one opens in a new tab. Transcript not pasted yet.',
    attendees: [
      { name: 'Alisa Senior', email: 'alisa@acumen-strategy.com', host: true },
      { name: 'Karson Junior', email: 'karson@acumen-strategy.com' },
      { name: 'Dummy One', email: 'dummy.one@dummy-a.example' },
      { name: 'Dummy Thirteen', email: 'dummy.thirteen@dummy-a.example' },
    ],
  },
  {
    key: 'dummy-meeting-upcoming',
    title: 'Dummy Company B - discovery (scheduled)',
    sourceUrl: 'https://meet.google.com/dum-myco-nfb',
    daysAgo: -1,
    hour: 9,
    durationMin: 30,
    companyId: 'dummy-co-b',
    notes: 'A join link, not a recording. Paste the recording link and transcript after the call.',
    attendees: [
      { name: 'Daniel Junior', email: 'daniel@acumen-strategy.com', host: true },
      { name: 'Dummy Four', email: 'dummy.four@dummy-b.example' },
      { name: 'Dummy Five', email: 'dummy.five@dummy-b.example' },
    ],
  },
];

/** Mailbox address per demo user, added to `User.aliases` so attendees match a real user. */
export const DEMO_USER_MAILBOXES: Record<string, string> = {
  'ria@cadence.local': 'ria@acumen-strategy.com',
  'alisa@cadence.local': 'alisa@acumen-strategy.com',
  'andrew@cadence.local': 'andrew@acumen-strategy.com',
  'karson@cadence.local': 'karson@acumen-strategy.com',
  'daniel@cadence.local': 'daniel@acumen-strategy.com',
};
