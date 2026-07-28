import {
  isClubConfigured,
  resolveMembership,
} from '@masters/db';
import {
  type NextRequest,
  NextResponse,
} from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

const PUBLIC_PATHS = [
  '/setup',
  '/sign-in',
  '/api/auth',
  '/api/setup/status',
  '/api/health',
];

const CONTEXT_HEADERS = [
  'x-masters-tenant-id',
  'x-masters-user-id',
  'x-masters-role',
] as const;

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  if (process.env.DEPLOYMENT_MODE === 'club') {
    const configured = await isClubConfigured(db);

    if (
      !configured &&
      !path.startsWith('/setup') &&
      !path.startsWith('/api/')
    ) {
      return NextResponse.redirect(
        new URL('/setup', request.url),
      );
    }
  }

  if (PUBLIC_PATHS.some((prefix) => path.startsWith(prefix))) {
    return NextResponse.next();
  }

  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user?.id) {
    return NextResponse.redirect(
      new URL('/sign-in', request.url),
    );
  }

  const membership = await resolveMembership(
    db,
    session.user.id,
  );

  if (!membership) {
    return NextResponse.redirect(
      new URL('/sign-in?error=membership', request.url),
    );
  }

  const requestHeaders = new Headers(request.headers);
  for (const header of CONTEXT_HEADERS) requestHeaders.delete(header);
  requestHeaders.set('x-masters-tenant-id', membership.tenantId);
  requestHeaders.set('x-masters-user-id', membership.userId);
  requestHeaders.set('x-masters-role', membership.role);

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
