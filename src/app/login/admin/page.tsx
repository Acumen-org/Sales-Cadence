import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { LoginForm } from '@/components/login-form';
import { LoginShell } from '@/components/login-shell';

/**
 * Admins only, with a password: the way in that stays open after Microsoft sign-in retires
 * passwords on /login (owner, 2 November 2026). Nothing links here.
 */
export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect('/home');
  const { next } = await searchParams;
  return (
    <LoginShell title="Admin sign in">
      <div className="mt-8"><LoginForm next={next} admin /></div>
    </LoginShell>
  );
}
