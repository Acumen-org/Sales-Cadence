import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallFormContext } from '@/lib/calls/form-context';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

const { CallButton } = await import('@/components/calls/call-button');
const { defaultStep, dropDraft, PendingCalls, PostCallForm, readDraft, startingValues, stopEffects, writeDraft } = await import('@/components/calls/post-call-form');
const { LogCallButton } = await import('@/components/calls/log-call');
const { CallerNumberRow } = await import('@/components/settings/sandbox-settings');

/**
 * W4's screens (PLAN 4.6): the post-call form, the waiting-forms notice, the Call button's reason and
 * Log a call, drawn on the server the way the page first paints them. Each test is named after its bug.
 */

const outcomes: CallFormContext['outcomes'] = [
  { key: 'connected', label: 'Connected', answered: true, group: 'reached', disabled: null },
  { key: 'meeting_booked', label: 'Meeting booked', answered: true, group: 'reached', disabled: null },
  { key: 'no_answer', label: 'No answer', answered: false, group: 'not_reached', disabled: null },
  { key: 'voicemail', label: 'Left voicemail', answered: false, group: 'not_reached', disabled: null },
  { key: 'busy', label: 'Busy / call back', answered: false, group: 'not_reached', disabled: null },
  { key: 'not_interested', label: 'Not interested', answered: true, group: 'stop', disabled: null },
  { key: 'wrong_number', label: 'Wrong number', answered: false, group: 'stop', disabled: null },
  { key: 'do_not_contact', label: 'Asked not to be contacted', answered: true, group: 'stop', disabled: null },
];

function context(over: Partial<CallFormContext> = {}): CallFormContext {
  return {
    callId: 'call-1', incoming: false, name: 'Jane Doe', number: '+13125550100', at: 'yesterday 20:20 CT', talk: '3m 12s',
    who: { kind: 'cold', id: 'c1', href: '/cold-outreach/c1', active: true, standing: null, firstName: 'Jane' },
    candidates: [], closes: { linked: { key: 'task:t1', words: 'Call 2 of Q4 Harbor' }, choices: [{ key: 'task:t1', words: 'Call 2 of Q4 Harbor', repeats: false }] },
    open: null, campaign: { name: 'Q4 Harbor', next: 'Email 2 on 5 Nov' }, colleague: null, claim: null, outcomes,
    products: [{ key: 'PHH', label: 'PHH' }, { key: 'ACUBOOTH', label: 'AcuBooth' }, { key: 'GLYNAC', label: 'Glynac' }],
    prefill: null, defaultDate: '2026-11-06', today: '2026-11-04', discard: null, ...over,
  };
}
const draw = (ctx: CallFormContext) => renderToStaticMarkup(createElement(PostCallForm, { callId: ctx.callId, onClose: () => {}, initial: ctx }));
/** The outcome radio for a key, as drawn. */
const radio = (html: string, key: string) => html.match(new RegExp(`<input type="radio"[^>]*value="${key}"[^>]*>`))?.[0] ?? '';

