import { isClubConfigured } from '@masters/db';
import { toNextJsHandler } from 'better-auth/next-js';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

export async function POST(request: NextRequest) {
  const isEmailSignUp =
    request.nextUrl.pathname === '/api/auth/sign-up/email';

  if (
    process.env.DEPLOYMENT_MODE === 'club' &&
    isEmailSignUp &&
    await isClubConfigured(db)
  ) {
    return NextResponse.json(
      {
        error: 'Self-registration is disabled after club setup.',
      },
      {
        status: 403,
      },
    );
  }

  return handlers.POST(request);
}