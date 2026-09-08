/**
 * Transcript parsing. Teams, Zoom and Meet all export WebVTT or SRT; people also paste plain
 * text. One parser handles all three and yields timestamped cues with an optional speaker.
 */
export type TranscriptCue = { start: number; end: number | null; speaker: string | null; text: string };
export type TranscriptFormat = 'vtt' | 'srt' | 'text';

const TIME = /(\d{1,2}):(\d{2})(?::(\d{2}))?[.,](\d{1,3})/;
const RANGE = new RegExp(`${TIME.source}\\s*-->\\s*${TIME.source}`);
/** WebVTT voice span: `<v Alisa Senior>`, optionally with classes (`<v.loud Alisa>`). */
const VOICE = /^\s*<v(?:\.[^\s>]+)*\s+([^>]*)>\s*/i;
/** "Speaker Name: words" at the start of a cue. One letter is a valid name ("A: yes"). */
const SPEAKER = /^\s*([\p{Lu}][\p{L}\p{N} .''&/-]{0,48}?)\s*:\s+(?=\S)/u;
/** A leading timestamp on a pasted line: `[00:01:02]`, `(1:02)` or `00:01:02`. */
const LEAD_TIME = /^\s*[[(]?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?[\])]?[\s-]+/;

function seconds(h: string, m: string, s: string | undefined, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s ?? 0) + Number(ms.padEnd(3, '0')) / 1000;
}

/**
 * Pull the speaker off the front of a cue: a WebVTT voice span first, then a "Name:" prefix.
 * A "Name:" prefix of more than five words is prose, not a speaker, so it is left alone.
 */
function splitSpeaker(body: string): { speaker: string | null; text: string } {
  let rest = body;
  let speaker: string | null = null;
  const voice = VOICE.exec(rest);
  if (voice) {
    speaker = voice[1].trim() || null;
    rest = rest.slice(voice[0].length);
  }
  if (!speaker) {
    const m = SPEAKER.exec(rest);
    if (m && m[1].trim().split(/\s+/).length <= 5) {
      speaker = m[1].trim();
      rest = rest.slice(m[0].length);
    }
  }
  return { speaker, text: rest };
}

export function detectTranscriptFormat(raw: string): TranscriptFormat {
  const head = raw.slice(0, 400);
  if (/^﻿?WEBVTT/i.test(head.trimStart())) return 'vtt';
  if (RANGE.test(head)) return /^\s*\d+\s*$/m.test(head) ? 'srt' : 'vtt';
  return 'text';
}

/** Strip the tags Teams/Stream leave in VTT cues. */
function clean(text: string): string {
  return text
    .replace(/<\/?v[^>]*>/gi, '')
    .replace(/<\/?[cibu][^>]*>/gi, '')
    .replace(/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseTranscript(raw: string, format?: TranscriptFormat): { format: TranscriptFormat; cues: TranscriptCue[] } {
  const text = (raw ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return { format: 'text', cues: [] };
  const fmt = format ?? detectTranscriptFormat(text);

  if (fmt === 'text') {
    // Plain paste: one cue per non-empty line. A leading [00:01:02] is kept as the cue time,
    // which is how Zoom, Otter and "copy transcript" in Teams format their text export.
    const cues = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map<TranscriptCue>((line) => {
        let start = 0;
        let rest = line;
        const t = LEAD_TIME.exec(rest);
        if (t) {
          // Two parts is mm:ss, three is hh:mm:ss.
          start = t[3] ? seconds(t[1], t[2], t[3], t[4] ?? '0') : seconds('0', t[1], t[2], t[4] ?? '0');
          rest = rest.slice(t[0].length);
        }
        const { speaker, text: body } = splitSpeaker(rest);
        return { start, end: null, speaker, text: clean(body) || rest.trim() };
      });
    return { format: 'text', cues };
  }

  const cues: TranscriptCue[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const rangeLine = lines.find((l) => RANGE.test(l));
    if (!rangeLine) continue;
    const m = RANGE.exec(rangeLine)!;
    const start = seconds(m[1], m[2], m[3], m[4]);
    const end = seconds(m[5], m[6], m[7], m[8]);
    const body = lines
      .filter((l) => l !== rangeLine && !/^\s*\d+\s*$/.test(l) && !/^WEBVTT/i.test(l) && !/^(NOTE|STYLE|REGION)\b/i.test(l))
      .join(' ');
    const { speaker, text: spoken } = splitSpeaker(body);
    const cueText = clean(spoken);
    if (cueText) cues.push({ start, end, speaker, text: cueText });
  }
  // Merge consecutive cues from the same speaker so the panel reads like a conversation.
  const merged: TranscriptCue[] = [];
  for (const c of cues) {
    const prev = merged[merged.length - 1];
    if (prev && prev.speaker && prev.speaker === c.speaker && c.start - (prev.end ?? c.start) < 2) {
      prev.text = `${prev.text} ${c.text}`.trim();
      prev.end = c.end;
    } else merged.push({ ...c });
  }
  return { format: fmt, cues: merged };
}

export function formatCueTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Speaking share per speaker, by cue duration (or word count when there are no timings). */
export function talkShare(cues: TranscriptCue[]): Array<{ speaker: string; seconds: number; words: number; share: number }> {
  const by = new Map<string, { seconds: number; words: number }>();
  for (const c of cues) {
    const key = c.speaker ?? 'Unknown';
    const row = by.get(key) ?? { seconds: 0, words: 0 };
    row.seconds += c.end && c.end > c.start ? c.end - c.start : 0;
    row.words += c.text.split(/\s+/).filter(Boolean).length;
    by.set(key, row);
  }
  const rows = [...by.entries()].map(([speaker, v]) => ({ speaker, ...v }));
  const totalSeconds = rows.reduce((a, r) => a + r.seconds, 0);
  const totalWords = rows.reduce((a, r) => a + r.words, 0);
  return rows
    .map((r) => ({ ...r, share: totalSeconds > 0 ? r.seconds / totalSeconds : totalWords > 0 ? r.words / totalWords : 0 }))
    .sort((a, b) => b.share - a.share);
}
