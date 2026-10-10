import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import type { TypeRules } from './delivery-policy';
import type { ChannelCode, InterruptChannel } from './notification-channel';
import type { Locale } from './templates/template-renderer';

const typeRow = z.object({
  code: z.string(),
  default_channels: z.array(z.enum(['in_app', 'push', 'sms', 'email'])),
  is_urgent: z.boolean(),
  sms_eligible: z.boolean(),
  collapsible: z.boolean(),
  user_configurable: z.boolean(),
  audience: z.enum(['member', 'platform']),
});
export type TypeRow = TypeRules & { audience: 'member' | 'platform' };

const recipientRow = z.object({
  preferred_locale: z.enum(['bn', 'en']),
  phone_e164: z.string().nullable(),
  phone_verified: z.boolean(),
  email: z.string().nullable(),
  email_verified: z.boolean(),
  active: z.boolean(),
  push_devices: z.number(),
});
export interface Recipient {
  locale: Locale;
  phone: string | null;
  email: string | null;
  hasVerifiedPhone: boolean;
  hasVerifiedEmail: boolean;
  active: boolean;
  pushDevices: number;
}

const collapsibleRow = z.object({ id: z.string(), collapse_count: z.number() });

const deliveryRow = z.object({
  id: z.string(),
  status_code: z.string(),
  channel_code: z.enum(['push', 'sms', 'email']),
  notification_id: z.string(),
  user_id: z.string(),
  tenant_id: z.string().nullable(),
  type_code: z.string(),
  params: z.record(z.unknown()),
  deep_link: z.string().nullable(),
  collapse_key: z.string().nullable(),
  collapse_count: z.number(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  is_urgent: z.boolean(),
  preferred_locale: z.enum(['bn', 'en']),
});
export type DeliveryRow = z.infer<typeof deliveryRow>;

const tokenRow = z.object({
  token: z.string(),
  platform: z.enum(['android', 'ios', 'web']),
});
export type PushTokenRow = z.infer<typeof tokenRow>;

/**
 * Notification SQL (ADR 059). Everything here runs in the worker as
 * `system` (TenantDb grants it the platform-wide read every recipient
 * lookup needs; 0055 adds the policies the worker writes under), except
 * the preferences and push-token calls, which run as the user.
 */
@Injectable()
export class NotificationsRepository {
  async typeRules(tx: DatabaseTransaction, code: string): Promise<TypeRow | undefined> {
    const rows = await tx.execute(sql`
      select code, default_channels, is_urgent, sms_eligible, collapsible, user_configurable, audience
      from public.notification_types where code = ${code} and is_active`);
    const row = z
      .array(typeRow)
      .max(1)
      .parse([...rows])[0];
    return row ? toRules(row) : undefined;
  }

  async allTypeRules(tx: DatabaseTransaction): Promise<TypeRow[]> {
    const rows = await tx.execute(sql`
      select t.code, t.default_channels, t.is_urgent, t.sms_eligible, t.collapsible, t.user_configurable, t.audience
      from public.notification_types t
      where t.is_active
        and exists (select 1 from public.notification_templates nt where nt.type_code = t.code and nt.is_active)
      order by t.sort_order`);
    return z
      .array(typeRow)
      .parse([...rows])
      .map(toRules);
  }

  async recipient(tx: DatabaseTransaction, userId: string): Promise<Recipient | undefined> {
    const rows = await tx.execute(sql`
      select u.preferred_locale, u.phone_e164, u.phone_verified_at is not null as phone_verified,
             u.email, u.email_verified_at is not null as email_verified,
             (u.status_code = 'active' and u.deleted_at is null) as active,
             (select count(*)::int from public.user_devices d
              where d.user_id = u.id and d.push_token is not null and d.revoked_at is null) as push_devices
      from public.users u where u.id = ${userId}::uuid`);
    const row = z
      .array(recipientRow)
      .max(1)
      .parse([...rows])[0];
    if (!row) return undefined;
    return {
      locale: row.preferred_locale,
      phone: row.phone_e164,
      email: row.email,
      hasVerifiedPhone: row.phone_e164 !== null && row.phone_verified,
      hasVerifiedEmail: row.email !== null && row.email_verified,
      active: row.active,
      pushDevices: row.push_devices,
    };
  }

  async preferences(
    tx: DatabaseTransaction,
    userId: string,
    type: string,
  ): Promise<Map<ChannelCode, boolean>> {
    const rows = await tx.execute(sql`
      select channel_code, is_enabled from public.user_notification_preferences
      where user_id = ${userId}::uuid and type_code = ${type}`);
    const parsed = z
      .array(
        z.object({
          channel_code: z.enum(['in_app', 'push', 'sms', 'email']),
          is_enabled: z.boolean(),
        }),
      )
      .parse([...rows]);
    return new Map(parsed.map((p) => [p.channel_code, p.is_enabled]));
  }

  /** The active template for (type, channel, locale, variant): the channel's own, else in_app; the locale, else bn. */
  async template(
    tx: DatabaseTransaction,
    type: string,
    channel: ChannelCode,
    locale: Locale,
    variant: 'single' | 'collapsed',
  ): Promise<{ title: string | null; body: string } | undefined> {
    const rows = await tx.execute(sql`
      select title_template, body_template from public.notification_templates
      where type_code = ${type} and is_active
        and channel_code in (${channel}, 'in_app') and locale in (${locale}, 'bn')
        and variant in (${variant}, 'single')
      order by (variant = ${variant}) desc, (channel_code = ${channel}) desc, (locale = ${locale}) desc
      limit 1`);
    const row = z
      .array(z.object({ title_template: z.string().nullable(), body_template: z.string() }))
      .max(1)
      .parse([...rows])[0];
    return row ? { title: row.title_template, body: row.body_template } : undefined;
  }

  async reasonLabel(tx: DatabaseTransaction, code: string, locale: Locale): Promise<string | null> {
    const rows = await tx.execute(sql`
      select case when ${locale} = 'en' then coalesce(label_en, label_bn) else label_bn end as label
      from public.moderation_reasons where code = ${code}`);
    return (
      z
        .array(z.object({ label: z.string().nullable() }))
        .max(1)
        .parse([...rows])[0]?.label ?? null
    );
  }

  async tenantTimezone(tx: DatabaseTransaction, tenantId: string): Promise<string | undefined> {
    const rows = await tx.execute(
      sql`select timezone from public.tenants where id = ${tenantId}::uuid`,
    );
    return z
      .array(z.object({ timezone: z.string() }))
      .max(1)
      .parse([...rows])[0]?.timezone;
  }

  /** The user's unread notification to collapse into (same type and key, newer than `since`), locked. */
  async findCollapsible(
    tx: DatabaseTransaction,
    userId: string,
    type: string,
    key: string,
    since: Date,
  ): Promise<{ id: string; collapse_count: number } | undefined> {
    const rows = await tx.execute(sql`
      select id, collapse_count from public.notifications
      where user_id = ${userId}::uuid and type_code = ${type} and collapse_key = ${key}
        and read_at is null and archived_at is null and last_event_at >= ${since.toISOString()}::timestamptz
      order by last_event_at desc
      limit 1
      for update`);
    return z
      .array(collapsibleRow)
      .max(1)
      .parse([...rows])[0];
  }

  /** A new inbox row; undefined when its dedupe key was already used (nothing to do). */
  async insertNotification(
    tx: DatabaseTransaction,
    n: {
      userId: string;
      tenantId: string | null;
      type: string;
      params: Record<string, string | null>;
      deepLink: string | null;
      entityId: string | null;
      dedupeKey: string | null;
      collapseKey: string | null;
      title: string | null;
      body: string | null;
      at: Date;
    },
  ): Promise<string | undefined> {
    const rows = await tx.execute(sql`
      insert into public.notifications
        (user_id, tenant_id, type_code, params, deep_link, entity_id, dedupe_key, collapse_key, title, body,
         channels_sent, last_event_at)
      values (${n.userId}::uuid, ${n.tenantId}::uuid, ${n.type}, ${JSON.stringify(n.params)}::jsonb, ${n.deepLink},
              ${n.entityId}::uuid, ${n.dedupeKey}, ${n.collapseKey}, ${n.title}, ${n.body}, '{in_app}',
              ${n.at.toISOString()}::timestamptz)
      on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing
      returning id`);
    return z
      .array(z.object({ id: z.string() }))
      .max(1)
      .parse([...rows])[0]?.id;
  }

  /** Folds one more event into an unread notification: count, latest params, re-rendered text. */
  async collapseInto(
    tx: DatabaseTransaction,
    id: string,
    n: {
      count: number;
      params: Record<string, string | null>;
      deepLink: string | null;
      entityId: string | null;
      title: string | null;
      body: string | null;
      at: Date;
    },
  ): Promise<void> {
    await tx.execute(sql`
      update public.notifications set
        collapse_count = ${n.count}, params = ${JSON.stringify(n.params)}::jsonb, deep_link = ${n.deepLink},
        entity_id = ${n.entityId}::uuid, title = ${n.title}, body = ${n.body},
        last_event_at = ${n.at.toISOString()}::timestamptz
      where id = ${id}::uuid`);
  }

  /** Interruptions sent (or on their way) to the user since `since`: all types, and this one. */
  async sentSince(
    tx: DatabaseTransaction,
    userId: string,
    type: string,
    since: Date,
  ): Promise<{ all: number; ofType: number }> {
    const rows = await tx.execute(sql`
      select count(*)::int as all, count(*) filter (where n.type_code = ${type})::int as of_type
      from public.notification_deliveries d
      join public.notifications n on n.id = d.notification_id
      where d.user_id = ${userId}::uuid and d.channel_code <> 'in_app'
        and d.created_at >= ${since.toISOString()}::timestamptz
        and d.status_code in ('queued', 'sent', 'delivered')`);
    const row = z
      .array(z.object({ all: z.number(), of_type: z.number() }))
      .length(1)
      .parse([...rows])[0]!;
    return { all: row.all, ofType: row.of_type };
  }

  /** A push for this notification still waiting (quiet hours): a collapsed event rides on it. */
  async hasWaitingDelivery(
    tx: DatabaseTransaction,
    notificationId: string,
    channel: InterruptChannel,
  ): Promise<boolean> {
    const rows = await tx.execute(sql`
      select 1 from public.notification_deliveries
      where notification_id = ${notificationId}::uuid and channel_code = ${channel} and status_code = 'queued'`);
    return [...rows].length > 0;
  }

  async insertDelivery(
    tx: DatabaseTransaction,
    d: {
      notificationId: string;
      userId: string;
      tenantId: string | null;
      channel: InterruptChannel;
      provider: string;
      scheduledFor: Date | null;
    },
  ): Promise<string> {
    const rows = await tx.execute(sql`
      insert into public.notification_deliveries
        (notification_id, user_id, billed_tenant_id, purpose_code, channel_code, recipient_masked, provider_code,
         scheduled_for)
      values (${d.notificationId}::uuid, ${d.userId}::uuid,
              ${d.channel === 'sms' ? d.tenantId : null}::uuid, 'notification', ${d.channel}, '', ${d.provider},
              ${d.scheduledFor ? d.scheduledFor.toISOString() : null}::timestamptz)
      returning id`);
    return z
      .array(z.object({ id: z.string() }))
      .length(1)
      .parse([...rows])[0]!.id;
  }

  async delivery(tx: DatabaseTransaction, id: string): Promise<DeliveryRow | undefined> {
    const rows = await tx.execute(sql`
      select d.id, d.status_code, d.channel_code, n.id as notification_id, n.user_id, n.tenant_id, n.type_code,
             n.params, n.deep_link, n.collapse_key, n.collapse_count, n.title, n.body, t.is_urgent,
             u.preferred_locale
      from public.notification_deliveries d
      join public.notifications n on n.id = d.notification_id
      join public.notification_types t on t.code = n.type_code
      join public.users u on u.id = n.user_id
      where d.id = ${id}::uuid`);
    return z
      .array(deliveryRow)
      .max(1)
      .parse([...rows])[0];
  }

  async finishDelivery(
    tx: DatabaseTransaction,
    id: string,
    result: {
      status: 'sent' | 'undeliverable' | 'failed';
      recipient?: string;
      providerMessageId?: string | null;
      smsSegments?: number | null;
      error?: string | null;
    },
  ): Promise<void> {
    await tx.execute(sql`
      update public.notification_deliveries set
        status_code = ${result.status},
        recipient_masked = coalesce(${result.recipient ?? null}, recipient_masked),
        provider_message_id = coalesce(${result.providerMessageId ?? null}, provider_message_id),
        sms_segments = coalesce(${result.smsSegments ?? null}::smallint, sms_segments),
        last_error = ${result.error ?? null},
        attempt_count = attempt_count + 1,
        sent_at = case when ${result.status} = 'sent' then now() else sent_at end
      where id = ${id}::uuid`);
  }

  async noteAttempt(tx: DatabaseTransaction, id: string, error: string): Promise<void> {
    await tx.execute(sql`
      update public.notification_deliveries set attempt_count = attempt_count + 1, last_error = ${error}
      where id = ${id}::uuid`);
  }

  async addChannelSent(
    tx: DatabaseTransaction,
    notificationId: string,
    channel: InterruptChannel,
  ): Promise<void> {
    await tx.execute(sql`
      update public.notifications set channels_sent = array_append(channels_sent, ${channel})
      where id = ${notificationId}::uuid and not (${channel} = any (channels_sent))`);
  }

  async pushTokens(tx: DatabaseTransaction, userId: string): Promise<PushTokenRow[]> {
    const rows = await tx.execute(sql`
      select push_token as token, platform_code as platform from public.user_devices
      where user_id = ${userId}::uuid and push_token is not null and revoked_at is null
      order by last_seen_at desc`);
    return z.array(tokenRow).parse([...rows]);
  }

  /** FCM said these tokens are dead: the devices stay, their tokens go. */
  async removeTokens(tx: DatabaseTransaction, tokens: readonly string[]): Promise<number> {
    if (tokens.length === 0) return 0;
    const rows = await tx.execute(sql`
      update public.user_devices set push_token = null
      where push_token = any(${`{${tokens.map((t) => `"${t.replace(/["\\]/g, '')}"`).join(',')}}`}::text[])
      returning id`);
    return [...rows].length;
  }

  async contact(
    tx: DatabaseTransaction,
    userId: string,
  ): Promise<{ phone: string | null; email: string | null }> {
    const rows = await tx.execute(sql`
      select case when phone_verified_at is not null then phone_e164 end as phone,
             case when email_verified_at is not null then email end as email
      from public.users where id = ${userId}::uuid`);
    return (
      z
        .array(z.object({ phone: z.string().nullable(), email: z.string().nullable() }))
        .max(1)
        .parse([...rows])[0] ?? {
        phone: null,
        email: null,
      }
    );
  }

  // ---- as the user (RLS: owner) ---------------------------------------------

  async myPreferences(
    tx: DatabaseTransaction,
  ): Promise<{ type: string; channel: ChannelCode; enabled: boolean }[]> {
    const rows = await tx.execute(sql`
      select type_code, channel_code, is_enabled from public.user_notification_preferences
      where user_id = public.current_user_id()`);
    return z
      .array(
        z.object({
          type_code: z.string(),
          channel_code: z.enum(['in_app', 'push', 'sms', 'email']),
          is_enabled: z.boolean(),
        }),
      )
      .parse([...rows])
      .map((r) => ({ type: r.type_code, channel: r.channel_code, enabled: r.is_enabled }));
  }

  async setPreference(
    tx: DatabaseTransaction,
    type: string,
    channel: InterruptChannel,
    enabled: boolean,
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.user_notification_preferences (user_id, type_code, channel_code, is_enabled)
      values (public.current_user_id(), ${type}, ${channel}, ${enabled})
      on conflict (user_id, type_code, channel_code) do update set is_enabled = excluded.is_enabled`);
  }

  async registerPushToken(
    tx: DatabaseTransaction,
    platform: string,
    token: string,
  ): Promise<string> {
    const rows = await tx.execute(
      sql`select public.register_push_token(${platform}, ${token}) as id`,
    );
    return z
      .array(z.object({ id: z.string() }))
      .length(1)
      .parse([...rows])[0]!.id;
  }

  async forgetPushToken(tx: DatabaseTransaction, token: string): Promise<void> {
    await tx.execute(sql`
      update public.user_devices set push_token = null
      where user_id = public.current_user_id() and push_token = ${token}`);
  }

  async isPlatformStaff(tx: DatabaseTransaction): Promise<boolean> {
    const rows = await tx.execute(sql`
      select platform_role_code is not null as staff from public.users where id = public.current_user_id()`);
    return (
      z
        .array(z.object({ staff: z.boolean() }))
        .max(1)
        .parse([...rows])[0]?.staff ?? false
    );
  }
}

function toRules(row: z.infer<typeof typeRow>): TypeRow {
  return {
    code: row.code,
    defaultChannels: row.default_channels,
    urgent: row.is_urgent,
    smsEligible: row.sms_eligible,
    collapsible: row.collapsible,
    userConfigurable: row.user_configurable,
    audience: row.audience,
  };
}
