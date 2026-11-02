import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { LoginForm } from '@/components/login-form';
import { LoginShell } from '@/components/login-shell';
import { signInMethods, type SignInErrorCode } from '@/lib/auth/microsoft';

/**
 * The way in.
 *
 * An internal tool for one team: the left panel carries the wordmark and the headline, nothing
 * that explains or sells. Slogans, tick marks and a row of feature blurbs have each been here and
 * each went.
 */

const REFUSED: Record<SignInErrorCode, string> = {
  microsoft: 'Microsoft did not sign you in. Try again.',
  expired: 'That sign-in took too long. Try again.',
  removed: 'Your access to Cadence was removed. Ask an admin.',
  outsider: 'Sign in with your work account.',
};

function MicrosoftMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect('/home');
  const { next, error } = await searchParams;
  const methods = await signInMethods();
  const refused = error && error in REFUSED ? REFUSED[error as SignInErrorCode] : null;
  return (
    <LoginShell title="Sign in">
      {methods.microsoft ? (
        <form action="/api/auth/microsoft" method="get" className="mt-8 space-y-4">
          {next ? <input type="hidden" name="next" value={next} /> : null}
          {refused ? <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{refused}</p> : null}
          <button type="submit" className="btn-primary w-full gap-2"><MicrosoftMark />Sign in with Microsoft</button>
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-700">
            <input type="checkbox" name="remember" />
            Keep me signed in on this computer
          </label>
        </form>
      ) : null}
      {methods.microsoft && methods.password ? <div className="my-6 flex items-center gap-3 text-[12px] text-ink-500"><span className="h-px flex-1 bg-line" />or with a password<span className="h-px flex-1 bg-line" /></div> : null}
      {methods.password ? <LoginForm next={next} /> : null}
    </LoginShell>
  );
}
