import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'masters-diagnostics-web',
    deploymentMode: process.env.DEPLOYMENT_MODE ?? 'club',
    timestamp: new Date().toISOString(),
  });
}
