import type { SequenceStep } from './steps';

export const DEFAULT_SEQUENCE_NAME = 'Default outbound';

/**
 * The sequence a fresh workspace starts with. It is a starting point, not a script: an FO reads
 * the person's record on the right of the task screen and rewrites the message before sending it
 * from their own mailbox.
 *
 * Days are business days counted from the enrollment start, so day 1 on a Monday puts day 6 on
 * the following Monday. Two steps carry more than one module, which is how a call and its
 * follow-up land in the same task rather than as two pieces of work.
 *
 * | Day | Modules                        |
 * |-----|--------------------------------|
 * | 1   | Email, LinkedIn connect        |
 * | 3   | Call, Email                    |
 * | 6   | Email                          |
 * | 9   | LinkedIn message               |
 * | 12  | Call, LinkedIn message         |
 * | 16  | LinkedIn message               |
 * | 20  | Call, Email                    |
 * | 23  | Email                          |
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
        subject: 'A quick idea for your team',
        template:
          'Hi there,\n\nYou are probably close to this, so I will keep it short.\n\nWe help firms like yours turn outreach into booked conversations without adding headcount. Would it be worth 15 minutes next week to see whether it applies to you?\n\nBest,',
      },
      {
        id: 'act-li-connect-1',
        type: 'LINKEDIN_CONNECT',
        label: 'LinkedIn connect',
        template: 'Hi, our paths crossed recently. Would be good to stay connected.',
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
          'Opening: I sent you a note a couple of days ago. Do you have two minutes?\n\n- Confirm their role\n- One question about how outreach is run today\n- Ask for a 15 minute slot next week',
      },
      {
        id: 'act-followup-1',
        type: 'EMAIL',
        label: 'Follow-up email',
        subject: 'Following up on my call',
        template:
          'Hi there,\n\nTried to reach you by phone just now. I wanted to share how teams like yours are handling this today and see whether it is worth a short conversation.\n\nHappy to send over a couple of examples if useful.',
      },
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
        subject: 'One concrete example',
        template:
          'Hi there,\n\nOne concrete example: a team about your size doubled first meetings in a quarter by working a fixed rhythm across email, phone and LinkedIn.\n\nIf that is relevant I can walk you through it in 15 minutes. If not, tell me and I will stop here.',
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
        template: 'Thanks for connecting. I sent a couple of emails about getting more meetings from the same outreach. Worth a quick chat?',
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
        template: 'Opening: following up on my emails. Is now a bad time?\n\n- Reference the example from the second email\n- Ask what they are doing today\n- Offer two slots',
      },
      {
        id: 'act-followup-2',
        type: 'LINKEDIN_MESSAGE',
        label: 'LinkedIn message',
        template: 'Tried calling you earlier today. Would a 15 minute chat be useful? Happy to work around your calendar.',
      },
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
        template: 'I will keep this short: if this is not a priority right now, no problem at all. If it is, I have 15 minutes whenever suits you.',
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
        template: 'Opening: last attempt by phone. I would love five minutes to learn whether this is relevant, and if not I will close the loop.',
      },
      {
        id: 'act-followup-3',
        type: 'EMAIL',
        label: 'Follow-up email',
        subject: 'Following up on my call',
        template: 'Hi there,\n\nTried you by phone again today. If the timing is wrong, say the word and I will stop.',
      },
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
        subject: 'Closing the loop',
        template:
          'Hi there,\n\nI have not heard back, so I will assume the timing is not right. If anything changes, my door is open.\n\nThanks for your time,',
      },
    ],
  },
];
