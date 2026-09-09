import Link from 'next/link';
import { IconAssistant } from '@/components/icons';
import { Badge } from '@/components/ui';
import { ASSISTANT_NAME, ASSISTANT_SETTINGS_TAB } from '@/lib/workspace';

/**
 * One presentation for everything the assistant does, so it reads as a single feature rather
 * than three unrelated boxes: the meeting analysis, the suggested approach on a task, and the
 * enrichment suggestions all use this header and this "not connected" state.
 *
 * The badge is the honest part. Until a model provider is configured the panel says so and
 * lists what will appear, rather than showing an empty box or a fabricated summary.
 */
export function AssistantHeader({ connected, right }: { connected: boolean; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
          <IconAssistant size={15} />
        </span>
        <h2 className="text-[14px] font-semibold text-ink-900">{ASSISTANT_NAME}</h2>
        <Badge tone={connected ? 'green' : 'gray'}>{connected ? 'Connected' : 'Not connected'}</Badge>
      </div>
      {right}
    </div>
  );
}

/**
 * What this panel will do once a provider is connected: one line, then the action. `does` still
 * takes the full list because Settings shows it in full, but a panel an FO looks past every day
 * says the state and offers the fix rather than selling the feature.
 */
export function AssistantNotConnected({ does, canConfigure }: { does: string[]; canConfigure: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 p-4">
      <p className="min-w-0 flex-1 text-sm text-ink-600">
        {does[0] ?? `${ASSISTANT_NAME} is ready`}. Connect a model provider to turn it on.
      </p>
      {canConfigure ? (
        <Link href={`/settings?tab=${ASSISTANT_SETTINGS_TAB}`} className="btn-secondary btn-sm shrink-0">
          Connect a provider
        </Link>
      ) : null}
    </div>
  );
}
