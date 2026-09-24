'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/modal';
import { deleteCampaignAction } from '@/lib/actions/campaign-delete';

/** A draft that never ran asks once; a campaign with history asks for its name. */
export function DeleteCampaign({ id, name, simple = false }: { id: string; name: string; simple?: boolean }) {
  const [open, setOpen] = useState(false), [confirmation, setConfirmation] = useState(''), [error, setError] = useState('');
  const [pending, start] = useTransition(); const router = useRouter();
  return <><button type="button" className="btn-ghost btn-sm text-red-700" onClick={() => setOpen(true)}>Delete campaign</button>{open && <Modal label="Permanently delete campaign" onClose={() => { if (!pending) setOpen(false); }}><div className="space-y-4 p-5"><h2 className="text-lg font-semibold">{simple ? `Delete ${name}?` : 'Permanently delete this campaign?'}</h2><p className="text-sm">{simple ? 'This cannot be undone.' : 'Its tasks and history go with it; the people stay. This cannot be undone.'}</p>{!simple && <label className="block text-sm">Type <strong>{name}</strong> to confirm<input aria-label="Confirm campaign name" value={confirmation} onChange={e => setConfirmation(e.target.value)} className="mt-2 w-full" /></label>}{error && <p role="alert" className="text-sm text-red-700">{error}</p>}<div className="flex justify-end gap-2"><button type="button" className="btn-secondary" disabled={pending} onClick={() => setOpen(false)}>Cancel</button><button type="button" className="btn-danger" disabled={pending || (!simple && confirmation !== name)} onClick={() => start(async () => { const r = await deleteCampaignAction(id, simple ? name : confirmation); if (!r.ok) setError(r.error); else { router.push('/campaigns'); router.refresh(); } })}>{pending ? 'Deleting…' : simple ? 'Delete' : 'Permanently delete'}</button></div></div></Modal>}</>;
}
