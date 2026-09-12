import { describe, expect, it } from 'vitest';
import { detectTranscriptFormat, formatCueTime, parseTranscript, talkShare } from '@/lib/meetings/transcript';

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Alisa Senior>Thanks for making the time today.

00:00:04.500 --> 00:00:07.000
<v Alisa Senior>I will keep it short.

00:00:08.000 --> 00:00:16.000
<v Dummy Eight>The reporting pack is the part that hurts.
`;

const SRT = `1
00:00:02,000 --> 00:00:05,000
Andrew Senior: Is Dummy Nine joining?

2
00:00:05,500 --> 00:00:09,000
Dummy Seven: He is on a flight.
`;

describe('speakers', () => {
  it('reads a name with a bracketed affiliation, as Teams writes guests', () => {
    const cues = parseTranscript(['Lloyd Easters: Alyssa is an entrepreneur.', 'Jeff Pieta (AIS): Thank you, Lloyd.', 'Ryan Brennan: Cool.'].join(String.fromCharCode(10)), 'text').cues;
    expect(cues.map((c) => c.speaker)).toEqual(['Lloyd Easters', 'Jeff Pieta (AIS)', 'Ryan Brennan']);
    expect(cues[1].text).toBe('Thank you, Lloyd.');
    // A sentence with a colon in it is prose, not a speaker.
    expect(parseTranscript('The plan we discussed at length yesterday afternoon with everyone: ship it.', 'text').cues[0].speaker).toBeNull();
  });
});

describe('detectTranscriptFormat', () => {
  it('reads the WEBVTT header, even with a byte-order mark', () => {
    expect(detectTranscriptFormat(VTT)).toBe('vtt');
    expect(detectTranscriptFormat(`﻿${VTT}`)).toBe('vtt');
  });

  it('calls a numbered comma-timed file SRT', () => {
    expect(detectTranscriptFormat(SRT)).toBe('srt');
  });

  it('falls back to plain text', () => {
    expect(detectTranscriptFormat('Alisa: hello\nDummy One: hi')).toBe('text');
    expect(detectTranscriptFormat('')).toBe('text');
  });
});

describe('parseTranscript', () => {
  it('parses VTT cues with speakers and timings', () => {
    const { format, cues } = parseTranscript(VTT);
    expect(format).toBe('vtt');
    // The two consecutive Alisa cues merge into one.
    expect(cues).toHaveLength(2);
    expect(cues[0].speaker).toBe('Alisa Senior');
    expect(cues[0].start).toBeCloseTo(1);
    expect(cues[0].end).toBeCloseTo(7);
    expect(cues[0].text).toBe('Thanks for making the time today. I will keep it short.');
    expect(cues[1].speaker).toBe('Dummy Eight');
  });

  it('does not merge across a gap or a change of speaker', () => {
    const { cues } = parseTranscript(`WEBVTT

00:00:01.000 --> 00:00:02.000
<v A>one

00:00:30.000 --> 00:00:31.000
<v A>two
`);
    expect(cues).toHaveLength(2);
  });

  it('parses SRT, stripping the sequence numbers', () => {
    const { format, cues } = parseTranscript(SRT);
    expect(format).toBe('srt');
    expect(cues).toHaveLength(2);
    expect(cues[0].speaker).toBe('Andrew Senior');
    expect(cues[0].text).toBe('Is Dummy Nine joining?');
    expect(cues[1].start).toBeCloseTo(5.5);
  });

  it('makes one cue per line for a plain paste, with no timings', () => {
    const { format, cues } = parseTranscript('Alisa: hello there\n\nDummy One: hi\nno speaker on this line');
    expect(format).toBe('text');
    expect(cues).toHaveLength(3);
    expect(cues[0]).toMatchObject({ speaker: 'Alisa', text: 'hello there', start: 0, end: null });
    expect(cues[2].speaker).toBeNull();
  });

  it('keeps a leading timestamp from a pasted transcript', () => {
    const { cues } = parseTranscript('[00:01:05] Andrew Senior: Is Dummy Nine joining?\n(2:30) Dummy Seven: He is on a flight.\n3:00 - Andrew Senior: Understood.');
    expect(cues.map((c) => c.start)).toEqual([65, 150, 180]);
    expect(cues.map((c) => c.speaker)).toEqual(['Andrew Senior', 'Dummy Seven', 'Andrew Senior']);
    expect(cues[0].text).toBe('Is Dummy Nine joining?');
  });

  it('does not treat a sentence opener as a speaker', () => {
    const { cues } = parseTranscript('One thing to be clear about here: we cannot commit to twelve months.');
    expect(cues[0].speaker).toBeNull();
    expect(cues[0].text).toMatch(/^One thing/);
  });

  it('drops VTT metadata blocks and inline tags', () => {
    const { cues } = parseTranscript(`WEBVTT

NOTE this is a note

STYLE
::cue { color: red }

00:00:01.000 --> 00:00:02.000
<c.yellow>plain</c> <00:00:01.500>words
`);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('plain words');
  });

  it('returns nothing for empty input', () => {
    expect(parseTranscript('   ').cues).toEqual([]);
  });
});

describe('talkShare', () => {
  it('splits by cue duration when timings exist', () => {
    const rows = talkShare(parseTranscript(VTT).cues);
    expect(rows.map((r) => r.speaker)).toEqual(['Dummy Eight', 'Alisa Senior']);
    expect(rows[0].seconds).toBeCloseTo(8);
    expect(rows[0].share + rows[1].share).toBeCloseTo(1);
  });

  it('falls back to word count when there are no timings', () => {
    const rows = talkShare(parseTranscript('A: one two three four\nB: five').cues);
    expect(rows[0].speaker).toBe('A');
    expect(rows[0].share).toBeCloseTo(0.8);
  });

  it('buckets cues with no speaker as Unknown', () => {
    expect(talkShare(parseTranscript('just some words').cues)[0].speaker).toBe('Unknown');
  });
});

describe('formatCueTime', () => {
  it('drops the hour until there is one', () => {
    expect(formatCueTime(0)).toBe('0:00');
    expect(formatCueTime(65)).toBe('1:05');
    expect(formatCueTime(3725)).toBe('1:02:05');
    expect(formatCueTime(-5)).toBe('0:00');
  });
});
