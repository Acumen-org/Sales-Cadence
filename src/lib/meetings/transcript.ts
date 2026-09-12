/**
 * Transcript parsing. Teams, Zoom and Meet export WebVTT or SRT; Teams also offers a JSON export
 * and a copy-to-clipboard "grouped" text (speaker and time on one line, words beneath); people
 * paste plain text. One parser handles all of them and yields timestamped cues with an optional
 * speaker - the dialogue only, never the ids, confidences and offsets an export carries.
 */
export type TranscriptCue = { start: number; end: number | null; speaker: string | null; text: string };
export type TranscriptFormat = 'vtt' | 'srt' | 'json' | 'text';

/** Teams' grouped text: `Alisa Senior   0:12` (or the time first), then the words on the next lines. */
const GROUP_HEADER = /^(?:(.{1,60}?)\s{2,}(\d{1,2}:\d{2}(?::\d{2})?)|(\d{1,2}:\d{2}(?::\d{2})?)\s{2,}(.{1,60}?))\s*$/;

const TIME = /(\d{1,2}):(\d{2})(?::(\d{2}))?[.,](\d{1,3})/;
const RANGE = new RegExp(`${TIME.source}\\s*-->\\s*${TIME.source}`);
/** WebVTT voice span: `<v Alisa Senior>`, optionally with classes (`<v.loud Alisa>`). */
const VOICE = /^\s*<v(?:\.[^\s>]+)*\s+([^>]*)>\s*/i;
/** "Speaker Name: words" at the start of a cue. One letter is a valid name ("A: yes"). */
// A name may carry a bracketed affiliation or role - "Jeff Pieta (AIS):" - which Teams writes for
// guests; without the brackets those lines fell to "Unknown" and took most of the talk time.
const SPEAKER = /^\s*([\p{Lu}][\p{L}\p{N} .''&/(),-]{0,60}?)\s*:\s+(?=\S)/u;
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
  if (/^﻿?\s*[\[{]/.test(head) && parseJsonEntries(raw) !== null) return 'json';
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

  if (fmt === 'json') {
    const entries = parseJsonEntries(text) ?? [];
    return { format: 'json', cues: mergeSpeakers(entries) };
  }

  if (fmt === 'text') {
    const grouped = parseGroupedText(text);
    if (grouped) return { format: 'text', cues: mergeSpeakers(grouped) };
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
  return { format: fmt, cues: mergeSpeakers(cues) };
}

/** Merge consecutive cues from the same speaker so the panel reads like a conversation. */
function mergeSpeakers(cues: TranscriptCue[]): TranscriptCue[] {
  const merged: TranscriptCue[] = [];
  for (const c of cues) {
    const prev = merged[merged.length - 1];
    if (prev && prev.speaker && prev.speaker === c.speaker && c.start - (prev.end ?? c.start) < 2) {
      prev.text = `${prev.text} ${c.text}`.trim();
      prev.end = c.end;
    } else merged.push({ ...c });
  }
  return merged;
}

/** "0:12", "00:01:02.500", 12.5 (seconds) or 12500 (milliseconds, when it is too large to be seconds). */
function anyTime(v: unknown, millis = false): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return millis || v > 100_000 ? v / 1000 : v;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  const clock = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,7}))?$/.exec(t);
  if (clock) return seconds(clock[1] ?? '0', clock[2], clock[3], (clock[4] ?? '0').slice(0, 3));
  const n = Number(t);
  return Number.isFinite(n) ? (millis || n > 100_000 ? n / 1000 : n) : null;
}

const TEXT_KEYS = ['text', 'content', 'transcript', 'utterance', 'displayText', 'sentence', 'words'];
const SPEAKER_KEYS = ['speakerDisplayName', 'speakerName', 'speaker', 'participant', 'participantName', 'name', 'speakerId'];
const START_KEYS = ['startOffset', 'start', 'startTime', 'offset', 'timestamp', 'begin', 'from'];
const END_KEYS = ['endOffset', 'end', 'endTime', 'to'];

/**
 * Dialogue out of a JSON export. Teams (`{ entries: [{ text, speakerDisplayName, startOffset }] }`),
 * Zoom and the generic array-of-utterances shapes all reduce to: find the array, take each
 * entry's words, who said them and when. Anything else in the file is left where it is.
 */
export function parseJsonEntries(raw: string): TranscriptCue[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw.replace(/^\﻿/, ''));
  } catch {
    return null;
  }
  const pick = (o: Record<string, unknown>, keys: string[]): unknown => {
    for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    return undefined;
  };
  const findArray = (v: unknown, depth = 0): unknown[] | null => {
    if (Array.isArray(v)) return v;
    if (!v || typeof v !== 'object' || depth > 3) return null;
    const o = v as Record<string, unknown>;
    for (const k of ['entries', 'transcript', 'cues', 'segments', 'results', 'items', 'data', 'utterances', 'sentences', 'phrases']) {
      const found = findArray(o[k], depth + 1);
      if (found) return found;
    }
    return null;
  };
  const entries = findArray(data);
  if (!entries) return null;
  // Offsets given as whole numbers with any of them at 1000 or more are milliseconds (Zoom,
  // AssemblyAI); seconds come as decimals or as clock strings.
  const numeric = entries
    .flatMap((e) => (e && typeof e === 'object' ? [...START_KEYS, ...END_KEYS].map((k) => (e as Record<string, unknown>)[k]) : []))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const millis = numeric.length > 0 && numeric.every((v) => Number.isInteger(v)) && numeric.some((v) => v >= 1000);
  const cues: TranscriptCue[] = [];
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    let text = pick(o, TEXT_KEYS);
    if (Array.isArray(text)) text = text.map((w) => (typeof w === 'string' ? w : (w as Record<string, unknown>)?.text ?? (w as Record<string, unknown>)?.word ?? '')).join(' ');
    if (typeof text !== 'string' || !text.trim()) continue;
    const speakerRaw = pick(o, SPEAKER_KEYS);
    const speaker = typeof speakerRaw === 'string' ? speakerRaw.trim() || null : speakerRaw && typeof speakerRaw === 'object' ? String((speakerRaw as Record<string, unknown>).name ?? (speakerRaw as Record<string, unknown>).displayName ?? '').trim() || null : null;
    const start = anyTime(pick(o, START_KEYS), millis) ?? 0;
    const end = anyTime(pick(o, END_KEYS), millis);
    cues.push({ start, end, speaker, text: clean(text) });
  }
  return cues.length ? cues : null;
}

/** Teams' copied transcript: a header line per turn, words beneath. Null unless the text is shaped that way. */
function parseGroupedText(text: string): TranscriptCue[] | null {
  const lines = text.split('\n');
  const headers = lines.filter((l) => GROUP_HEADER.test(l)).length;
  if (headers < 2) return null;
  const cues: TranscriptCue[] = [];
  let current: TranscriptCue | null = null;
  for (const line of lines) {
    const h = GROUP_HEADER.exec(line);
    if (h) {
      if (current && current.text) cues.push(current);
      const speaker = (h[1] ?? h[4] ?? '').trim() || null;
      const start = anyTime(h[2] ?? h[3]) ?? 0;
      current = { start, end: null, speaker, text: '' };
    } else if (current && line.trim()) {
      current.text = `${current.text} ${clean(line)}`.trim();
    }
  }
  if (current && current.text) cues.push(current);
  return cues.length ? cues : null;
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
