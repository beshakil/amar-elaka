import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { routeError } from '@/lib/api/route-errors';
import { readSession } from '@/lib/auth/session';
import { uploadThroughApi } from '@/lib/media/server-upload';
import { currentTenantId } from '@/lib/tenant';

// Transport tuning, not a business rule: the API's store_import_max_file_bytes
// is the real limit (refused at presign); this only stops this server from
// buffering something absurd.
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * The file a bulk import reads (ADR 056/057): the sheet (CSV or XLSX) or the
 * photos ZIP, sent by the browser to this same origin and uploaded as media
 * kind `import` with the seller's session. Which format it is comes from the
 * file name (browsers report CSV types inconsistently); the API checks the
 * bytes themselves at confirm.
 */
const TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
} as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const format = request.headers.get('x-file-format') ?? '';
  if (!(format in TYPES)) return NextResponse.json({ code: 'UPLOAD_REJECTED' }, { status: 400 });
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES)
    return NextResponse.json({ code: 'UPLOAD_REJECTED' }, { status: 413 });

  const [session, tenantId] = await Promise.all([readSession(), currentTenantId()]);
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  if (!tenantId) return NextResponse.json({ code: 'TENANT_REQUIRED' }, { status: 400 });

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ code: 'UPLOAD_REJECTED' }, { status: 413 });
  }
  try {
    const result = await uploadThroughApi(
      { tenantId, accessToken: session.accessToken },
      {
        kind: 'import',
        contentType: TYPES[format as keyof typeof TYPES],
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    );
    return result.ok
      ? NextResponse.json({ mediaId: result.mediaId })
      : NextResponse.json({ code: result.code }, { status: result.status });
  } catch (error) {
    return routeError(error);
  }
}
