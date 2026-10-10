import type { Sql, TransactionSql } from 'postgres';
import { NOTIFICATION_TYPES } from '../src/notifications/notification-channel';
import { renderTemplate } from '../src/notifications/templates/template-renderer';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Notifications in the database (0055, ADR 059):
 *  - every type the code sends has an active Bengali in_app template, and
 *    every template renders with no placeholder left behind;
 *  - the type rules: SMS only for SMS-eligible types, urgent ones locked on;
 *  - RLS: only the worker (system) collapses a notification or reads
 *    someone's preferences; a user never sees another's;
 *  - register_push_token moves a token to the caller.
 */

const P = '0191e3a0-c4a4-7000-8000-';
const FIXTURE = `${P}%`;
const U = (n: number) => `${P}0000000000${30 + n}`;

type Context = Partial<Record<'user_id' | 'role' | 'is_platform_admin', string>>;
/** What TenantDb sets for the worker (system role): applyTransactionContext, tenant-db.ts. */
const WORKER: Context = { role: 'system', is_platform_admin: 'true' };
async function withContext<T>(
  sql: Sql,
  context: Context,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(context)) {
      await tx`select set_config(${`app.${key}`}, ${value}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}
async function rejection(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (caught: unknown) => (caught as { code?: string }).code ?? 'unknown',
  );
}

describe('Notifications in the database (0055)', () => {
  let app: Sql;
  let admin: Sql;

  async function cleanUp(): Promise<void> {
    await admin`delete from notifications where user_id::text like ${FIXTURE}`;
    await admin`delete from user_notification_preferences where user_id::text like ${FIXTURE}`;
    await admin`delete from user_devices where user_id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    app = testSqlClient(2, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    for (const n of [1, 2]) {
      await admin`insert into users (id, phone_e164) values (${U(n)}, ${`+88017570000${n}0`})`;
    }
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  it('every type the code sends has an active Bengali in_app template', async () => {
    const rows = await admin<{ type_code: string }[]>`
      select distinct type_code from notification_templates
      where channel_code = 'in_app' and locale = 'bn' and variant = 'single' and is_active`;
    const have = new Set(rows.map((r) => r.type_code));
    expect(NOTIFICATION_TYPES.filter((t) => !have.has(t))).toEqual([]);
  });

  it('every template renders fully: no placeholder left, each declared variable used', async () => {
    const templates = await admin<
      {
        type_code: string;
        title_template: string | null;
        body_template: string;
        variables: string[];
      }[]
    >`
      select type_code, title_template, body_template, variables from notification_templates where is_active`;
    for (const t of templates) {
      const vars = Object.fromEntries(t.variables.map((v) => [v, '1']));
      for (const text of [t.title_template, t.body_template]) {
        if (text === null) continue;
        const rendered = renderTemplate(text, vars, 'bn');
        expect({ type: t.type_code, leftover: rendered.includes('{{') }).toEqual({
          type: t.type_code,
          leftover: false,
        });
      }
      const used = new Set(
        [...`${t.title_template ?? ''}${t.body_template}`.matchAll(/\{\{[#^/]?(\w+)/g)].map(
          (m) => m[1],
        ),
      );
      expect({ type: t.type_code, unused: t.variables.filter((v) => !used.has(v)) }).toEqual({
        type: t.type_code,
        unused: [],
      });
    }
  });

  it('SMS only for SMS-eligible types; urgent account notices are locked on', async () => {
    const rows = await admin<
      {
        code: string;
        default_channels: string[];
        sms_eligible: boolean;
        is_urgent: boolean;
        user_configurable: boolean;
      }[]
    >`
      select code, default_channels, sms_eligible, is_urgent, user_configurable from notification_types`;
    for (const r of rows) {
      if (r.default_channels.includes('sms'))
        expect({ code: r.code, sms: r.sms_eligible }).toEqual({ code: r.code, sms: true });
    }
    expect(
      rows
        .filter((r) => r.sms_eligible)
        .map((r) => r.code)
        .sort(),
    ).toEqual(['appeal_decided', 'ban_issued']);
    for (const code of ['ban_issued', 'appeal_decided']) {
      expect(rows.find((r) => r.code === code)).toMatchObject({
        is_urgent: true,
        user_configurable: false,
      });
    }
  });

  it('only the worker collapses a notification; a user sees only their own', async () => {
    const [row] = await admin<{ id: string }[]>`
      insert into notifications (user_id, type_code, title, body) values (${U(1)}, 'new_message', 'নতুন মেসেজ', '...')
      returning id`;
    const collapse = (context: Context) =>
      withContext(app, context, (tx) =>
        tx`update notifications set collapse_count = collapse_count + 1 where id = ${row!.id} returning id`.then(
          (r) => r.length,
        ),
      );
    expect(await collapse(WORKER)).toBe(1);
    // The owner may mark it read (0009) — that policy covers their own row only.
    expect(await collapse({ user_id: U(2), role: 'member' })).toBe(0);
    const seen = (n: number) =>
      withContext(
        app,
        { user_id: U(n), role: 'member' },
        (tx) => tx`select id from notifications where id = ${row!.id}`,
      );
    expect(await seen(1)).toHaveLength(1);
    expect(await seen(2)).toHaveLength(0);
  });

  it('preferences: the owner reads and writes theirs, the worker reads all, nobody else', async () => {
    await withContext(
      app,
      { user_id: U(1), role: 'member' },
      (tx) =>
        tx`insert into user_notification_preferences (user_id, type_code, channel_code, is_enabled)
         values (${U(1)}, 'new_message', 'push', false)`,
    );
    const read = (context: Context) =>
      withContext(app, context, (tx) =>
        tx`select 1 from user_notification_preferences where user_id = ${U(1)}`.then(
          (r) => r.length,
        ),
      );
    expect(await read({ user_id: U(1), role: 'member' })).toBe(1);
    expect(await read(WORKER)).toBe(1);
    expect(await read({ user_id: U(2), role: 'member' })).toBe(0);
    const forged = withContext(
      app,
      { user_id: U(2), role: 'member' },
      (tx) =>
        tx`insert into user_notification_preferences (user_id, type_code, channel_code, is_enabled)
         values (${U(1)}, 'new_message', 'email', true)`,
    );
    expect(await rejection(forged)).toBe('42501');
  });

  it('register_push_token: the caller’s device, moved from anyone who held it', async () => {
    const register = (n: number, token: string) =>
      withContext(
        app,
        { user_id: U(n), role: 'member' },
        (tx) => tx<{ id: string }[]>`select public.register_push_token('android', ${token}) as id`,
      );
    const [first] = await register(1, 'fcm-db-token');
    const [again] = await register(1, 'fcm-db-token');
    expect(again!.id).toBe(first!.id);
    await register(2, 'fcm-db-token');
    const holders = await admin<
      { user_id: string }[]
    >`select user_id from user_devices where push_token = 'fcm-db-token'`;
    expect(holders).toEqual([{ user_id: U(2) }]);
    expect(
      await rejection(
        withContext(
          app,
          { role: 'anon' },
          (tx) => tx`select public.register_push_token('web', 'x')`,
        ),
      ),
    ).toBe('42501');
  });
});
