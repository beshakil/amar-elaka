import type { Sql, TransactionSql } from 'postgres';
import {
  resolveTestAppDatabaseUrl,
  resolveTestDatabaseUrl,
  testSqlClient,
} from './db/test-database';

/**
 * Reviews in the database (0057, ADR 061), as ae_app under RLS:
 *  - the anti-fake rule: no contact → no review; too soon; after the window;
 *    a chat lead counts; a contact by user before any membership counts;
 *    the store's own people never review it; one review per store;
 *  - the edit window; a moderator's decision can't be edited away;
 *  - the integrity flags: low trust, burst, shared device, phone pattern,
 *    similar text — each holds the review for a moderator;
 *  - the owner can never delete (or rewrite) a review — they report it;
 *    the store's reply is the owner's or a manager's, never an editor's;
 *  - decide_review writes moderation_actions and closes the reports;
 *  - the aggregate (stores.rating_avg/count) is the trigger's, not the owner's;
 *  - the author scrub keeps the rating, refuses under a legal hold;
 *  - review prompts: once per member and store, never the owner, never old;
 *  - cross-tenant: tenant B's moderator sees none of tenant A's reviews,
 *    prompts or scores.
 */

const P = '0191e3a0-7e1e-7000-8000-';
const FIXTURE = `${P}%`;
const PARTNER = `${P}000000000001`;
const AREA_A = `${P}000000000011`;
const AREA_B = `${P}000000000012`;
const TENANT_A = `${P}000000000021`;
const TENANT_B = `${P}000000000022`;
const U = (n: number) => `${P}0000000000${30 + n}`;
const M = (n: number) => `${P}0000000000${50 + n}`;
/** A phone per user whose first 12 characters differ (the phone-pattern rule's default prefix). */
const PHONE = (n: number) => `+88019${String(n).padStart(2, '0')}123456`;
const [
  OWNER,
  MANAGER,
  EDITOR,
  BUYER,
  BUYER2,
  BUYER3,
  BUYER4,
  MOD,
  MOD_B,
  OUTSIDER,
  TWIN,
  LOWTRUST,
] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const STORE = `${P}000000000071`;
const STORE2 = `${P}000000000072`;

type Context = Partial<
  Record<'tenant_id' | 'user_id' | 'member_id' | 'role' | 'is_platform_admin', string>
>;
const as = (n: number, tenant = TENANT_A, role = 'member'): Context => ({
  tenant_id: tenant,
  user_id: U(n),
  member_id: M(n),
  role,
});

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

