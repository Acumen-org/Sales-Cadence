import { describe, expect, it } from 'vitest';
import { activeCueIndex, detectTranscriptFormat, parseTranscript } from '@/lib/meetings/transcript';

describe('transcripts arrive in every shape the tools export', () => {
  it('reads short VTT timestamps and UUID cue IDs without including metadata', () => {
    const { cues } = parseTranscript('WEBVTT\n\nNOTE metadata\n00:00.000 --> 00:02.000\nIgnore this\n\ncue-uuid-abc\n01:02.500 --> 01:04.750\n<v Alisa>Hello</v>');
    expect(cues).toEqual([{ start: 62.5, end: 64.75, speaker: 'Alisa', text: 'Hello' }]);
  });
  it('keeps separate untimed-end turns and follows the later turn during playback', () => {
    const { cues } = parseTranscript('Alisa   0:02\nHello\n\nAlisa   0:12\nStill here\n\nGuest   0:20\nYes');
    expect(cues).toHaveLength(3);
    expect(activeCueIndex(cues, 1)).toBeNull();
    expect(activeCueIndex(cues, 10)).toBe(0);
    expect(activeCueIndex(cues, 12)).toBe(1);
    expect(activeCueIndex(cues, 25)).toBe(2);
    expect(activeCueIndex([{ start: 0, end: 5, speaker: null, text: 'Hi' }], 6)).toBeNull();
  });
  it('reads a Teams JSON export and keeps only the dialogue', () => {
    const raw = JSON.stringify({
      version: '1.0',
      entries: [
        { id: 'a1', speechServiceResultId: 'x', text: 'Thanks for making the time.', speakerDisplayName: 'Alisa Senior', speakerId: 'u1', confidence: 0.91, startOffset: '00:00:02.1200000', endOffset: '00:00:05.5000000' },
        { id: 'a2', text: 'No, twenty is fine.', speakerDisplayName: 'Dummy Eight', speakerId: 'u2', confidence: 0.88, startOffset: '00:00:12.0000000', endOffset: '00:00:14.0000000' },
      ],
    });
    expect(detectTranscriptFormat(raw)).toBe('json');
    const { cues } = parseTranscript(raw);
    expect(cues).toEqual([
      { start: 2.12, end: 5.5, speaker: 'Alisa Senior', text: 'Thanks for making the time.' },
      { start: 12, end: 14, speaker: 'Dummy Eight', text: 'No, twenty is fine.' },
    ]);
  });
  it('reads a plain array of utterances with millisecond offsets', () => {
    const raw = JSON.stringify([{ speaker: 'A', start: 1500, end: 3000, text: 'hello' }, { speaker: 'B', start: 4000, text: 'hi there' }]);
    const { cues } = parseTranscript(raw);
    expect(cues.map((c) => [c.speaker, c.start, c.text])).toEqual([['A', 1.5, 'hello'], ['B', 4, 'hi there']]);
  });
  it('reads the grouped text Teams copies to the clipboard', () => {
    const raw = ['Alisa Senior   0:02', 'Thanks for making the time.', 'I will keep it short.', '', 'Dummy Eight   0:12', 'No, twenty is fine.'].join('\n');
    const { format, cues } = parseTranscript(raw);
    expect(format).toBe('text');
    expect(cues).toEqual([
      { start: 2, end: null, speaker: 'Alisa Senior', text: 'Thanks for making the time. I will keep it short.' },
      { start: 12, end: null, speaker: 'Dummy Eight', text: 'No, twenty is fine.' },
    ]);
  });
  it('still reads WebVTT and leaves junk JSON to the text parser', () => {
    expect(parseTranscript('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Alisa>Hello</v>').cues[0]).toMatchObject({ speaker: 'Alisa', text: 'Hello' });
    expect(detectTranscriptFormat('{ not json')).toBe('text');
  });
});
