/**
 * What every meeting form now carries (29 October 2026): someone from the team on the call, the
 * prospects it was with, and at least one product.
 */
export function withPeople(fd: FormData, teamUserId: string, prospects: string[] = ['person-01'], products: string[] = ['PHH']): FormData {
  fd.set('teamJson', JSON.stringify([teamUserId]));
  fd.set('prospectsJson', JSON.stringify(prospects));
  fd.delete('products');
  for (const p of products) fd.append('products', p);
  return fd;
}
