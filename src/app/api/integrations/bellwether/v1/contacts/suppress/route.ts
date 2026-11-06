import { handleSuppress } from '@/lib/sandbox/bellwether-http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Contract v1.1: a Do not contact set in Bellwether opts the person out in Cadence, cold or CRM (B003). */
export const POST = (req: Request) => handleSuppress(req);
