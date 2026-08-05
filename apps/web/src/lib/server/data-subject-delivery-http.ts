import type { DataSubjectDeliveryDownload } from './data-subject-delivery-download';

export interface DataSubjectDeliveryHttpDependencies {
  consume(token: string): Promise<Readonly<DataSubjectDeliveryDownload> | null>;
}

const BEARER_TOKEN = /^Bearer ([A-Za-z0-9_-]{40,128})$/;

function unavailable(): Response {
  return new Response(null, {
    status: 404,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function internalFailure(): Response {
  return new Response(null, {
    status: 500,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/**
 * HTTP boundary for the one-time bearer-token download. The token is accepted
 * only via Authorization, never URL/query data. Unknown, expired and consumed
 * packages intentionally collapse to the same 404 response.
 */
export async function serveDataSubjectDeliveryDownload(
  request: Request,
  deps: DataSubjectDeliveryHttpDependencies,
): Promise<Response> {
  const authorization = request.headers.get('authorization')?.trim() ?? '';
  const match = BEARER_TOKEN.exec(authorization);
  if (!match) return unavailable();

  try {
    const download = await deps.consume(match[1]);
    if (!download) return unavailable();
    if (!/^masters-data-subject-export-[0-9a-f-]{36}\.tar$/i.test(download.fileName)) {
      return internalFailure();
    }

    const body = new Uint8Array(download.bytes.byteLength);
    body.set(download.bytes);
    return new Response(body.buffer, {
      status: 200,
      headers: {
        'Content-Type': download.mediaType,
        'Content-Length': String(body.byteLength),
        'Content-Disposition': `attachment; filename="${download.fileName}"`,
        'Cache-Control': 'private, no-store, max-age=0',
        Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch {
    return internalFailure();
  }
}
