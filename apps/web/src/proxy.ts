import { isClubConfigured } from '@masters/db';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

const PUBLIC_PATHS = ['/setup', '/sign-in', '/api/auth', '/api/setup/status', '/api/health'];

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (process.env.DEPLOYMENT_MODE === 'club') {
    const configured = await isClubConfigured(db);
    if (!configured && !path.startsWith('/setup') && !path.startsWith('/api/')) {
      return NextResponse.redirect(new URL('/setup', request.url));
    }
  }
  if (PUBLIC_PATHS.some((prefix) => path.startsWith(prefix))) return NextResponse.next();

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.redirect(new URL('/sign-in', request.url));
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
