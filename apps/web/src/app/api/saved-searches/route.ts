import { NextResponse, type NextRequest } from 'next/server';
import type { CategoryFieldSchema } from '@amar-elaka/dynamic-form';
import { ApiError } from '@/lib/api/errors';
import { apiFetch } from '@/lib/api/fetch';
import { savedSearchCreatedSchema } from '@/lib/api/schemas';
import { readSession } from '@/lib/auth/session';
import { catalog } from '@/lib/listings/load';
import { parseSearchParams } from '@/lib/search/params';
import { queryOf, safeSearchReturn, savedSearchBody } from '@/lib/search/save';
import { currentOrigin, currentTenantConfig } from '@/lib/tenant';

/**
 * The search page's "save this search" form (ADR 042). Always answers with a
 * 303 back to the search (post → redirect → get, so back never resubmits),
 * carrying the outcome for the page to show: `saved=1`, or
 * `saveError=limit|failed`. A visitor without a (valid) session goes to
 * login and comes back to the search.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = await currentOrigin();
  // Only this site's own form: a cross-site POST gets nothing done.
  const from = request.headers.get('origin');
  if (from !== null && from !== origin) return new NextResponse(null, { status: 403 });

  const form = await request.formData();
  const back = safeSearchReturn(form.get('return'));
  const redirect = (path: string) => NextResponse.redirect(new URL(path, origin), 303);
  const withFlash = (flash: string) => redirect(`${back}${back.includes('?') ? '&' : '?'}${flash}`);
  const toLogin = () => redirect(`/login?next=${encodeURIComponent(back)}`);

  const [session, tenant] = await Promise.all([readSession(), currentTenantConfig()]);
  if (!session) return toLogin();
  if (!tenant) return withFlash('saveError=failed');

  const params = parseSearchParams(queryOf(back));
  const category = params.category
    ? (await catalog(tenant)).find((c) => c.slug === params.category)
    : undefined;
  const schema = (category?.fieldSchema as CategoryFieldSchema | null | undefined) ?? null;
  const body = savedSearchBody(form, back, tenant, schema);
  if (!body) return withFlash('saveError=failed');

  try {
    await apiFetch({
      path: '/saved-searches',
      method: 'POST',
      schema: savedSearchCreatedSchema.passthrough(),
      tenantId: tenant.id,
      accessToken: session.accessToken,
      body,
    });
    return withFlash('saved=1');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return toLogin();
    if (error instanceof ApiError && error.code === 'SAVED_SEARCH_LIMIT_REACHED') {
      const max = (error.details as { maxActive?: unknown } | null)?.maxActive;
      return withFlash(`saveError=limit&max=${typeof max === 'number' ? max : 0}`);
    }
    return withFlash('saveError=failed');
  }
}
