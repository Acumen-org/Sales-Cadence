import { handleCheck } from '@/lib/sandbox/bellwether-http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** The results a push would give, without writing anything (contract 14.14). */
export const POST = (req: Request) => handleCheck(req);
