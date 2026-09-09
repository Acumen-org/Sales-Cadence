import { demoLoginAction } from '@/lib/actions/auth';

const DEMO_USERS = [
  { email: 'admin@cadence.local', label: 'Admin Acumen', hint: 'Admin' },
  { email: 'ria@cadence.local', label: 'Ria Admin', hint: 'Admin' },
  { email: 'leigh@cadence.local', label: 'Leigh Leader', hint: "Sales Leader, Alisa's and Andrew's pods" },
  { email: 'alisa@cadence.local', label: 'Alisa Senior', hint: "Senior FO, Alisa's pod" },
  { email: 'andrew@cadence.local', label: 'Andrew Senior', hint: "Senior FO, Andrew's pod" },
  { email: 'karson@cadence.local', label: 'Karson Junior', hint: "Junior FO, Alisa's pod" },
  { email: 'daniel@cadence.local', label: 'Daniel Junior', hint: "Junior FO, Andrew's pod" },
];

/** Shown only in mock mode: sign in as any seeded demo user with one click. */
export function DemoLogin() {
  return (
    <div className="mt-6 border-t border-line pt-4">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">Demo workspace: sign in as</p>
      <div className="grid grid-cols-2 gap-2">
        {DEMO_USERS.map((u) => (
          <form key={u.email} action={demoLoginAction}>
            <input type="hidden" name="email" value={u.email} />
            <button type="submit" className="btn-secondary w-full flex-col items-start gap-0 py-1.5 text-left">
              <span className="text-sm font-medium">{u.label}</span>
              <span className="text-[11px] font-normal text-ink-500">{u.hint}</span>
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}
