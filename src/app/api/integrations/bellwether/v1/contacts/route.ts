import { handlePush } from '@/lib/sandbox/bellwether-http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Bellwether pushes 1 to 500 contacts into the sandbox (contract 14.4 to 14.10). */
export const POST = (req: Request) => handlePush(req);