describe('Reviews in the database (0057)', () => {
  let app: Sql;
  let admin: Sql;

  /** A contact from user n to a store, `hoursAgo` ago. */
  const contact = (
    n: number,
    store: string,
    hoursAgo: number,
    channel = 'call_click',
    withMember = true,
  ) =>
    admin`insert into lead_events (tenant_id, channel_code, source_code, store_id, actor_member_id, actor_user_id, occurred_at)
          values (${TENANT_A}, ${channel}, 'store_page', ${store}, ${withMember ? M(n) : null}, ${U(n)},
                  now() - make_interval(hours => ${hoursAgo}))`;

  const eligibility = (n: number, store = STORE) =>
    withContext(
      app,
      as(n),
      (tx) =>
        tx<{ status: string }[]>`select status from public.review_eligibility(${store}::uuid)`,
    ).then((r) => r[0]!.status);

  const submit = (
    n: number,
    opts: { store?: string; rating?: number; body?: string | null; trust?: number } = {},
  ) =>
    withContext(
      app,
      as(n),
      (tx) =>
        tx<{ review_id: string; status_code: string; flags: string[] }[]>`
        select review_id, status_code, flags
        from public.submit_review(${opts.store ?? STORE}::uuid, ${opts.rating ?? 4}::smallint, ${opts.body ?? null},
                                  '{}'::uuid[], ${opts.trust ?? 50}::integer)`,
    ).then((r) => r[0]!);

  const storeRating = () =>
    admin<{ rating_avg: string | null; rating_count: number }[]>`
      select rating_avg, rating_count from stores where id = ${STORE}`.then((r) => r[0]!);

  async function cleanUp(): Promise<void> {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of [
        'moderation_actions',
        'reports',
        'review_responses',
        'media_attachments',
        'reviews',
        'review_prompts',
        'store_seller_scores',
        'lead_events',
        'store_members',
        'stores',
        'tenant_settings',
        'tenant_members',
      ]) {
        await tx.unsafe(`delete from ${table} where tenant_id::text like $1`, [FIXTURE]);
      }
    });
    await admin`delete from legal_holds where subject_id::text like ${FIXTURE}`;
    await admin`delete from user_devices where user_id::text like ${FIXTURE}`;
    await admin`delete from tenants where id::text like ${FIXTURE}`;
    await admin`delete from partners where id::text like ${FIXTURE}`;
    await admin`delete from geo_areas where id::text like ${FIXTURE}`;
    await admin`delete from users where id::text like ${FIXTURE}`;
  }

  beforeAll(async () => {
    app = testSqlClient(4, resolveTestAppDatabaseUrl());
    admin = testSqlClient(1, resolveTestDatabaseUrl());
    await cleanUp();
    const users = [
      OWNER,
      MANAGER,
      EDITOR,
      BUYER,
      BUYER2,
      BUYER3,
      BUYER4,
      MOD,
      MOD_B,
      OUTSIDER,
      TWIN,
      LOWTRUST,
    ];
    for (const n of users) {
      // TWIN's number differs from the owner's only in its last two digits (sequential SIMs).
      const phone = n === TWIN ? PHONE(OWNER).slice(0, 12) + '99' : PHONE(n);
      await admin`insert into users (id, phone_e164) values (${U(n)}, ${phone})`;
    }
    await admin`insert into partners (id, legal_name, display_name, phone_e164)
                values (${PARTNER}, 'Review Fixture', 'Review Fixture', '+8801747000099')`;
    await admin`insert into geo_areas (id, adm_level, level_code, bbs_code_geocode11, name_en, source_release) values
      (${AREA_A}, 3, 'upazila', 'review-db-a', 'Review A', 'fixture'),
      (${AREA_B}, 3, 'upazila', 'review-db-b', 'Review B', 'fixture')`;
    await admin`insert into tenants (id, partner_id, geo_area_id, slug, name_bn, name_en, map_center, status_code) values
      (${TENANT_A}, ${PARTNER}, ${AREA_A}, 'review-db-a', 'এ', 'A', st_point(91.1, 22.1)::geography, 'active'),
      (${TENANT_B}, ${PARTNER}, ${AREA_B}, 'review-db-b', 'বি', 'B', st_point(91.2, 22.1)::geography, 'active')`;
    for (const n of users.filter((u) => u !== MOD && u !== MOD_B && u !== OUTSIDER)) {
      await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values (${M(n)}, ${TENANT_A}, ${U(n)}, 'member')`;
    }
    await admin`insert into tenant_members (id, tenant_id, user_id, role_code) values
      (${M(MOD)}, ${TENANT_A}, ${U(MOD)}, 'moderator'), (${M(MOD_B)}, ${TENANT_B}, ${U(MOD_B)}, 'moderator')`;
    await admin.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`insert into stores (id, tenant_id, owner_member_id, slug, name_bn, status_code) values
        (${STORE}, ${TENANT_A}, ${M(OWNER)}, 'review-db-store', 'রিভিউ দোকান', 'active'),
        (${STORE2}, ${TENANT_A}, ${M(OWNER)}, 'review-db-store-2', 'দ্বিতীয় দোকান', 'active')`;
      await tx`insert into store_members (tenant_id, store_id, member_id, role_code, accepted_at) values
        (${TENANT_A}, ${STORE}, ${M(MANAGER)}, 'manager', now()),
        (${TENANT_A}, ${STORE}, ${M(EDITOR)}, 'editor', now())`;
    });
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await Promise.all([app.end(), admin.end()]);
    }
  });

  describe('eligibility — the anti-fake rule', () => {
    it('no contact: cannot review (AE601)', async () => {
      expect(await eligibility(BUYER3)).toBe('no_contact');
      expect(await rejection(submit(BUYER3))).toBe('AE601');
    });

    it('a contact a moment ago is too soon', async () => {
      await contact(BUYER3, STORE2, 1);
      expect(await eligibility(BUYER3, STORE2)).toBe('too_soon');
      expect(await rejection(submit(BUYER3, { store: STORE2 }))).toBe('AE601');
    });

    it('after the window: rejected', async () => {
      await contact(BUYER4, STORE2, 24 * 100);
      expect(await eligibility(BUYER4, STORE2)).toBe('expired');
      expect(await rejection(submit(BUYER4, { store: STORE2 }))).toBe('AE601');
    });

    it('a contact in the window: eligible, published, counted; once per store', async () => {
      await contact(BUYER, STORE, 48);
      expect(await eligibility(BUYER)).toBe('eligible');
      const written = await submit(BUYER, { rating: 5, body: 'খুব ভালো দোকান, সময়মতো দিয়েছে' });
      expect(written).toMatchObject({ status_code: 'published', flags: [] });
      const [row] = await admin<
        { lead_event_id: string | null; has_verified_interaction: boolean }[]
      >`
        select lead_event_id, has_verified_interaction from reviews where id = ${written.review_id}`;
      expect(row!.lead_event_id).not.toBeNull();
      expect(row!.has_verified_interaction).toBe(true);
      expect(await storeRating()).toEqual({ rating_avg: '5.00', rating_count: 1 });
      expect(await eligibility(BUYER)).toBe('already_reviewed');
      expect(await rejection(submit(BUYER))).toBe('AE601');
    });

    it('a chat the store answered counts as a contact', async () => {
      await contact(BUYER2, STORE, 30, 'chat_started');
      expect(await eligibility(BUYER2)).toBe('eligible');
    });

    it('a contact made before any membership (by user only) still proves it', async () => {
      await contact(BUYER3, STORE, 30, 'whatsapp_click', false);
      expect(await eligibility(BUYER3)).toBe('eligible');
    });

    it("the store's owner and staff never review it", async () => {
      await contact(OWNER, STORE, 30);
      await contact(EDITOR, STORE, 30);
      expect(await eligibility(OWNER)).toBe('own_store');
      expect(await eligibility(EDITOR)).toBe('own_store');
    });

    it('a member cannot write a review row directly (no policy, no grant)', async () => {
      const direct = withContext(
        app,
        as(BUYER2),
        (tx) =>
          tx`insert into reviews (reviewer_member_id, store_id, rating) values (${M(BUYER2)}, ${STORE}, 5)`,
      );
      expect(await rejection(direct)).toBe('42501');
    });
  });

  describe('editing', () => {
    it('within review_edit_days: edited; after: AE605', async () => {
      const id = (
        await admin<{ id: string }[]>`select id from reviews where reviewer_member_id = ${M(BUYER)}`
      )[0]!.id;
      const edit = () =>
        withContext(
          app,
          as(BUYER),
          (tx) =>
            tx`select * from public.edit_review(${id}::uuid, 4::smallint, 'ভালো, তবে একটু দেরি', '{}'::uuid[], 50)`,
        );
      await edit();
      expect(await storeRating()).toEqual({ rating_avg: '4.00', rating_count: 1 });
      await admin`update reviews set created_at = now() - interval '31 days' where id = ${id}`;
      expect(await rejection(edit())).toBe('AE605');
      await admin`update reviews set created_at = now() where id = ${id}`;
    });
  });

  describe('integrity flags hold the review for a moderator', () => {
    it('very low trust', async () => {
      await contact(LOWTRUST, STORE2, 30);
      const r = await submit(LOWTRUST, { store: STORE2, trust: 5 });
      expect(r).toMatchObject({ status_code: 'pending', flags: ['low_trust'] });
    });

    it("sharing a device with the store's people", async () => {
      await admin`insert into user_devices (user_id, platform_code, fingerprint_hash) values
        (${U(OWNER)}, 'android', 'review-db-shared-fp'), (${U(BUYER2)}, 'android', 'review-db-shared-fp')`;
      const r = await submit(BUYER2, { body: 'অসাধারণ সার্ভিস' });
      expect(r.status_code).toBe('pending');
      expect(r.flags).toContain('shared_device');
    });

    it("a phone number next to the owner's (sequential SIMs)", async () => {
      await contact(TWIN, STORE, 30);
      const r = await submit(TWIN, { body: 'দোকানদার খুব ভদ্র, জিনিসও ভালো মানের ছিল' });
      expect(r.flags).toContain('phone_pattern');
    });

    it('nearly the same text as another review of the store', async () => {
      await contact(BUYER4, STORE, 30);
      const r = await submit(BUYER4, { body: 'দোকানদার খুব ভদ্র, জিনিসও ভালো মানের ছিল!' });
      expect(r.flags).toContain('similar_text');
    });

    it('a burst of reviews on one store', async () => {
      await admin`insert into tenant_settings (tenant_id, setting_overrides)
                  values (${TENANT_A}, '{"review_burst_count": 2}'::jsonb)
                  on conflict (tenant_id) do update set setting_overrides = excluded.setting_overrides`;
      await contact(BUYER3, STORE2, 30);
      const r = await submit(BUYER3, { store: STORE2, trust: 50 });
      expect(r.flags).toContain('burst');
      await admin`update tenant_settings set setting_overrides = '{}'::jsonb where tenant_id = ${TENANT_A}`;
    });
  });

  describe('the store: reply and report, never delete', () => {
    const buyerReview = () =>
      admin<{ id: string }[]>`select id from reviews where reviewer_member_id = ${M(BUYER)}`.then(
        (r) => r[0]!.id,
      );
    const reply = (n: number, id: string, text: string) =>
      withContext(
        app,
        as(n),
        (tx) =>
          tx<
            { created: boolean }[]
          >`select created from public.respond_to_review(${id}::uuid, ${text})`,
      ).then((r) => r[0]!.created);

    it('the owner cannot delete or rewrite a review (RLS: nothing happens / no grant)', async () => {
      const id = await buyerReview();
      const del = withContext(app, as(OWNER), (tx) => tx`delete from reviews where id = ${id}`);
      expect(await rejection(del)).toBe('42501');
      const upd = withContext(
        app,
        as(OWNER),
        (tx) => tx`update reviews set rating = 5 where id = ${id}`,
      );
      expect(await rejection(upd)).toBe('42501');
      expect((await admin`select 1 from reviews where id = ${id}`).length).toBe(1);
    });

    it("the owner's own rating columns are the aggregate's, not theirs", async () => {
      await withContext(
        app,
        as(OWNER),
        (tx) => tx`update stores set rating_avg = 5, rating_count = 999 where id = ${STORE}`,
      );
      expect((await storeRating()).rating_count).not.toBe(999);
    });

    it('the owner replies, a manager edits it; an editor or a stranger cannot (AE607)', async () => {
      const id = await buyerReview();
      expect(await reply(OWNER, id, 'ধন্যবাদ!')).toBe(true);
      expect(await reply(MANAGER, id, 'অনেক ধন্যবাদ, আবার আসবেন।')).toBe(false);
      expect(await rejection(reply(EDITOR, id, 'হাই'))).toBe('AE607');
      expect(await rejection(reply(BUYER2, id, 'হাই'))).toBe('AE607');
      const [r] = await admin<{ body: string; edited_at: Date | null }[]>`
        select body, edited_at from review_responses where review_id = ${id}`;
      expect(r).toMatchObject({ body: 'অনেক ধন্যবাদ, আবার আসবেন।' });
      expect(r!.edited_at).not.toBeNull();
    });

    it('the owner reports it (once); the author cannot report their own (AE609)', async () => {
      const id = await buyerReview();
      const report = (n: number) =>
        withContext(
          app,
          as(n),
          (tx) =>
            tx<
              { created: boolean }[]
            >`select created from public.report_review(${id}::uuid, 'fake_review', 'ভুয়া')`,
        ).then((r) => r[0]!.created);
      expect(await report(OWNER)).toBe(true);
      expect(await report(OWNER)).toBe(false);
      expect(await rejection(report(BUYER))).toBe('AE609');
    });
  });

  describe('moderation', () => {
    it('the queue shows held and reported reviews to staff only', async () => {
      const queue = (ctx: Context) =>
        withContext(
          app,
          ctx,
          (tx) =>
            tx<
              { review_id: string; status_code: string }[]
            >`select review_id, status_code from public.review_queue_page(null, 50)`,
        );
      const rows = await queue(as(MOD, TENANT_A, 'moderator'));
      expect(rows.some((r) => r.status_code === 'pending')).toBe(true);
      expect(rows.some((r) => r.status_code === 'published')).toBe(true);
      expect(await rejection(queue(as(BUYER)))).toBe('42501');
    });

    it('a decision writes moderation_actions and closes the reports, in one go', async () => {
      const id = (
        await admin<{ id: string }[]>`select id from reviews where reviewer_member_id = ${M(BUYER)}`
      )[0]!.id;
      const before = await storeRating();
      const [result] = await withContext(
        app,
        as(MOD, TENANT_A, 'moderator'),
        (tx) => tx<{ status_code: string; reports_closed: number }[]>`
          select status_code, reports_closed from public.decide_review(${id}::uuid, 'hide', 'fake_review', 'contact proven fake')`,
      );
      expect(result).toEqual({ status_code: 'hidden', reports_closed: 1 });
      const [action] = await admin<{ action_code: string; reason_code: string }[]>`
        select action_code, reason_code from moderation_actions where review_id = ${id}`;
      expect(action).toEqual({ action_code: 'rejected', reason_code: 'fake_review' });
      expect((await storeRating()).rating_count).toBe(before.rating_count - 1);
      // A decision can't be edited away by the author.
      const edit = withContext(
        app,
        as(BUYER),
        (tx) =>
          tx`select * from public.edit_review(${id}::uuid, 5::smallint, null, '{}'::uuid[], 50)`,
      );
      expect(await rejection(edit)).toBe('AE606');
    });

    it('a member cannot decide', async () => {
      const id = (
        await admin<
          { id: string }[]
        >`select id from reviews where reviewer_member_id = ${M(BUYER2)}`
      )[0]!.id;
      const decide = withContext(
        app,
        as(OWNER),
        (tx) => tx`select * from public.decide_review(${id}::uuid, 'remove', 'spam', null)`,
      );
      expect(await rejection(decide)).toBe('42501');
    });
  });

  describe('cross-tenant', () => {
    it("tenant B's moderator reads none of tenant A's reviews, prompts or scores", async () => {
      const seen = await withContext(app, as(MOD_B, TENANT_B, 'moderator'), async (tx) => ({
        reviews: (await tx`select 1 from reviews where tenant_id = ${TENANT_A}`).length,
        prompts: (await tx`select 1 from review_prompts where tenant_id = ${TENANT_A}`).length,
        scores: (await tx`select 1 from store_seller_scores where tenant_id = ${TENANT_A}`).length,
        queue: (await tx`select 1 from public.review_queue_page(null, 50)`).length,
      }));
      expect(seen).toEqual({ reviews: 0, prompts: 0, scores: 0, queue: 0 });
    });

    it("decide_review in tenant B cannot reach tenant A's review (AE608)", async () => {
      const id = (
        await admin<
          { id: string }[]
        >`select id from reviews where reviewer_member_id = ${M(BUYER2)}`
      )[0]!.id;
      const decide = withContext(
        app,
        as(MOD_B, TENANT_B, 'moderator'),
        (tx) => tx`select * from public.decide_review(${id}::uuid, 'remove', 'spam', null)`,
      );
      expect(await rejection(decide)).toBe('AE608');
    });
  });

  describe('review prompts', () => {
    const due = () =>
      withContext(
        app,
        { role: 'system' },
        (tx) =>
          tx<
            { store_id: string; user_id: string }[]
          >`select store_id, user_id from public.due_review_prompts(100)`,
      );

    it('once per member and store, never the owner, never a store already reviewed, never stale', async () => {
      await admin`delete from lead_events where tenant_id = ${TENANT_A}`;
      await contact(OUTSIDER, STORE2, 49, 'call_click', false); // due
      await contact(OUTSIDER, STORE2, 50, 'whatsapp_click', false); // same member and store: one prompt
      await contact(OWNER, STORE2, 49); // the store's own owner
      await contact(BUYER, STORE, 49); // already reviewed STORE
      await contact(MANAGER, STORE2, 24 * 10); // too old
      const first = await due();
      expect(first).toEqual([{ store_id: STORE2, user_id: U(OUTSIDER) }]);
      expect(await due()).toEqual([]);
      const anon = withContext(
        app,
        as(BUYER),
        (tx) => tx`select * from public.due_review_prompts(10)`,
      );
      expect(await rejection(anon)).toBe('42501');
    });
  });

  describe('the author scrub', () => {
    const scrub = (ctx: Context) =>
      withContext(
        app,
        ctx,
        (tx) =>
          tx<
            { n: number }[]
          >`select public.scrub_review_author(${U(BUYER4)}::uuid, 'privacy request #42') as n`,
      ).then((r) => r[0]!.n);
    const admin_ = { user_id: U(MOD), role: 'platform_admin', is_platform_admin: 'true' };

    it('platform admins only', async () => {
      expect(await rejection(scrub(as(MOD, TENANT_A, 'moderator')))).toBe('42501');
    });

    it('refused under a legal hold on the user (AE613)', async () => {
      await admin`insert into legal_holds (subject_tenant_id, subject_type_code, subject_id, reason, placed_by_user_id)
                  values (${TENANT_A}, 'user', ${U(BUYER4)}, 'court order', ${U(MOD)})`;
      expect(await rejection(scrub(admin_))).toBe('AE613');
      await admin`delete from legal_holds where subject_id = ${U(BUYER4)}`;
    });

    it('removes the name and the text, keeps the rating in the aggregate', async () => {
      await admin`update reviews set status_code = 'published', flags = '{}' where reviewer_member_id = ${M(BUYER4)}`;
      const before = await storeRating();
      expect(await scrub(admin_)).toBe(1);
      const [r] = await admin<
        { body: string | null; author_scrubbed_at: Date | null; rating: number }[]
      >`
        select body, author_scrubbed_at, rating from reviews where reviewer_member_id = ${M(BUYER4)}`;
      expect(r!.body).toBeNull();
      expect(r!.author_scrubbed_at).not.toBeNull();
      expect(await storeRating()).toEqual(before);
      const [page] = await withContext(
        app,
        { tenant_id: TENANT_A, role: 'anon' },
        (tx) =>
          tx<{ author_name: string | null; author_scrubbed: boolean }[]>`
          select author_name, author_scrubbed from public.store_review_page(${STORE}::uuid, null, 50)
          where author_scrubbed`,
      );
      expect(page).toEqual({ author_name: null, author_scrubbed: true });
      const [action] = await admin<{ action_code: string }[]>`
        select action_code from moderation_actions where review_id = (
          select id from reviews where reviewer_member_id = ${M(BUYER4)})`;
      expect(action!.action_code).toBe('privacy_scrub');
    });
  });
});
