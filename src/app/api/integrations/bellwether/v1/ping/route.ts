import { handlePing } from '@/lib/sandbox/bellwether-http';

export const dynamic = 'force-dynamic';

/** Key and connectivity check for Bellwether (contract 14.3). */
export const GET = (req: Request) => handlePing(req);
