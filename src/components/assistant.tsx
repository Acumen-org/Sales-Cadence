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
 * The body of a panel whose header already says "Not connected": nothing to read, only the way
 * to Settings for someone who can change that. `does` stays in the signature because Settings
 * lists the assistant's jobs in full; a panel an FO looks past every day does not.
 */
export function AssistantNotConnected({ canConfigure }: { does: string[]; canConfigure: boolean }) {
  if (!canConfigure) return null;
  return (
    <div className="flex items-center justify-end px-4 py-2.5">
      <Link href={`/settings?tab=${ASSISTANT_SETTINGS_TAB}`} className="text-[12px] font-medium text-brand-700 hover:underline">Settings</Link>
    </div>
  );
}
