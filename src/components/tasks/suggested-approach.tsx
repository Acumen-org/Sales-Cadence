import { getMeetingAnalyzer } from '@/lib/meetings/analysis';
import { AssistantHeader, AssistantNotConnected } from '@/components/assistant';
import { Surface } from '@/components/ui';

/**
 * The assistant's place on the task screen. Everything it would need is already on this page -
 * the person's record, the whole history, the message being written - so the only thing missing
 * is a model. Until one is connected this states that plainly rather than showing an empty box.
 */
export function SuggestedApproach({ canConfigure }: { canConfigure: boolean }) {
  const connected = getMeetingAnalyzer().name !== 'local-stats';
  return (
    <Surface flush>
      <AssistantHeader connected={connected} />
      {connected ? (
        <div className="p-4 text-sm text-ink-600">No suggestion for this task yet.</div>
      ) : (
        <AssistantNotConnected
          canConfigure={canConfigure}
          does={[
            'Reads what has and has not worked with this person',
            'Suggests an angle from their replies, notes and meetings',
            'Drafts a message you can accept into the composer',
          ]}
        />
      )}
    </Surface>
  );
}
