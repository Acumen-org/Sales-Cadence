'use client';

import { copyExistingRecordingsAction, saveMeetingLibraryAction } from '@/lib/actions/sign-in';
import { ActionButton, ActionForm } from '@/components/action-form';
import { Field } from '@/components/ui';

/** Where Teams recordings are copied to, and the button that queues the ones already in Cadence. */
export function MeetingLibraryForm({ siteUrl, ready }: { siteUrl: string; ready: boolean }) {
  return (
    <div className="space-y-3 border-t border-line p-4">
      <ActionForm action={saveMeetingLibraryAction} className="flex flex-wrap items-end gap-3">
        <Field label="Library site address" className="min-w-[320px] flex-1">
          <input name="siteUrl" defaultValue={siteUrl} placeholder="https://contoso.sharepoint.com/sites/MeetingRecordings" autoComplete="off" spellCheck={false} className="w-full font-mono text-[12.5px]" />
        </Field>
        <button type="submit" className="btn-primary">Save and check</button>
      </ActionForm>
      {ready ? <ActionButton action={copyExistingRecordingsAction} payload={{}} className="btn-secondary btn-sm">Copy existing recordings</ActionButton> : null}
    </div>
  );
}
