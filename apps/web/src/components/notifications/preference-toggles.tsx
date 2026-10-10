'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { NotificationPreferences } from '@/lib/api/schemas';
import { setNotificationPreference } from '@/lib/notifications/actions';
import { notificationTypeGroup } from '@/lib/notifications/labels';

type Item = NotificationPreferences['items'][number];
type Channel = Item['channels'][number]['channel'];
const CHANNELS: Channel[] = ['in_app', 'push', 'email', 'sms'];

/**
 * The settings table (ADR 060): one line per kind of news (related types
 * grouped, as in the app), a switch per channel. In-app is always on; a
 * locked channel (security news) is shown on and can't be turned off; a
 * channel a type doesn't use isn't shown. A switch flips at once and flips
 * back if the API refuses.
 */
export function PreferenceToggles({ initial }: { initial: NotificationPreferences['items'] }) {
  const t = useTranslations('notifications');
  const [items, setItems] = useState(initial);
  const [error, setError] = useState(false);

  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = notificationTypeGroup(item.type);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  async function flip(group: Item[], channel: Exclude<Channel, 'in_app'>, enabled: boolean) {
    setError(false);
    const before = items;
    const types = new Set(group.map((g) => g.type));
    setItems((current) =>
      current.map((item) =>
        types.has(item.type)
          ? {
              ...item,
              channels: item.channels.map((c) => (c.channel === channel ? { ...c, enabled } : c)),
            }
          : item,
      ),
    );
    const results = await Promise.all(
      group.map((g) => setNotificationPreference({ type: g.type, channel, enabled })),
    );
    if (results.some((r) => !r.ok)) {
      setItems(before);
      setError(true);
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <p role="status" className="text-sm text-destructive">
          {t('saveFailed')}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="p-3 font-medium" />
              {CHANNELS.map((c) => (
                <th key={c} className="p-3 text-center font-medium">
                  {t(`channels.${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...groups.entries()].map(([key, group]) => (
              <tr key={key} className="border-b border-border last:border-0">
                <th scope="row" className="p-3 text-left font-normal">
                  {t(`types.${key}`)}
                </th>
                {CHANNELS.map((channel) => {
                  const setting = group[0]!.channels.find((c) => c.channel === channel);
                  if (!setting) return <td key={channel} />;
                  const fixed = channel === 'in_app' || setting.locked;
                  return (
                    <td key={channel} className="p-3 text-center">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--brand)]"
                        checked={fixed ? true : setting.enabled}
                        disabled={fixed}
                        title={setting.locked ? t('locked') : undefined}
                        aria-label={`${t(`types.${key}`)} — ${t(`channels.${channel}`)}`}
                        data-testid={`pref-${group[0]!.type}-${channel}`}
                        onChange={(event) => {
                          if (channel !== 'in_app') void flip(group, channel, event.target.checked);
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
