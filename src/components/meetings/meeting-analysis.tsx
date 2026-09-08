import type { AnalysisStatus } from '@prisma/client';
import { formatCueTime } from '@/lib/meetings/transcript';
import { isAnalysisEmpty, type MeetingAnalysis } from '@/lib/meetings/analysis';
import { IconBolt, IconInfo } from '@/components/icons';
import { ActionButton } from '@/components/action-form';
import { analyseMeetingAction } from '@/lib/actions/meetings';
import { Badge, Notice, Surface } from '@/components/ui';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3.5 last:border-b-0">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The analysis panel. No language model is connected yet, so this renders whatever an analyzer has
 * written and otherwise explains what will appear here. The shape it reads is fixed
 * (src/lib/meetings/analysis.ts), so connecting a model later needs no UI change.
 */
export function MeetingAnalysisPanel({
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
}) {
  const empty = isAnalysisEmpty(analysis);

  return (
    <Surface flush>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <IconBolt size={15} />
          </span>
          <h2 className="text-[14px] font-semibold text-ink-900">Analysis</h2>
          {status === 'READY' ? <Badge tone="green">ready</Badge> : status === 'PENDING' ? <Badge tone="amber">running</Badge> : status === 'FAILED' ? <Badge tone="red">failed</Badge> : null}
        </div>
        {canRun ? (
          <ActionButton action={analyseMeetingAction} payload={{ meetingId }} className="btn-secondary btn-sm" title="Run the configured analyzer">
            {status === 'READY' ? 'Re-run' : 'Run'}
          </ActionButton>
        ) : null}
      </div>

      {error ? (
        <div className="px-4 pt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}

      {empty ? (
        <div className="space-y-3 px-4 py-4">
          <div className="flex items-start gap-2.5 rounded-xl border border-brand-100 bg-brand-50/60 px-3.5 py-3">
            <IconInfo size={15} className="mt-0.5 shrink-0 text-brand-600" />
            <div className="text-[12.5px] leading-relaxed text-brand-900">
              <p className="font-medium">No analysis yet</p>
              <p className="mt-0.5 text-brand-800">
                No language model is connected. {hasTranscript ? 'Run the analyzer for talk-time statistics now,' : 'Add a transcript,'} and when an open model is wired in it will fill this panel.
              </p>
            </div>
          </div>
          <div>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">What will appear here</h3>
            <ul className="space-y-1 text-[12.5px] text-ink-500">
              {[
                'Outcome: what happened and what happens next',
                'Key points grouped by topic, with timestamps',
                'Next steps and who owns them',
                'Questions left unanswered',
                'Objections, risks and competitors mentioned',
                'Talk-time share per speaker',
              ].map((t) => (
                <li key={t} className="flex gap-2">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-300" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <>
          {analysis!.outcome ? (
            <Section title="Outcome">
              <p className="text-[13px] leading-relaxed text-ink-700">{analysis!.outcome}</p>
            </Section>
          ) : null}

          {analysis!.keyPoints.length ? (
            <Section title="Key points">
              <div className="space-y-3">
                {analysis!.keyPoints.map((g) => (
                  <div key={g.topic}>
                    <div className="text-[12.5px] font-medium text-ink-900">{g.topic}</div>
                    <ul className="mt-1 space-y-1.5">
                      {g.points.map((pt, i) => (
                        <li key={i} className="flex gap-2.5 text-[12.5px]">
                          {pt.at !== null ? <span className="shrink-0 font-mono text-[11px] text-ink-400">{formatCueTime(pt.at)}</span> : null}
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
                {analysis!.nextSteps.map((s, i) => (
                  <li key={i} className="text-[12.5px] text-ink-700">
                    {s.text}
                    {s.owner ? <span className="text-ink-400"> · {s.owner}</span> : null}
                    {s.due ? <span className="text-ink-400"> · {s.due}</span> : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {analysis!.openQuestions.length ? (
            <Section title="Open questions">
              <ul className="space-y-1 text-[12.5px] text-ink-700">
                {analysis!.openQuestions.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </Section>
          ) : null}

          {analysis!.risks.length || analysis!.competitors.length ? (
            <Section title="Risks and competitors">
              {analysis!.risks.length ? (
                <ul className="space-y-1 text-[12.5px] text-ink-700">
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

          {analysis!.talkShare.length ? (
            <Section title="Talk time">
              <ul className="space-y-2">
                {analysis!.talkShare.map((t) => (
                  <li key={t.speaker}>
                    <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                      <span className="truncate text-ink-700">{t.speaker}</span>
                      <span className="font-medium text-ink-900">{Math.round(t.share * 100)}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-canvas">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.round(t.share * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {analysis!.sections.map((s) => (
            <Section key={s.title} title={s.title}>
              <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-700">{s.body}</p>
            </Section>
          ))}

          <Section title="Provenance">
            <p className="text-[11.5px] text-ink-400">
              {model ? `Model: ${model}. ` : ''}
              {analysedAt ? `Generated ${analysedAt.toLocaleString('en-GB')}.` : ''}
              {analysis!.confidence !== null ? ` Confidence ${Math.round(analysis!.confidence * 100)}%.` : ''}
            </p>
          </Section>
        </>
      )}
    </Surface>
  );
}
