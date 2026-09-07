'use client';

import { refreshCacheAction, runReconcileAction, runSchedulerAction, testTwentyConnectionAction } from '@/lib/actions/admin';
import { ActionButton, ActionForm } from '@/components/action-form';
import { Card, Field } from '@/components/ui';

export function AdminTools({ defaultDays }: { defaultDays: number }) {
  return (
    <Card title="Maintenance">
      <div className="grid gap-4 p-4 md:grid-cols-3">
        <ActionForm action={runReconcileAction} className="space-y-2">
          <Field label="Reconcile the last N days" hint="Re-scans Twenty notes, messages, opportunities and people; completes anything webhooks missed. Safe to repeat.">
            <input name="days" type="number" min={1} max={90} defaultValue={defaultDays} className="w-24" />
          </Field>
          <button type="submit" className="btn-secondary">
            Run reconcile now
          </button>
        </ActionForm>
        <div className="space-y-2">
          <label className="block">Person cache</label>
          <div className="flex flex-wrap gap-2">
            <ActionButton action={refreshCacheAction} payload={{ full: 'false' }} className="btn-secondary">
              Refresh changed
            </ActionButton>
            <ActionButton action={refreshCacheAction} payload={{ full: 'true' }} className="btn-secondary" confirm="Pull every person and company from Twenty? This can take a while on large workspaces.">
              Full refresh
            </ActionButton>
          </div>
          <p className="text-xs text-ink-500">Also runs nightly and on every person webhook.</p>
        </div>
        <div className="space-y-2">
          <label className="block">Scheduler and connection</label>
          <div className="flex flex-wrap gap-2">
            <ActionButton action={() => runSchedulerAction()} payload={{}} className="btn-secondary">
              Run scheduler tick
            </ActionButton>
            <ActionButton action={() => testTwentyConnectionAction()} payload={{}} className="btn-secondary">
              Test Twenty connection
            </ActionButton>
          </div>
          <p className="text-xs text-ink-500">The worker container does this automatically every few minutes.</p>
        </div>
      </div>
    </Card>
  );
}
