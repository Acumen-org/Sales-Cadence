'use client';

import { useActionState } from 'react';
import { loginAction, type LoginState } from '@/lib/actions/auth';

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, undefined);
  return (
    <form action={action} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div className="space-y-1">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required className="w-full" placeholder="you@company.com" />
      </div>
      <div className="space-y-1">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="w-full" />
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-700">
        <input type="checkbox" name="remember" />
        Keep me signed in on this computer
      </label>
      {state?.error ? <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p> : null}
      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? 'Signing in...' : 'Sign in'}
      </button>
    </form>
  );
}
