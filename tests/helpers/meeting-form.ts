/**
 * What every meeting form now carries (29 October 2026): someone from the team on the call, the
 * prospects it was with, and at least one product. The recording is mandatory (17 November 2026):
 * a form with no link says the meeting was not recorded.
 */
export function withPeople(fd: FormData, teamUserId: string, prospects: string[] = ['person-01'], products: string[] = ['PHH']): FormData {
  fd.set('teamJson', JSON.stringify([teamUserId]));
  fd.set('prospectsJson', JSON.stringify(prospects));
  fd.delete('products');
  for (const p of products) fd.append('products', p);
  if (!String(fd.get('sourceUrl') ?? '').trim() && !fd.has('notRecorded')) fd.set('notRecorded', 'on');
  return fd;
}
