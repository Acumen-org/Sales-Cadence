import { handleOwners } from '@/lib/sandbox/bellwether-http';

export const dynamic = 'force-dynamic';

/** Contract v1.1: who can own contacts sent from Bellwether, with their pods (B022). */
export const GET = (req: Request) => handleOwners(req);
