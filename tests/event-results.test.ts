import { describe, expect, it } from 'vitest';
import { describeEventResult } from '@/lib/event-results';

describe('the Activity log in words', () => {
  it('says what each CRM event did', () => {
    expect(describeEventResult('message_outbound_completed')).toBe('Closed an email step');
    expect(describeEventResult('note_outbound_call_completed')).toBe('Closed a call step');
    expect(describeEventResult('note_outbound_email_touch', { p1: 'no_pending_task', p2: 'same_touch' })).toBe('Kept for the next step, Already counted');
    expect(describeEventResult('note_unknown_actor')).toBe('On the timeline');
    expect(describeEventResult('ignored_object_messageThread')).toBe('Not used');
    expect(describeEventResult('inbound_no_active_enrollment')).toBe('Reply from someone not in a campaign');
    expect(describeEventResult('error: Twenty timed out')).toBe('Failed: Twenty timed out');
    expect(describeEventResult(null)).toBeNull();
    // Anything new still reads as words.
    expect(describeEventResult('some_new_code')).toBe('some new code');
  });
});
