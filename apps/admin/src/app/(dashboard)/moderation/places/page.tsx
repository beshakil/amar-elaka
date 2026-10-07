import { apiFetch } from '@/lib/api/fetch';
import {
  duplicatePageSchema,
  placeClaimQueueSchema,
  placeReportQueueSchema,
  placeReviewQueueSchema,
  placeSuggestionQueueSchema,
} from '@/lib/api/schemas';
import { requireGrant } from '@/lib/auth/guards';
import { ModerationTabs } from '../moderation-tabs';
import { PlacesClient } from './places-client';
import { isPlaceTab } from './reasons';

/**
 * The Places tab of the moderation queue (ADR 051): new places, claims, edit
 * suggestions, duplicate candidates and reports, each the API's own queue.
 * All five load together so every sub-tab shows its count.
 */
export default async function PlaceModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const viewer = await requireGrant({ module: 'places', action: 'approve' });
  const { tab } = await searchParams;
  const auth = { tenantId: viewer.session.tenantId, accessToken: viewer.session.accessToken };

  const [fresh, claims, suggestions, duplicates, reports] = await Promise.all([
    apiFetch({ path: '/places/review-queue', schema: placeReviewQueueSchema, ...auth }),
    apiFetch({ path: '/place-claims/queue', schema: placeClaimQueueSchema, ...auth }),
    apiFetch({ path: '/place-suggestions/queue', schema: placeSuggestionQueueSchema, ...auth }),
    apiFetch({ path: '/places/duplicates', schema: duplicatePageSchema, ...auth }),
    apiFetch({ path: '/place-reports/queue', schema: placeReportQueueSchema, ...auth }),
  ]);

  return (
    <>
      <ModerationTabs active="places" />
      <PlacesClient
        tab={isPlaceTab(tab) ? tab : 'new'}
        fresh={fresh.items}
        claims={claims.items}
        suggestions={suggestions.items}
        duplicates={duplicates.items.filter((d) => d.status === 'open')}
        reports={reports.items}
      />
    </>
  );
}
