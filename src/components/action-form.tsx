'use client';

import { useState, useTransition, type ReactNode } from 'react';
import clsx from 'clsx';
import type { ActionResult } from '@/lib/actions/users';

type Props = {
  action: (formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
  /** Reset the form fields after a successful submit. */
  resetOnSuccess?: boolean;
  confirm?: string;
  onSuccess?: (r: Extract<ActionResult, { ok: true }>) => void;
};

/**
 * Form wrapper for server actions that return ActionResult. Shows the outcome inline,
 * disables the submit while pending, and optionally asks for confirmation first.
 */
export function ActionForm({ action, children, className, resetOnSuccess, confirm, onSuccess }: Props) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <form
      className={clsx(pending && 'opacity-70')}
      onSubmit={(e) => {
        e.preventDefault();
        if (confirm && !window.confirm(confirm)) return;
        const form = e.currentTarget;
        const fd = new FormData(form);
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
          {result ? (
            <p className={clsx('text-xs', result.ok ? 'text-emerald-700' : 'text-red-700')} role="status">
              {result.ok ? result.message ?? 'Done.' : result.error}
            </p>
          ) : null}
        </div>
      </fieldset>
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
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  payload: Record<string, string>;
  children: ReactNode;
  className?: string;
  confirm?: string;
  title?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        title={title}
        className={className}
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          const fd = new FormData();
          for (const [k, v] of Object.entries(payload)) fd.set(k, v);
          start(async () => {
            try {
              const r = await action(fd);
              setError(r.ok ? null : r.error);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          });
        }}
      >
        {children}
      </button>
      {error ? <span className="mt-1 text-xs text-red-700">{error}</span> : null}
    </span>
  );
}
