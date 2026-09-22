'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/modal';
import { deleteCampaignAction } from '@/lib/actions/campaign-delete';

export function DeleteCampaign({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false), [confirmation, setConfirmation] = useState(''), [error, setError] = useState('');
  const [pending, start] = useTransition(); const router = useRouter();
  return <><button type="button" className="btn-ghost btn-sm text-red-700" onClick={() => setOpen(true)}>Delete campaign</button>{open && <Modal label="Permanently delete campaign" onClose={() => { if (!pending) setOpen(false); }}><div className="space-y-4 p-5"><h2 className="text-lg font-semibold">Permanently delete this campaign?</h2><p className="text-sm">This removes its tasks, enrollments, campaign activity and unused outreach. Contacts remain in the CRM. This cannot be undone.</p><label className="block text-sm">Type <strong>{name}</strong> to confirm<input aria-label="Confirm campaign name" value={confirmation} onChange={e => setConfirmation(e.target.value)} className="mt-2 w-full" /></label>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}<div className="flex justify-end gap-2"><button type="button" className="btn-secondary" disabled={pending} onClick={() => setOpen(false)}>Cancel</button><button type="button" className="btn-danger" disabled={pending || confirmation !== name} onClick={() => start(async () => { const r = await deleteCampaignAction(id, confirmation); if (!r.ok) setError(r.error); else { router.push('/campaigns'); router.refresh(); } })}>{pending ? 'Deleting…' : 'Permanently delete'}</button></div></div></Modal>}</>;
}
