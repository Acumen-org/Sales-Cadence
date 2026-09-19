'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '../auth/current-user';
import { setMipStars } from '../mip';

/** One to three stars on a most-important person, or none; the pod's own judgement. */
export async function setMipStarsAction(personId: string, stars: number): Promise<{ ok: true; stars: number } | { ok: false; error: string }> {
  const user = await requireUser();
  try {
    const result = await setMipStars(user, String(personId), Number(stars));
    revalidatePath('/people');
    return { ok: true, stars: result.stars };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'The stars could not be saved.' };
  }
}
