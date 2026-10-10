import { HttpStatus, Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../../auth/exceptions/auth.exceptions';
import { DomainException } from '../../common/exceptions/domain-exception';
import { TenantContext } from '../../database/tenant-context';
import { TenantDb } from '../../database/tenant-db';
import { SettingsService } from '../../settings/settings.service';
import { chooseChannels, configurableChannels } from '../delivery-policy';
import type { ChannelCode, InterruptChannel } from '../notification-channel';
import { NotificationsRepository, type TypeRow } from '../notifications.repository';
import type {
  Preferences,
  PushTokenInput,
  UpdatePreferences,
} from './notification-preferences.dto';

/** The type isn't one the user gets, or the channel is locked for it (security, SMS not allowed). */
export class NotificationPreferenceLockedException extends DomainException {
  readonly code = 'NOTIFICATION_PREFERENCE_LOCKED';
  readonly httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly issues: { type: string; channel: string };

  constructor(type: string, channel: string) {
    super('This notification setting cannot be changed.');
    this.issues = { type, channel };
  }
}

const ALL_REACHABLE = { hasVerifiedPhone: true, hasVerifiedEmail: true, pushDevices: 1 };

/**
 * The user's notification settings (ADR 059): per type and channel, the
 * effective value — their own choice, else the type's default — and whether
 * they may change it. The inbox is always on; push and email are theirs to
 * switch; SMS only appears where SMS is allowed at all; security and account
 * notices are locked on. Also the device's push token (FCM, every platform).
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly repo: NotificationsRepository,
    private readonly settings: SettingsService,
  ) {}

  async get(): Promise<Preferences> {
    this.requireUser();
    const smsExtra = await this.settings.get('notification_sms_extra_types');
    const { types, mine } = await this.load();
    return {
      items: types.map((rules) => {
        const prefs = new Map(
          mine.filter((p) => p.type === rules.code).map((p) => [p.channel, p.enabled] as const),
        );
        const editable = new Set<ChannelCode>(configurableChannels(rules, smsExtra));
        // What would go out to a user reachable everywhere: the effective switch per channel.
        const on = new Set<ChannelCode>(chooseChannels(rules, prefs, ALL_REACHABLE, smsExtra));
        const smsShown = rules.smsEligible || smsExtra.includes(rules.code);
        const channels: Preferences['items'][number]['channels'] = [
          { channel: 'in_app', enabled: true, locked: true },
        ];
        for (const channel of [
          'push',
          'email',
          ...(smsShown ? ['sms' as const] : []),
        ] as InterruptChannel[]) {
          channels.push({ channel, enabled: on.has(channel), locked: !editable.has(channel) });
        }
        return { type: rules.code, urgent: rules.urgent, channels };
      }),
    };
  }

  async update(input: UpdatePreferences): Promise<Preferences> {
    this.requireUser();
    const smsExtra = await this.settings.get('notification_sms_extra_types');
    const { types } = await this.load();
    const byCode = new Map(types.map((t) => [t.code, t]));
    for (const item of input.items) {
      const rules = byCode.get(item.type);
      if (!rules || !configurableChannels(rules, smsExtra).includes(item.channel)) {
        throw new NotificationPreferenceLockedException(item.type, item.channel);
      }
    }
    await this.tenantDb.transaction(async (tx) => {
      for (const item of input.items)
        await this.repo.setPreference(tx, item.type, item.channel, item.enabled);
    });
    return this.get();
  }

  async registerPushToken(input: PushTokenInput): Promise<void> {
    this.requireUser();
    await this.tenantDb.transaction((tx) =>
      this.repo.registerPushToken(tx, input.platform, input.token),
    );
  }

  async forgetPushToken(token: string): Promise<void> {
    this.requireUser();
    await this.tenantDb.transaction((tx) => this.repo.forgetPushToken(tx, token));
  }

  /**
   * The types this user gets (platform-only ones for platform staff only),
   * and their own choices. The type list reads as system: it keeps only
   * types that have templates, and templates aren't member-readable (RLS).
   */
  private async load(): Promise<{
    types: TypeRow[];
    mine: { type: string; channel: ChannelCode; enabled: boolean }[];
  }> {
    const types = await this.context.run({ role: 'system' }, () =>
      this.tenantDb.transaction((tx) => this.repo.allTypeRules(tx), { accessMode: 'read only' }),
    );
    return this.tenantDb.transaction(
      async (tx) => {
        const staff = await this.repo.isPlatformStaff(tx);
        return {
          types: types.filter((t) => t.audience === 'member' || staff),
          mine: await this.repo.myPreferences(tx),
        };
      },
      { accessMode: 'read only' },
    );
  }

  private requireUser(): string {
    const userId = this.context.current()?.userId;
    if (!userId) throw new UnauthenticatedException();
    return userId;
  }
}
