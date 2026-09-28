import type { PinoLogger } from 'nestjs-pino';
import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import type { TenantDb } from '../../database/tenant-db';
import type { NotificationService } from '../../notifications/notification.service';
import type { OutgoingNotification } from '../../notifications/notification-channel';
import type { SettingsService } from '../../settings/settings.service';
import type { DueSearch, SavedSearchesRepository } from '../saved-searches.repository';
import { SavedSearchNotifierService } from './saved-search-notifier.service';

const NOW = new Date('2026-09-28T04:00:00Z'); // 10:00 Dhaka
const BUDGET = { batchSize: 50, maxBatches: 2 };

function due(over: Partial<DueSearch> = {}): DueSearch {
  return {
    id: 's1',
    user_id: 'u1',
    name: 'Flat in Mirpur',
    alert_frequency_code: 'instant',
    last_alerted_at: null,
    notify_day: null,
    notify_count: 0,
    pending: 7,
    max_match_id: 'm7',
    ...over,
  };
}

function setup(pending: DueSearch[], delivered = 1) {
  const sent: OutgoingNotification[] = [];
  const marked: { searchId: string; maxMatchId: string; day: string }[] = [];
  const repo = {
    withPendingMatches: () => Promise.resolve(pending),
    markNotified: (_tx: DatabaseTransaction, searchId: string, maxMatchId: string, day: string) => {
      marked.push({ searchId, maxMatchId, day });
      return Promise.resolve();
    },
  } as unknown as SavedSearchesRepository;
  const notifications = {
    send: (n: OutgoingNotification) => {
      sent.push(n);
      return Promise.resolve({ delivered });
    },
  } as unknown as NotificationService;
  const settings = {
    get: (key: string) =>
      Promise.resolve(
        (
          { saved_search_notify_per_day: 1, saved_search_daily_digest_hour: 9 } as Record<
            string,
            number
          >
        )[key],
      ),
  } as unknown as SettingsService;
  const tenantDb = {
    transaction: <T>(work: (tx: DatabaseTransaction) => Promise<T>) =>
      work({} as DatabaseTransaction),
  } as unknown as TenantDb;
  const logger = { setContext: () => undefined } as unknown as PinoLogger;
  const service = new SavedSearchNotifierService(
    repo,
    notifications,
    settings,
    tenantDb,
    new TenantContext(),
    logger,
  );
  return { service, sent, marked };
}

describe('SavedSearchNotifierService', () => {
  it('groups every new match of a search into ONE notification', async () => {
    const { service, sent, marked } = setup([due()]);
    const outcome = await service.notifyPending(BUDGET, NOW);
    expect(sent).toEqual([
      {
        userId: 'u1',
        type: 'saved_search_match',
        params: { savedSearchId: 's1', name: 'Flat in Mirpur', count: '7' },
        deepLink: '/saved-searches/s1',
        entityId: 's1',
        dedupeKey: 'saved_search_match:s1:m7',
      },
    ]);
    // The seven matches are covered by it, and today's count moves on.
    expect(marked).toEqual([{ searchId: 's1', maxMatchId: 'm7', day: '2026-09-28' }]);
    expect(outcome).toMatchObject({ rows: 1, details: { held: 0 } });
  });

  it('holds a search at its daily cap; its matches wait, still new', async () => {
    const { service, sent, marked } = setup([
      due({ id: 'capped', notify_day: '2026-09-28', notify_count: 1 }),
      due({ id: 'fresh' }),
    ]);
    const outcome = await service.notifyPending(BUDGET, NOW);
    expect(sent.map((n) => n.entityId)).toEqual(['fresh']);
    expect(marked.map((m) => m.searchId)).toEqual(['fresh']);
    expect(outcome.details).toEqual({ held: 1 });
  });

  it('marks nothing when no channel delivered, so the next run retries', async () => {
    const { service, sent, marked } = setup([due()], 0);
    await service.notifyPending(BUDGET, NOW);
    expect(sent).toHaveLength(1);
    expect(marked).toEqual([]);
  });
});
