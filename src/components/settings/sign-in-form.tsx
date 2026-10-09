'use client';

import { saveSignInSettingsAction } from '@/lib/actions/sign-in';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/ui';

export function SignInForm({ clientId, tenantId, hasSecret }: { clientId: string; tenantId: string; hasSecret: boolean }) {
  return (
    <ActionForm action={saveSignInSettingsAction} className="space-y-4 p-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Application (client) ID">
          <input name="microsoftClientId" defaultValue={clientId} autoComplete="off" spellCheck={false} className="w-full font-mono text-[12.5px]" />
        </Field>
        <Field label="Directory (tenant) ID">
          <input name="microsoftTenantId" defaultValue={tenantId} autoComplete="off" spellCheck={false} className="w-full font-mono text-[12.5px]" />
        </Field>
        <Field label="Client secret value">
          <input name="microsoftClientSecret" type="password" autoComplete="off" className="w-full" placeholder={hasSecret ? '(unchanged)' : ''} />
        </Field>
      </div>
      {hasSecret ? (
        <label className="flex items-center gap-2 text-sm font-normal text-ink-700">
          <input type="checkbox" name="clearSecret" className="h-4 w-4 rounded" />
          Remove the stored secret
        </label>
      ) : null}
      <button type="submit" className="btn-primary">Save sign-in</button>
    </ActionForm>
  );
}
