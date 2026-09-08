import { z } from 'zod';

/**
 * What "analysis" means for a meeting in Cadence.
 *
 * Nothing generates this yet: no model is connected. The shape is fixed now so the UI, the
 * database column and the future analyzer all agree, and so that when an open model is wired in
 * it only has to fill this object. Everything is optional: a partial analysis renders fine.
 */

const Timestamped = z.object({
  /** Seconds into the recording, when the analyzer can locate it. */
  at: z.number().min(0).nullable().default(null),
  text: z.string().min(1),
});

export const MeetingAnalysisSchema = z.object({
  /** One-paragraph "what happened and what is next". */
  outcome: z.string().optional(),
  /** Grouped highlights, each with optional timestamps: the spine of the panel. */
  keyPoints: z
    .array(
      z.object({
        topic: z.string().min(1),
        points: z.array(Timestamped).default([]),
      }),
    )
    .default([]),
  /** Commitments made, with an owner where one is identifiable. */
  nextSteps: z.array(z.object({ text: z.string().min(1), owner: z.string().nullable().default(null), due: z.string().nullable().default(null) })).default([]),
  /** Questions the prospect asked that were not answered. */
  openQuestions: z.array(z.string()).default([]),
  /** Objections and risks, so a manager can coach on them. */
  risks: z.array(z.string()).default([]),
  /** Competitors or incumbents mentioned. */
  competitors: z.array(z.string()).default([]),
  /** Overall tone, only when the analyzer is confident. */
  sentiment: z.enum(['positive', 'neutral', 'negative']).nullable().default(null),
  /** Talk-time share per speaker, 0..1. Derived from the transcript when there is no model. */
  talkShare: z.array(z.object({ speaker: z.string(), share: z.number().min(0).max(1) })).default([]),
  /** Free-form extra sections, so a future model can add value without a schema change. */
  sections: z.array(z.object({ title: z.string().min(1), body: z.string().min(1) })).default([]),
  /** Provenance: which model produced this, and how sure it is. */
  model: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  generatedAt: z.string().nullable().default(null),
});

export type MeetingAnalysis = z.infer<typeof MeetingAnalysisSchema>;

export function parseAnalysis(value: unknown): MeetingAnalysis | null {
  if (!value) return null;
  const r = MeetingAnalysisSchema.safeParse(value);
  return r.success ? r.data : null;
}

/** True when there is nothing worth rendering. */
export function isAnalysisEmpty(a: MeetingAnalysis | null): boolean {
  if (!a) return true;
  return !a.outcome && !a.keyPoints.length && !a.nextSteps.length && !a.openQuestions.length && !a.risks.length && !a.sections.length && !a.talkShare.length;
}

// ---------------------------------------------------------------------------
// The analyzer seam
// ---------------------------------------------------------------------------

export type AnalyzerInput = {
  meetingId: string;
  title: string;
  occurredAt: Date;
  /** Transcript text as stored, plus the parsed cues if the caller has them. */
  transcript: string | null;
  attendees: Array<{ name: string | null; email: string | null; external: boolean; host: boolean }>;
  companyName: string | null;
};

/**
 * Implement this to plug a model in. Keep it out of the request path: the worker should call it
 * and write the result back, so a slow model never blocks a page.
 */
export interface MeetingAnalyzer {
  readonly name: string;
  /** False when the analyzer cannot run (no key, no model, empty transcript). */
  canAnalyze(input: AnalyzerInput): boolean;
  analyze(input: AnalyzerInput): Promise<MeetingAnalysis>;
}

/**
 * The analyzer in use today: no model, so it produces only what can be computed from the
 * transcript itself (talk share). Everything else is left for the real model.
 */
export class LocalStatsAnalyzer implements MeetingAnalyzer {
  readonly name = 'local-stats';
  canAnalyze(input: AnalyzerInput): boolean {
    return Boolean(input.transcript && input.transcript.trim().length > 0);
  }
  async analyze(input: AnalyzerInput): Promise<MeetingAnalysis> {
    const { parseTranscript, talkShare } = await import('./transcript');
    const { cues } = parseTranscript(input.transcript ?? '');
    return MeetingAnalysisSchema.parse({
      talkShare: talkShare(cues).map((t) => ({ speaker: t.speaker, share: t.share })),
      model: this.name,
      generatedAt: new Date().toISOString(),
    });
  }
}

let analyzer: MeetingAnalyzer = new LocalStatsAnalyzer();

/** Swap in a model-backed analyzer at boot. */
export function setMeetingAnalyzer(next: MeetingAnalyzer) {
  analyzer = next;
}

export function getMeetingAnalyzer(): MeetingAnalyzer {
  return analyzer;
}
