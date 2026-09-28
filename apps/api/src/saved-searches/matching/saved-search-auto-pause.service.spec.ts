import type { DatabaseTransaction } from '../../database/database.client';
import { TenantContext } from '../../database/tenant-context';
import type { TenantDb } from '../../database/tenant-db';
import type { NotificationService } from '../../notifications/notification.service';
import type { OutgoingNotification } from '../../notifications/notification-channel';
import type { SettingsService } from '../../settings/settings.service';
import type { SavedSearchesRepository } from '../saved-searches.repository';
import { SavedSearchAutoPauseService } from './saved-search-auto-pause.service';

function setup(days: number, idle: { id: string; user_id: string; name: string }[]) {
  const sent: OutgoingNotification[] = [];
  const pauseIdle = jest.fn().mockResolvedValueOnce(idle).mockResolvedValue([]);
  const service = new SavedSearchAutoPauseService(
    { pauseIdle } as unknown as SavedSearchesRepository,
    {
      send: (n: OutgoingNotification) => {
        sent.push(n);
        return Promise.resolve({ delivered: 1 });
      },
    } as unknown as NotificationService,
    { get: () => Promise.resolve(days) } as unknown as SettingsService,
    {
      transaction: <T>(work: (tx: DatabaseTransaction) => Promise<T>) =>
        work({} as DatabaseTransaction),
    } as unknown as TenantDb,
    new TenantContext(),
  );
  return { service, sent, pauseIdle };
}

describe('SavedSearchAutoPauseService', () => {
  it('pauses searches idle past saved_search_auto_pause_days and tells each owner', async () => {
    const { service, sent, pauseIdle } = setup(30, [
      { id: 's1', user_id: 'u1', name: 'Flat' },
      { id: 's2', user_id: 'u2', name: 'Cow' },
    ]);
    const outcome = await service.pauseIdle({ batchSize: 10, maxBatches: 3 });
    expect(pauseIdle).toHaveBeenCalledWith(expect.anything(), 30, 10);
    expect(outcome).toEqual({ rows: 2, capped: false });
    expect(sent).toEqual([
      expect.objectContaining({
        userId: 'u1',
        type: 'saved_search_paused',
        params: { savedSearchId: 's1', name: 'Flat', idleDays: '30' },
        deepLink: '/saved-searches/s1',
      }),
      expect.objectContaining({ userId: 'u2', type: 'saved_search_paused' }),
    ]);
  });

  it('does nothing when auto-pause is off (0 days)', async () => {
    const { service, sent, pauseIdle } = setup(0, [{ id: 's1', user_id: 'u1', name: 'Flat' }]);
    expect(await service.pauseIdle({ batchSize: 10, maxBatches: 3 })).toEqual({
      rows: 0,
      capped: false,
    });
    expect(pauseIdle).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
