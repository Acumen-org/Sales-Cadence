import { handleReadApi } from '@/lib/public-api/http';

export const dynamic = 'force-dynamic';

/** The read API (Notes/public-api-2026-11-08/CONTRACT.md): GET only; every other method is a 405. */
export const GET = (req: Request) => handleReadApi(req);
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
