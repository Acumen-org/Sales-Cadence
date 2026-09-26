import type { AnalysisStatus } from '@prisma/client';
import { formatCueTime } from '@/lib/meetings/transcript';
import { getMeetingAnalyzer, isAnalysisEmpty, type MeetingAnalysis } from '@/lib/meetings/analysis';
import { ActionButton } from '@/components/action-form';
import { analyseMeetingAction } from '@/lib/actions/meetings';
import { Badge, Notice, RecordFields, Surface } from '@/components/ui';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { barColour } from '@/lib/bar-colour';
import { formatInstant } from '@/lib/dates';
import { AssistantHeader } from '@/components/assistant';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3.5 last:border-b-0">
      <h3 className="mb-2 text-sm font-semibold text-ink-900">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The analysis panel. No language model is connected yet, so this renders whatever an analyzer has
 * written and otherwise explains what will appear here. The shape it reads is fixed
 * (src/lib/meetings/analysis.ts), so connecting a model later needs no UI change.
 */
export async function MeetingAnalysisPanel({
  talkShare: liveTalk = [],
  meetingId,
  analysis,
  status,
  model,
  analysedAt,
  error,
  hasTranscript,
  canRun,
}: {
  meetingId: string;
  analysis: MeetingAnalysis | null;
  status: AnalysisStatus;
  model: string | null;
  analysedAt: Date | null;
  error: string | null;
  hasTranscript: boolean;
  canRun: boolean;
  /** Who spoke how much, computed from the transcript as it stands. */
  talkShare?: Array<{ speaker: string; seconds: number; words: number; share: number }>;
}) {
  const empty = isAnalysisEmpty(analysis);
  const user = await requireUser();
  const analyzer = getMeetingAnalyzer();
  const configured = analyzer.name !== 'local-stats';
  const statisticsOnly = model === 'local-stats';

  return (
    <Surface flush>
      <AssistantHeader
        connected={configured ? true : isAdmin(user) ? false : null}
        right={canRun && hasTranscript && status !== 'PENDING' ? <ActionButton action={analyseMeetingAction} payload={{ meetingId }} className="btn-secondary btn-sm">{configured ? 'Analyse meeting' : 'Measure talk time'}</ActionButton> : null}
      />
      {status === 'PENDING' ? <div role="status" className="border-b border-line p-4"><Badge tone="amber">Analysis in progress</Badge></div> : null}

      {error ? (
        <div className="px-4 pt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}

      {empty ? (
        <TalkTime rows={liveTalk} />
      ) : (
        <>
          {analysis!.outcome ? (
            <Section title="Outcome">
              <p className="text-sm leading-7 text-ink-800">{analysis!.outcome}</p>
            </Section>
          ) : null}

          {analysis!.keyPoints.length ? (
            <Section title="Key points">
              <div className="space-y-3">
                {analysis!.keyPoints.map((g) => (
                  <div key={g.topic}>
                    <div className="text-sm font-medium text-ink-900">{g.topic}</div>
                    <ul className="mt-1 space-y-1.5">
                      {g.points.map((pt, i) => (
                        <li key={i} className="flex gap-2.5 text-sm">
                          {pt.at !== null ? <span className="shrink-0 font-mono text-xs font-medium text-ink-900">{formatCueTime(pt.at)}</span> : null}
                          <span className="text-ink-700">{pt.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Section>
          ) : null}

          {analysis!.nextSteps.length ? (
            <Section title="Next steps">
              <ul className="space-y-1.5">
                {analysis!.nextSteps.map((step, index) => <li key={index} className="rounded-lg border border-line p-3"><div className="mb-3 text-sm font-medium text-ink-900">{step.text}</div><RecordFields items={[{ label: 'Owner', value: step.owner }, { label: 'Due', value: step.due }]} /></li>)}
              </ul>
            </Section>
          ) : null}

          {analysis!.openQuestions.length ? (
            <Section title="Open questions">
              <ul className="space-y-1 text-sm text-ink-700">
                {analysis!.openQuestions.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </Section>
          ) : null}

          {analysis!.risks.length || analysis!.competitors.length ? (
            <Section title="Risks and competitors">
              {analysis!.risks.length ? (
                <ul className="space-y-1 text-sm text-ink-700">
                  {analysis!.risks.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              ) : null}
              {analysis!.competitors.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {analysis!.competitors.map((c) => (
                    <Badge key={c} tone="amber">
                      {c}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </Section>
          ) : null}

          {(liveTalk.length ? liveTalk : analysis!.talkShare).length ? (
            <Section title="Talk time">
              <ul className="space-y-2">
                {(liveTalk.length ? liveTalk : analysis!.talkShare).map((t) => (
                  <li key={t.speaker}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate text-ink-700">{t.speaker}</span>
                      <span className="font-medium text-ink-900">{Math.round(t.share * 100)}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-canvas">
                      <div className="h-full rounded-full" style={{ width: `${Math.round(t.share * 100)}%`, background: barColour(t.share) }} />
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {analysis!.sections.map((s) => (
            <Section key={s.title} title={s.title}>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-700">{s.body}</p>
            </Section>
          ))}

          {statisticsOnly ? null : <Section title="Analysis details"><RecordFields items={[{ label: statisticsOnly ? 'Method' : 'Model', value: statisticsOnly ? 'Computed from transcript timestamps' : model }, { label: 'Generated', value: analysedAt ? formatInstant(analysedAt, user.timezone) : null }, { label: 'Confidence', value: analysis!.confidence !== null ? `${Math.round(analysis!.confidence * 100)}%` : null }]} /></Section>}
        </>
      )}
    </Surface>
  );
}

/** Who spoke how much, as the transcript shows it, when no model has read the meeting yet. */
function TalkTime({ rows }: { rows: Array<{ speaker: string; seconds: number; words: number; share: number }> }) {
  if (!rows.length) return null;
  return (
    <Section title="Talk time">
      <ul className="space-y-2">
        {rows.map((t) => (
          <li key={t.speaker}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate text-ink-700">{t.speaker}</span>
              <span className="font-medium text-ink-900">{Math.round(t.share * 100)}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-canvas">
              <div className="h-full rounded-full" style={{ width: `${Math.round(t.share * 100)}%`, background: barColour(t.share) }} />
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
