import { isClubConfigured } from '@masters/db';
import { db } from '@/lib/db';

export async function GET() {
  return Response.json({ configured: await isClubConfigured(db) });
}
