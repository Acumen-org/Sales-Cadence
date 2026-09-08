import type { SequenceStep } from './steps';

export const DEFAULT_SEQUENCE_NAME = 'Default outbound (23 days)';
export const DEFAULT_SEQUENCE_DESCRIPTION =
  'Eight steps over 23 days across email, phone and LinkedIn. Humans do every touch; Cadence only tells you who and when.';

const followUpEmail = {
  type: 'EMAIL' as const,
  label: 'Follow-up email',
  subject: 'Re: {{company}} - quick follow-up',
  template:
    'Hi {{firstName}},\n\nTried to reach you by phone just now. I wanted to share how teams like {{company}} are handling this today and see whether it is worth a short conversation.\n\nHappy to send over a couple of examples if useful.\n\n{{foFirstName}}',
};

const followUpLinkedIn = {
  type: 'LINKEDIN_MESSAGE' as const,
  label: 'LinkedIn message',
  template:
    'Hi {{firstName}}, tried calling you earlier today. Would a 15 minute chat about what {{company}} is doing here be useful? Happy to work around your calendar. {{foFirstName}}',
};

/**
 * The house sequence, seeded exactly as version 1. Admin edits create new versions.
 *
 * | Day | Actions                                     |
 * |-----|---------------------------------------------|
 * | 1   | Email 1, LinkedIn connect                   |
 * | 3   | Call 1, then email OR LinkedIn message      |
 * | 6   | Email 2                                     |
 * | 9   | LinkedIn message 2                          |
 * | 12  | Call 2, then email OR LinkedIn message      |
 * | 16  | LinkedIn message 3                          |
 * | 20  | Call 3, then email OR LinkedIn message      |
 * | 23  | Email 3                                     |
 */
export const DEFAULT_SEQUENCE_STEPS: SequenceStep[] = [
  {
    id: 'step-d1',
    day: 1,
    title: 'Open',
    actions: [
      {
        id: 'act-email-1',
        type: 'EMAIL',
        label: 'Email 1',
        subject: '{{company}} <> a quick idea',
        template:
          'Hi {{firstName}},\n\nAs {{jobTitle}} at {{company}} you are probably close to this, so I will keep it short.\n\nWe help teams like yours turn outreach into booked conversations without adding headcount. Would it be worth 15 minutes next week to see if it applies to {{company}}?\n\nBest,\n{{foFirstName}}',
      },
      {
        id: 'act-li-connect-1',
        type: 'LINKEDIN_CONNECT',
        label: 'LinkedIn connect',
        template: 'Hi {{firstName}}, our paths crossed via {{leadSource}}. Would be good to stay connected. {{foFirstName}}',
      },
    ],
  },
  {
    id: 'step-d3',
    day: 3,
    title: 'First call',
    actions: [
      {
        id: 'act-call-1',
        type: 'CALL',
        label: 'Call 1',
        template:
          'Hi {{firstName}}, it is {{foFirstName}}. I sent you a note a couple of days ago. Do you have two minutes?\n\n- Confirm role: {{jobTitle}} at {{company}}\n- One question about how outreach is run today\n- Ask for a 15 minute slot next week',
      },
      { id: 'act-followup-1', ...followUpEmail, alternative: followUpLinkedIn },
    ],
  },
  {
    id: 'step-d6',
    day: 6,
    title: 'Second email',
    actions: [
      {
        id: 'act-email-2',
        type: 'EMAIL',
        label: 'Email 2',
        subject: 'Re: {{company}} <> a quick idea',
        template:
          'Hi {{firstName}},\n\nOne concrete example: a team about the size of {{company}} doubled first meetings in a quarter by working a fixed cadence across email, phone and LinkedIn.\n\nIf that is relevant, I can walk you through it in 15 minutes. If not, tell me and I will stop here.\n\n{{foFirstName}}',
      },
    ],
  },
  {
    id: 'step-d9',
    day: 9,
    title: 'LinkedIn touch',
    actions: [
      {
        id: 'act-li-msg-2',
        type: 'LINKEDIN_MESSAGE',
        label: 'LinkedIn message 2',
        template:
          'Hi {{firstName}}, thanks for connecting. I sent a couple of emails about how {{company}} could get more meetings from the same outreach. Worth a quick chat? {{foFirstName}}',
      },
    ],
  },
  {
    id: 'step-d12',
    day: 12,
    title: 'Second call',
    actions: [
      {
        id: 'act-call-2',
        type: 'CALL',
        label: 'Call 2',
        template:
          'Hi {{firstName}}, {{foFirstName}} again. Following up on my emails about {{company}}. Is now a bad time?\n\n- Reference the example from Email 2\n- Ask what they are doing today\n- Offer two slots',
      },
      { id: 'act-followup-2', ...followUpEmail, alternative: followUpLinkedIn },
    ],
  },
  {
    id: 'step-d16',
    day: 16,
    title: 'LinkedIn touch',
    actions: [
      {
        id: 'act-li-msg-3',
        type: 'LINKEDIN_MESSAGE',
        label: 'LinkedIn message 3',
        template:
          '{{firstName}}, I will keep this short: if outreach at {{company}} is not a priority right now, no problem at all. If it is, I have 15 minutes whenever suits you. {{foFirstName}}',
      },
    ],
  },
  {
    id: 'step-d20',
    day: 20,
    title: 'Third call',
    actions: [
      {
        id: 'act-call-3',
        type: 'CALL',
        label: 'Call 3',
        template:
          'Hi {{firstName}}, {{foFirstName}}. Last attempt by phone. I would love five minutes to learn whether this is relevant for {{company}}, and if not I will close the loop.',
      },
      { id: 'act-followup-3', ...followUpEmail, alternative: followUpLinkedIn },
    ],
  },
  {
    id: 'step-d23',
    day: 23,
    title: 'Close the loop',
    actions: [
      {
        id: 'act-email-3',
        type: 'EMAIL',
        label: 'Email 3',
        subject: 'Closing the loop, {{firstName}}',
        template:
          'Hi {{firstName}},\n\nI have not heard back, so I will assume the timing is not right for {{company}}. If anything changes, my door is open.\n\nThanks for your time,\n{{foFirstName}}',
      },
    ],
  },
];