describe('W4 screens', () => {
  it('B182: outcomes sit in three labelled groups, products read in words, and Save names what is missing', () => {
    const html = draw(context({ prefill: 'connected' }));
    expect(html).toContain('Reached them');
    expect(html).toContain('Didn&#x27;t reach them');
    expect(html).toContain('>Stop</legend>');
    expect(html).toContain('AcuBooth');
    expect(html).not.toContain('TOLLBOOTH');
    expect(html).toMatch(/Rating <span class="text-red-700">\*<\/span>/);
    expect(html).toContain('Rate the call.');
  });

  it('B182: Interest, decision maker and products show only when they were reached', () => {
    expect(draw(context({ prefill: 'no_answer' }))).not.toContain('Decision maker');
    expect(draw(context({ prefill: 'connected' }))).toContain('Decision maker');
  });

  it('N045: each outcome shows a focus ring, and focus starts on the one already chosen', () => {
    const html = draw(context({ prefill: 'no_answer' }));
    expect(html).toContain('has-[:focus-visible]:ring-2');
    expect(radio(html, 'no_answer')).toContain('checked=""');
    expect(radio(html, 'connected')).not.toContain('checked=""');
  });

  it('N013: the form says what the call closes, with "Not for this step"; with nothing due it is an extra call', () => {
    expect(draw(context())).toContain('Closes Call 2 of Q4 Harbor');
    expect(draw(context())).toContain('Not for this step');
    expect(draw(context({ closes: { linked: null, choices: [] } }))).toContain('Extra call: closes nothing.');
    expect(draw(context({ closes: { linked: null, choices: [{ key: 'task:a', words: 'Call 1 of A', repeats: false }, { key: 'next:b', words: 'Call on 3 Nov', repeats: false }] } }))).toContain('Which step does this call close?');
  });

  it('B028: the next step follows the outcome: the campaign continues, a meeting for Meeting booked, nothing after Stop', () => {
    const ctx = context();
    const o = (key: string) => outcomes.find((x) => x.key === key);
    expect(defaultStep(o('no_answer'), ctx)).toBe('campaign');
    expect(defaultStep(o('meeting_booked'), ctx)).toBe('meeting');
    expect(defaultStep(o('connected'), ctx)).toBe('call_again');
    expect(defaultStep(o('do_not_contact'), ctx)).toBe('none');
    expect(draw(context({ prefill: 'no_answer' }))).toContain('The campaign continues: next is Email 2 on 5 Nov');
  });

  it('B093: an incoming call keeps the current next step by default and closes nothing', () => {
    const ctx = context({ incoming: true, campaign: null, open: { words: 'Email on 9 Nov', repeats: false, mine: true, foName: 'Alisa' }, closes: { linked: null, choices: [] } });
    expect(defaultStep(undefined, ctx)).toBe('keep');
    const html = draw(ctx);
    expect(html).toContain('(incoming)');
    expect(html).toContain('An incoming call closes no step.');
    expect(html).toContain('Keep: Email on 9 Nov');
  });

  it('N042: the Stop outcomes ask first, naming every effect', () => {
    const ctx = context({ open: { words: 'Call on 9 Nov', repeats: false, mine: true, foName: 'Alisa' } });
    expect(stopEffects(outcomes.find((o) => o.key === 'do_not_contact')!, ctx)).toEqual([
      'Jane is opted out for good: do not email, call or message them again. Cadence blocks calls and campaigns.',
      'Q4 Harbor ends as Opted out.',
      'The next step (Call on 9 Nov) is cancelled.',
      'Bellwether shows them as Do not contact.',
      'An admin can lift it if it was a mistake.',
    ]);
  });

  it('B025: from 30 seconds of talk No answer and Busy are greyed out, with the reason', () => {
    const html = draw(context({ outcomes: outcomes.map((o) => (o.key === 'no_answer' || o.key === 'busy' ? { ...o, disabled: 'This call lasted 3m 12s' } : o)) }));
    expect(radio(html, 'no_answer')).toContain('disabled=""');
    expect(radio(html, 'voicemail')).not.toContain('disabled=""');
    expect(html).toContain('This call lasted 3m 12s, so No answer and Busy are off.');
  });

  it('B004, B027, B092, B026: the form says when the contact is gone, whose step stays, the claim, and asks who an unmatched call was with', () => {
    expect(draw(context({ who: { kind: 'cold', id: 'c1', href: '/cold-outreach/c1', active: false, standing: 'You called a contact who asked not to be contacted. The call and form are kept; no next step will be set.', firstName: 'Jane' } }))).toContain('no next step will be set');
    expect(draw(context({ colleague: 'Jane is Alisa&apos;s contact.' }))).toContain('Jane is Alisa');
    expect(draw(context({ claim: 'Saving claims Jane for you.', campaign: null, prefill: 'connected' }))).toContain('Saving claims Jane for you.');
    const who = draw(context({ who: null, name: null, candidates: [{ key: 'sandbox:x', name: 'Sam Rivera', cold: true }] }));
    expect(who).toContain('Who did you speak to?');
    expect(who).toContain('Sam Rivera (cold contact)');
    expect(who).toContain('Add someone new');
  });

  it('B024: a mistaken call can be discarded from its form', () => {
    expect(draw(context())).toContain('Not a real call? Discard');
    expect(draw(context({ discard: 'Its form is in, so it stays.' }))).not.toContain('Discard');
  });

  describe('B087: the draft', () => {
    const store = new Map<string, string>();
    beforeEach(() => { (globalThis as { window?: unknown }).window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } } }; });
    afterEach(() => { delete (globalThis as { window?: unknown }).window; store.clear(); });
    it('B087: what was typed survives closing the form, and the form opens on it again', () => {
      writeDraft('call-9', { outcome: 'connected', notes: 'Wants a deck', rating: 4, step: '', date: '2026-11-06', time: '', what: '', interest: 'warm', decisionMaker: '', products: ['PHH'] });
      const v = startingValues(context({ callId: 'call-9' }), readDraft('call-9'));
      expect(v).toEqual(expect.objectContaining({ outcome: 'connected', notes: 'Wants a deck', rating: 4, step: 'call_again', interest: 'warm', products: ['PHH'] }));
      dropDraft('call-9');
      expect(readDraft('call-9')).toBeNull();
    });
  });

  it('B088: the waiting notice gives the real total, lists every call with incoming ones marked, and opens the first', () => {
    const calls = [{ id: 'a', name: 'Jane Doe', at: 'today 14:05 CT', incoming: false }, { id: 'b', name: 'Sam Rivera', at: 'yesterday 20:20 CT', incoming: true }];
    const html = renderToStaticMarkup(createElement(PendingCalls, { calls, total: 24, calling: null }));
    expect(html).toContain('24 calls need their form before you can call again.');
    expect(html).toContain('Fill the first');
    expect(html).toContain('Call from Sam Rivera (incoming) · yesterday 20:20 CT');
    expect(html).toContain('and 22 more');
    expect(renderToStaticMarkup(createElement(PendingCalls, { calls: [], total: 0, calling: 'Jane Doe' }))).toContain('Calling Jane Doe… when you hang up, the form opens here (within 2 minutes).');
  });

  it('B088: a long backlog names the oldest five and counts the rest, so the notice stays one short block', () => {
    const calls = Array.from({ length: 22 }, (_, i) => ({ id: `c${i}`, name: `Rep Call ${i}`, at: 'today 10:00 CT', incoming: false }));
    const html = renderToStaticMarkup(createElement(PendingCalls, { calls, total: 22, calling: null }));
    expect(html).toContain('22 calls need their form before you can call again.');
    expect(html.match(/Call with Rep Call/g)).toHaveLength(5);
    expect(html).toContain('Call with Rep Call 4 ·');
    expect(html).not.toContain('Call with Rep Call 5 ·');
    expect(html).toContain('and 17 more');
  });

  it('B093: an incoming call they answered keeps the planned next step by default, whatever was said', () => {
    const ctx = context({ incoming: true, campaign: null, open: { words: 'Email on 9 Nov', repeats: false, mine: true, foName: 'Alisa' }, closes: { linked: null, choices: [] } });
    const o = (key: string) => outcomes.find((x) => x.key === key);
    expect(defaultStep(o('connected'), ctx)).toBe('keep');
    expect(defaultStep(o('meeting_booked'), ctx)).toBe('meeting');
    expect(defaultStep(o('do_not_contact'), ctx)).toBe('none');
    // An outbound call that reached them still proposes calling again.
    expect(defaultStep(o('connected'), { ...ctx, incoming: false })).toBe('call_again');
  });

  it('N054: a call on a repeating next step keeps the series by default, and replacing it says so first', () => {
    const ctx = context({ campaign: null, open: { words: 'Call every week, next Mon 9 Nov', repeats: true, mine: true, foName: 'Alisa' } });
    const o = (key: string) => outcomes.find((x) => x.key === key);
    expect(defaultStep(o('connected'), ctx)).toBe('keep');
    expect(defaultStep(o('no_answer'), ctx)).toBe('keep');
    expect(defaultStep(o('meeting_booked'), ctx)).toBe('meeting');
    expect(draw(context({ campaign: null, prefill: 'connected', open: { words: 'Call every week, next Mon 9 Nov', repeats: true, mine: true, foName: 'Alisa' } }))).toContain('Keep: Call every week, next Mon 9 Nov (repeats)');
  });

  it('B089: a blocked Call says why in visible text; a waiting form reads "Form first" with a way to fill it in', () => {
    const html = renderToStaticMarkup(createElement(CallButton, { phone: '+13125550100', template: null, blocked: 'Fill in the form for your call with Jane Doe (yesterday 20:20 CT) first.' }));
    expect(html).toContain('Form first');
    expect(html).toMatch(/<span class="max-w-xs text-\[12px\] text-ink-600">Fill in the form for your call with Jane Doe/);
    expect(html).toContain('Fill it in');
    const hours = renderToStaticMarkup(createElement(CallButton, { phone: '+13125550100', template: null, blocked: 'It is 21:30 CT for this contact, outside 8:00 to 21:00.' }));
    expect(hours).toContain('outside 8:00 to 21:00');
    expect(hours).not.toContain('Fill it in');
  });

  it('B024: the form of a call just logged stays open when the page re-reads and Log a call turns off', () => {
    // Saving the call makes it the form waiting, so the page re-reads with Log a call blocked; the blocked
    // branch must still hold the form the rep was told would open.
    const src = fs.readFileSync('src/components/calls/log-call.tsx', 'utf8');
    expect(src).toMatch(/if \(blocked\) return <>.*\{formDialog\}<\/>;/);
  });

  it('B024: Log a call opens a dialog that asks first; while a form waits it says why it is off', () => {
    const html = renderToStaticMarkup(createElement(LogCallButton, { sandboxContactId: 'c1', name: 'Jane Doe', steps: [], now: '2026-11-05T10:00' }));
    expect(html).toContain('Log a call');
    const blocked = renderToStaticMarkup(createElement(LogCallButton, { sandboxContactId: 'c1', name: 'Jane Doe', steps: [], now: '2026-11-05T10:00', blocked: 'Fill in the form for your call with Sam first.' }));
    expect(blocked).toContain('disabled=""');
    expect(blocked).toContain('Fill in the form for your call with Sam first.');
  });

  it('B167: a number shows who it is assigned to, apart from a suggestion that is not an assignment', () => {
    const users = [{ id: 'a', name: 'Andrew Kim', number: '+13125552281' }, { id: 'k', name: 'Karson Lee', number: null }];
    const assigned = renderToStaticMarkup(createElement(CallerNumberRow, { number: '+13125550100', friendlyName: 'tw_andrew line', holder: { id: 'a', name: 'Andrew Kim' }, suggestion: null, users }));
    expect(assigned).toContain('Assigned to Andrew Kim');
    const suggested = renderToStaticMarkup(createElement(CallerNumberRow, { number: '+13125550101', friendlyName: 'Karson', holder: null, suggestion: { id: 'k', name: 'Karson Lee' }, users }));
    expect(suggested).toContain('Suggested: Karson Lee, not assigned');
    // The select starts on nobody: a suggestion is never preselected as if it were assigned.
    expect(suggested).toMatch(/<option value="" selected="">Nobody<\/option>/);
  });

  it('no screen of the form says sandbox or Twenty', () => {
    const html = [draw(context()), draw(context({ who: null, name: null })), renderToStaticMarkup(createElement(PendingCalls, { calls: [{ id: 'a', name: 'J', at: 'today', incoming: false }], total: 1, calling: null }))].join('');
    expect(html).not.toMatch(/sandbox(?!\/)|twenty/i);
  });
});
