import { handleStatus } from '@/lib/sandbox/bellwether-http';

export const dynamic = 'force-dynamic';

/** Status of pushed contacts, by id or by change time (contract 14.12). */
export const POST = (req: Request) => handleStatus(req);
