'use client';

import { ActionButton, ActionForm } from '@/components/action-form';
import { applyNeverProspectRuleAction, saveNonProspectRulesAction } from '@/lib/actions/settings';
import { Card, Field } from '@/components/ui';

type Rules = { neverProspectDomains: string[]; neverProspectNames: string[]; notAccountDomains: string[]; neverProspectExceptions: string[] };

/**
 * The two lists behind automatic blocking: organisations that are never prospects (blocked with
 * their people) and free-mail domains that are not accounts (hidden from Accounts, people kept).
 */
export function NonProspectRulesForm({ rules, exceptions }: { rules: Rules; exceptions: { id: string; name: string }[] }) {
  return (
    <Card title="Rules" actions={<ActionButton action={applyNeverProspectRuleAction} payload={{}} className="btn-secondary btn-sm">Apply now</ActionButton>}>
      <ActionForm action={saveNonProspectRulesAction} className="space-y-4 p-4">
        <Field label="Never prospects - domains">
          <textarea name="neverProspectDomains" rows={3} defaultValue={rules.neverProspectDomains.join(', ')} className="w-full" />
        </Field>
        <Field label="Never prospects - names">
          <textarea name="neverProspectNames" rows={3} defaultValue={rules.neverProspectNames.join(', ')} className="w-full" />
        </Field>
        <Field label="Not accounts - personal email domains">
          <textarea name="notAccountDomains" rows={3} defaultValue={rules.notAccountDomains.join(', ')} className="w-full" />
        </Field>
        {exceptions.length ? (
          <Field label="Exceptions">
            <ul className="flex flex-wrap gap-1.5 text-[12.5px] text-ink-700">{exceptions.map((e) => <li key={e.id} className="chip-muted">{e.name}</li>)}</ul>
          </Field>
        ) : null}
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary btn-sm">Save rules</button>
        </div>
      </ActionForm>
    </Card>
  );
}
