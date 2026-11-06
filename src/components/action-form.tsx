'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import type { ActionResult } from '@/lib/actions/users';
import { useConfirm, type ConfirmOptions } from '@/components/confirm-dialog';
import { useFlash } from '@/components/flash';

type Props = {
  action: (formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
  /** Reset the form fields after a successful submit. */
  resetOnSuccess?: boolean;
  /** Asked first, in the one ConfirmDialog, with a title and what happens (PLAN 4.0); a reason it asks for is sent as `reason`. */
  confirm?: ConfirmOptions;
  onSuccess?: (r: Extract<ActionResult, { ok: true }>) => void;
};

/**
 * Form wrapper for server actions that return ActionResult. Shows the outcome inline,
 * disables the submit while pending, and optionally asks for confirmation first.
 */
export function ActionForm({ action, children, className, resetOnSuccess, confirm, onSuccess }: Props) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [ask, dialog] = useConfirm();
  return (
    <form
      className={clsx(pending && 'opacity-70')}
      // B203: an error is about what was typed, so it goes as soon as the fields change.
      onInput={() => { if (result && !result.ok) setResult(null); }}
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        if (confirm) {
          const answer = await ask(confirm);
          if (!answer) return;
          if (answer.reason) fd.set('reason', answer.reason);
        }
        start(async () => {
          try {
            const r = await action(fd);
            setResult(r);
            if (r.ok) {
              if (resetOnSuccess) form.reset();
              onSuccess?.(r);
            }
          } catch (err) {
            setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        });
      }}
    >
      {/*
        The fieldset only exists to disable the controls while pending, so it is display:contents.
        The caller's classes go on a real element inside it: a `space-y-*` on the <form> would have
        no effect, because the fieldset is the form's only child.
      */}
      <fieldset disabled={pending} className="contents">
        <div className={className}>
          {children}
          {result && (result.ok ? result.message : result.error) ? (
            <p className={clsx('text-xs', result.ok ? 'text-emerald-700' : 'text-red-700')} role="status">
              {result.ok ? result.message ?? 'Done.' : result.error}
            </p>
          ) : null}
        </div>
      </fieldset>
      {dialog}
    </form>
  );
}

/** Minimal button that runs a server action with a fixed payload (e.g. a row action). */
export function ActionButton({
  action,
  payload,
  children,
  className = 'btn-secondary btn-sm',
  confirm,
  title,
  refresh = false,
  flash = false,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  payload: Record<string, string>;
  children: ReactNode;
  className?: string;
  /** Asked first, in the one ConfirmDialog, with a title and what happens (PLAN 4.0); a reason it asks for is sent as `reason`. */
  confirm?: ConfirmOptions;
  title?: string;
  /** Re-read the page after it worked, for a page whose answer to the action can arrive late. */
  refresh?: boolean;
  /**
   * Say the result in the page's `?flash=` toast instead of under the button (B148): for a button the
   * re-read page no longer draws (Claim, Pause), whose message would otherwise vanish with it.
   */
  flash?: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const router = useRouter();
  const say = useFlash();
  const [ask, dialog] = useConfirm();
  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        title={title}
        className={className}
        disabled={pending}
        onClick={async () => {
          const fd = new FormData();
          for (const [k, v] of Object.entries(payload)) fd.set(k, v);
          if (confirm) {
            const answer = await ask(confirm);
            if (!answer) return;
            if (answer.reason) fd.set('reason', answer.reason);
          }
          start(async () => {
            try {
              const r = await action(fd);
              if (flash) {
                say(r.ok ? r.message ?? 'Done.' : r.error, r.ok ? 'ok' : 'error', r.ok ? r.redirectTo : undefined);
                return;
              }
              setResult(r);
              // Deleting a record leaves the user on a URL that no longer resolves, so an action
              // that says where to go next is followed here rather than only by forms.
              if (r.ok && r.redirectTo) router.push(r.redirectTo);
              else if (r.ok && refresh) router.refresh();
            } catch (err) {
              setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
            }
          });
        }}
      >
        {children}
      </button>
      {result ? <span role="status" className={clsx('mt-1 text-xs', result.ok ? 'text-brand-700' : 'text-red-700')}>{result.ok ? result.message ?? 'Done.' : result.error}</span> : null}
      {dialog}
    </span>
  );
}
