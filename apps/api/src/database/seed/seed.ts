import { createHash } from 'node:crypto';
import postgres, { type TransactionSql } from 'postgres';
import { loadDotenv } from '../../config/load-dotenv';
import {
  importBoundaries,
  importReference,
  PILOT_BOUNDARIES_PATH,
  readBoundaries,
  readReference,
  reparentPointsByContainment,
} from '../../locations/geo-import/geo-import';
import {
  checkPublishable,
  compileFieldsValidator,
  validationContextAt,
  type FieldSchema,
  type FieldValues,
} from '../../categories/field-schema';
import { CATEGORIES, type CategoryDef } from './data/categories';
import { authoredDefinitionOf, definitionOf } from './data/category-dsl';
import { sampleFields } from './data/category-samples';
import {
  BAZAR_COMMODITIES,
  COMMUNITY_MEMBER_NAMES,
  NAMED_USERS,
  TENANT_SLUGS,
} from './data/fixtures';
import { centroidOf, GEO_AREAS, randomPointIn, type GeoAreaDef } from './data/geo';
import { intBetween, pick, rngFor, seedId } from './ids';

/**
 * Idempotent dev-data seed. Every row's id is deterministic (`seedId`), and
 * every insert is `ON CONFLICT (id) DO NOTHING`, so running this twice is a
 * no-op the second time — safe to re-run after `db:reset` or by hand.
 *
 * Connects as ae_migrator (MIGRATION_DATABASE_URL) with `app.role = system`
 * and `app.is_platform_admin = true` for the whole transaction: every
 * table's RLS has a platform/system override policy (docs/specs/schema.md
 * §0.6), so this one flag combination satisfies every table's write policy
 * without needing to switch `app.tenant_id` between tenants or fake a
 * specific actor per row — the same pattern migrations 0010/0012 use for
 * their own privileged seed INSERTs. This still goes *through* RLS with a
 * declared role, not BYPASSRLS (CLAUDE.md hard rule 1).
 */

async function main(): Promise<void> {
  loadDotenv();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL to run the seed script.');

  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.role', 'system', true)`;
      await tx`select set_config('app.is_platform_admin', 'true', true)`;

      const partnerId = await seedPartner(tx);
      const geoAreaIdBySlug = await seedGeoAreas(tx);
      const tenantIds = await seedTenants(tx, partnerId, geoAreaIdBySlug);
      const userIds = await seedUsers(tx);
      const memberIds = await seedTenantMembers(tx, tenantIds, userIds);
      const categoryIds = await seedCategories(tx, userIds.get('platform-admin')!);
      await seedTenantCategories(tx, tenantIds, categoryIds);
      const commodityIds = await seedBazarCommodities(tx);
      const bazarMarketIds = await seedBazarMarkets(tx, tenantIds);
      const storeIds = await seedStores(tx, tenantIds, memberIds, categoryIds);
      await seedPosts(tx, tenantIds, memberIds, storeIds, categoryIds, geoAreaIdBySlug);
      await seedPlaces(tx, tenantIds, memberIds, categoryIds, geoAreaIdBySlug);
      await seedPlaceModeration(tx, tenantIds, memberIds);
      await seedSavedAndFollows(tx, userIds.get('buyer')!);
      await seedSearchQueries(tx, tenantIds);
      await seedSavedSearches(tx, tenantIds, userIds.get('buyer')!);
      await seedEmergencyContacts(tx, tenantIds);
      await seedBloodDonors(tx, tenantIds, memberIds);
      await seedBazarPrices(
        tx,
        tenantIds,
        commodityIds,
        bazarMarketIds,
        userIds.get('tenant-admin')!,
      );
      await seedAnalyticsHistory(tx, tenantIds);
      await seedStoreImport(tx, storeIds[0]!, categoryIds.get('gadgets-electronics')!);
      await seedStock(tx);
      await seedChat(tx, memberIds, storeIds[0]!);
      await seedReviews(tx, memberIds, storeIds[0]!);
      await seedVerifications(tx, memberIds, storeIds[0]!);
      await seedBansAndComplaints(tx, memberIds, storeIds[0]!);
    });
    console.log('Seed complete.');
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Chat (ADR 058)
// ---------------------------------------------------------------------------

/**
 * The Mirpur buyer's two conversations — about another member's live post
 * (with the seller's reply, so the chat lead exists) and with the first
 * store — the store's quick replies, and one open conversation report with
 * its transcript, so the inbox, the composer and the moderators' chat queue
 * all show something in dev. Messages go in through the 0054 trigger like
 * real ones (unread counts, watermarks).
 */
async function seedChat(tx: TransactionSql, memberIds: MemberIds, storeId: string): Promise<void> {
  const buyer = memberIds.mirpur.buyer;
  const [post] = await tx<
    { id: string; tenant_id: string; author_member_id: string; title: string }[]
  >`
    select id, tenant_id, author_member_id, title from posts
    where tenant_id = (select tenant_id from tenant_members where id = ${buyer})
      and status_code = 'live' and author_member_id is not null and author_member_id <> ${buyer}
      and store_id is null
    order by id limit 1`;
  const [store] = await tx<{ tenant_id: string; owner_member_id: string }[]>`
    select tenant_id, owner_member_id from stores where id = ${storeId}`;
  if (!post || !store) return;

  const aboutPost = seedId('conversation:post');
  const withStore = seedId('conversation:store');
  await tx`
    insert into conversations (id, tenant_id, kind_code, post_id, store_id, dedupe_key, created_by_member_id,
                               origin_source_code, first_seller_reply_at)
    values
      (${aboutPost}, ${post.tenant_id}, 'post_inquiry', ${post.id}, null, ${`post:${post.id}:${buyer}`}, ${buyer},
       'post_detail', now()),
      (${withStore}, ${store.tenant_id}, 'store_inquiry', null, ${storeId}, ${`store:${storeId}:${buyer}`}, ${buyer},
       'store_page', null)
    on conflict (id) do nothing`;
  await tx`
    insert into conversation_participants (tenant_id, conversation_id, member_id, role_code) values
      (${post.tenant_id}, ${aboutPost}, ${buyer}, 'buyer'),
      (${post.tenant_id}, ${aboutPost}, ${post.author_member_id}, 'seller'),
      (${store.tenant_id}, ${withStore}, ${buyer}, 'buyer'),
      (${store.tenant_id}, ${withStore}, ${store.owner_member_id}, 'seller')
    on conflict do nothing`;
  const tenantOf = new Map([
    [aboutPost, post.tenant_id],
    [withStore, store.tenant_id],
  ]);
  const lines: [string, string, string, string][] = [
    [aboutPost, buyer, 'seed-chat-1', 'আসসালামু আলাইকুম, এটা কি এখনো আছে?'],
    [aboutPost, post.author_member_id, 'seed-chat-2', 'জি আছে। দেখতে আসতে পারেন।'],
    [aboutPost, buyer, 'seed-chat-3', 'দাম কি একটু কমবে?'],
    [withStore, buyer, 'seed-chat-4', 'আপনারা কি হোম ডেলিভারি দেন?'],
  ];
  for (const [conversationId, sender, clientId, body] of lines) {
    await tx`
      insert into messages (id, tenant_id, conversation_id, sender_member_id, kind_code, body, client_message_id)
      values (${seedId(`message:${clientId}`)}, ${tenantOf.get(conversationId)!}, ${conversationId}, ${sender}, 'text', ${body}, ${clientId})
      on conflict do nothing`;
  }
  // lead_events takes inserts only in its own tenant's context (0009).
  await tx`select set_config('app.tenant_id', ${post.tenant_id}, true)`;
  await tx`
    insert into lead_events (tenant_id, channel_code, source_code, post_id, target_member_id, actor_member_id)
    select ${post.tenant_id}, 'chat_started', 'post_detail', ${post.id}, ${post.author_member_id}, ${buyer}
    where not exists (
      select 1 from lead_events where channel_code = 'chat_started' and post_id = ${post.id} and actor_member_id = ${buyer})`;
  await tx`select set_config('app.tenant_id', '', true)`;

  const replies = [
    'জি, আছে। কবে আসবেন?',
    'দাম ফিক্সড, তবে ডেলিভারি ফ্রি।',
    'সকাল ১০টা থেকে রাত ৯টা খোলা।',
  ];
  for (const [i, body] of replies.entries()) {
    await tx`
      insert into store_quick_replies (id, tenant_id, store_id, body, sort_order, created_by_member_id)
      values (${seedId(`quick-reply:${i}`)}, ${store.tenant_id}, ${storeId}, ${body}, ${i}, ${store.owner_member_id})
      on conflict (id) do nothing`;
  }

  const reportId = seedId('report:conversation');
  await tx`
    insert into reports (id, tenant_id, reporter_member_id, conversation_id, reason_code, details)
    values (${reportId}, ${post.tenant_id}, ${post.author_member_id}, ${aboutPost}, 'spam', 'বারবার একই কথা লিখছে')
    on conflict (id) do nothing`;
  await tx`
    insert into conversation_report_snapshots (tenant_id, report_id, conversation_id, transcript, message_count)
    select ${post.tenant_id}, ${reportId}, ${aboutPost},
           jsonb_agg(jsonb_build_object(
             'id', m.id, 'senderMemberId', m.sender_member_id, 'senderRole', cp.role_code, 'kind', m.kind_code,
             'body', m.body, 'mediaAssetId', null, 'location', null, 'listing', null, 'systemEvent', null,
             'flaggedByFilter', m.flagged_by_filter, 'createdAt', m.created_at, 'deletedAt', m.deleted_at)
             order by m.id),
           count(*)
    from messages m
    join conversation_participants cp
      on cp.tenant_id = m.tenant_id and cp.conversation_id = m.conversation_id and cp.member_id = m.sender_member_id
    where m.conversation_id = ${aboutPost}
    on conflict (report_id) do nothing`;
  console.log(
    'chat: 2 conversations, 4 messages, 1 chat lead, 3 quick replies, 1 conversation report',
  );
}

// ---------------------------------------------------------------------------
// Reviews and the seller score (ADR 061)
// ---------------------------------------------------------------------------

/**
 * The first store's reviews: the Mirpur buyer's (proven by a call three
 * days ago, published, with the owner's reply) and a community member's held
 * for a moderator (low trust) — so the store page, the seller panel and the
 * moderators' review queue all show something; a "how was it?" already sent
 * to another member; and a stale seller score, computed on its first read.
 */
async function seedReviews(
  tx: TransactionSql,
  memberIds: MemberIds,
  storeId: string,
): Promise<void> {
  const [store] = await tx<{ tenant_id: string; owner_member_id: string }[]>`
    select tenant_id, owner_member_id from stores where id = ${storeId}`;
  const [held, prompted] = memberIds.mirpur.community;
  if (!store || !held || !prompted) return;
  const contacts: [string, string, number][] = [
    [memberIds.mirpur.buyer, 'call_click', 3],
    [held, 'whatsapp_click', 5],
    [prompted, 'call_click', 3],
  ];
  const leadIds = new Map<string, string>();
  // lead_events takes inserts only in its own tenant's context (0009).
  await tx`select set_config('app.tenant_id', ${store.tenant_id}, true)`;
  for (const [member, channel, daysAgo] of contacts) {
    const id = seedId(`lead:review:${member}`);
    leadIds.set(member, id);
    await tx`
      insert into lead_events (id, tenant_id, channel_code, source_code, store_id, target_member_id,
                               actor_member_id, actor_user_id, occurred_at)
      select ${id}, ${store.tenant_id}, ${channel}, 'store_page', ${storeId}, ${store.owner_member_id},
             ${member}, tm.user_id, now() - make_interval(days => ${daysAgo})
      from tenant_members tm where tm.id = ${member}
      on conflict (id) do nothing`;
  }
  await tx`select set_config('app.tenant_id', '', true)`;
  const published = seedId('review:buyer');
  await tx`
    insert into reviews (id, tenant_id, reviewer_member_id, store_id, rating, body, has_verified_interaction,
                         status_code, lead_event_id, flags)
    values
      (${published}, ${store.tenant_id}, ${memberIds.mirpur.buyer}, ${storeId}, 5,
       'দোকানদার খুব ভদ্র, পণ্য যেমন বলেছেন তেমনই পেয়েছি। ডেলিভারিও সময়মতো।', true, 'published',
       ${leadIds.get(memberIds.mirpur.buyer)!}, '{}'),
      (${seedId('review:held')}, ${store.tenant_id}, ${held}, ${storeId}, 1,
       'একদম বাজে, কেউ কিনবেন না!!!', true, 'pending', ${leadIds.get(held)!}, '{low_trust}')
    on conflict (id) do nothing`;
  await tx`
    insert into review_responses (id, tenant_id, review_id, responder_member_id, body)
    values (${seedId('review-response:buyer')}, ${store.tenant_id}, ${published}, ${store.owner_member_id},
            'অনেক ধন্যবাদ! আবার আসবেন।')
    on conflict do nothing`;
  await tx`
    insert into review_prompts (id, tenant_id, store_id, user_id, lead_event_id)
    select ${seedId('review-prompt')}, ${store.tenant_id}, ${storeId}, tm.user_id, ${leadIds.get(prompted)!}
    from tenant_members tm where tm.id = ${prompted}
    on conflict do nothing`;
  await tx`
    insert into store_seller_scores (tenant_id, store_id, score, tier_code, algorithm_version, next_recompute_at)
    values (${store.tenant_id}, ${storeId}, 0, 'new', 1, now())
    on conflict (tenant_id, store_id) do nothing`;
  console.log(
    'reviews: 1 published (with a reply), 1 held for a moderator, 1 review prompt, 1 stale seller score',
  );
}

// ---------------------------------------------------------------------------
// Verification (ADR 062)
// ---------------------------------------------------------------------------

/**
 * The first store's owner has a checked identity and the store a verified
 * business (both decided by the Mirpur moderator, so the badges show), and
 * the Mirpur buyer's identity request waits in the moderators' queue. No
 * evidence files: the seed has no storage, so the detail view says none.
 * The NID "hashes" are hashes of seed labels, never of a real number.
 */
async function seedVerifications(
  tx: TransactionSql,
  memberIds: MemberIds,
  storeId: string,
): Promise<void> {
  const [store] = await tx<{ tenant_id: string; owner_user_id: string }[]>`
    select s.tenant_id, tm.user_id as owner_user_id
    from stores s join tenant_members tm on tm.tenant_id = s.tenant_id and tm.id = s.owner_member_id
    where s.id = ${storeId}`;
  const [people] = await tx<{ moderator: string; buyer: string }[]>`
    select (select user_id from tenant_members where id = ${memberIds.mirpur.moderator}) as moderator,
           (select user_id from tenant_members where id = ${memberIds.mirpur.buyer}) as buyer`;
  if (!store || !people) return;
  const nidHash = (label: string): string =>
    createHash('sha256').update(`seed-nid:${label}`).digest('hex');
  await tx`
    insert into verifications (id, tenant_id, subject_type, subject_id, level_code, status_code,
                               submitted_by_user_id, nid_hash, nid_last3, reviewed_by_user_id, reviewed_at,
                               expires_at)
    values
      (${seedId('verification:owner')}, ${store.tenant_id}, 'member', ${store.owner_user_id}, 'identity_checked',
       'approved', ${store.owner_user_id}, ${nidHash('owner')}, '101', ${people.moderator},
       now() - interval '10 days', now() + interval '720 days'),
      (${seedId('verification:store')}, ${store.tenant_id}, 'store', ${storeId}, 'business_verified',
       'approved', ${store.owner_user_id}, null, null, ${people.moderator},
       now() - interval '9 days', now() + interval '356 days'),
      (${seedId('verification:buyer')}, ${store.tenant_id}, 'member', ${people.buyer}, 'identity_checked',
       'submitted', ${people.buyer}, ${nidHash('buyer')}, '202', null, null, null)
    on conflict (id) do nothing`;
  await tx`select public.refresh_verification_caches('member', ${store.owner_user_id})`;
  await tx`select public.refresh_verification_caches('store', ${storeId})`;
  console.log('verification: owner identity + store business approved, 1 identity request waiting');
}

// ---------------------------------------------------------------------------
// Bans, appeals, the blacklist and complaints (ADR 063)
// ---------------------------------------------------------------------------

/**
 * Something on every new screen: a Mirpur community member restricted for
 * 7 days (step 1 of the ladder) whose appeal waits for the area's admins; a
 * blacklist recommendation from Mirpur waiting for the platform; and two
 * complaints about the first store — one waiting (urgent scam), one resolved.
 */
async function seedBansAndComplaints(
  tx: TransactionSql,
  memberIds: MemberIds,
  storeId: string,
): Promise<void> {
  const userOf = async (memberId: string | undefined) =>
    memberId
      ? (
          await tx<
            { user_id: string; tenant_id: string }[]
          >`select user_id, tenant_id from tenant_members where id = ${memberId}`
        )[0]
      : undefined;
  const [restricted, listed, moderator, admin, buyer] = await Promise.all([
    userOf(memberIds.mirpur.community[5]),
    userOf(memberIds.mirpur.community[6]),
    userOf(memberIds.mirpur.moderator),
    userOf(memberIds.mirpur.tenantAdmin),
    userOf(memberIds.mirpur.buyer),
  ]);
  if (!restricted || !listed || !moderator || !admin || !buyer) return;
  const tenantId = restricted.tenant_id;
  const evidence = JSON.stringify([{ type: 'complaint', id: seedId('complaint:open') }]);
  const banId = seedId('ban:restricted');

  // These tables take writes only through their functions (0059); the seed writes
  // fixed rows as the role those functions run as (no RLS), then resets.
  await tx`set local role ae_rls_bypass`;
  await tx`
    insert into bans (id, tenant_id, user_id, severity_code, reason_code, reason_text, evidence_refs, banned_by_user_id,
                      starts_at, expires_at, escalation_step)
    values (${banId}, ${tenantId}, ${restricted.user_id}, 'restricted', 'spam',
            'একই বিজ্ঞাপন দিনে ২০ বার, তিনটি রিপোর্ট', ${evidence}::text::jsonb, ${moderator.user_id},
            now() - interval '1 day', now() + interval '6 days', 1)
    on conflict (id) do nothing`;
  await tx`
    insert into moderation_actions (tenant_id, ban_id, actor_user_id, action_code, reason_code, reason_text)
    select ${tenantId}, ${banId}, ${moderator.user_id}, 'ban_issued', 'account_ban', 'restricted / spam'
    where not exists (select 1 from moderation_actions where ban_id = ${banId})`;
  await tx`
    insert into ban_appeals (id, public_reference, user_id, ban_id, channel_code, submitted_phone_e164, statement,
                             queue_code, escalate_at)
    select ${seedId('appeal:restricted')}, 'AP-SEED000001', ${restricted.user_id}, ${banId}, 'in_app', u.phone_e164,
           'ভুল করে একই বিজ্ঞাপন বারবার পোস্ট হয়ে গেছে, আর হবে না।', 'tenant_admin', now() + interval '6 days'
    from users u where u.id = ${restricted.user_id}
    on conflict (id) do nothing`;
  await tx`
    insert into blacklist_entries (id, user_id, reason_code, severity_code, status_code, summary, source_tenant_id,
                                   recommended_by_user_id, evidence_refs)
    values (${seedId('blacklist:recommended')}, ${listed.user_id}, 'advance_payment_scam', 'banned', 'recommended',
            'তিনজন ক্রেতার কাছ থেকে অগ্রিম নিয়ে ফোন বন্ধ', ${tenantId}, ${admin.user_id}, ${evidence}::text::jsonb)
    on conflict (id) do nothing`;
  await tx`
    insert into complaints (id, tenant_id, reporter_user_id, subject_type, subject_id, category_code, priority_code,
                            description, due_at)
    values (${seedId('complaint:open')}, ${tenantId}, ${buyer.user_id}, 'store', ${storeId}, 'scam', 'urgent',
            '৫০০০ টাকা অগ্রিম নিয়েছে, ফোন দিচ্ছে না', now() + interval '3 hours')
    on conflict (id) do nothing`;
  await tx`
    insert into complaints (id, tenant_id, reporter_user_id, subject_type, subject_id, category_code, priority_code,
                            status_code, description, due_at, resolution, resolved_by_user_id, resolved_at)
    values (${seedId('complaint:resolved')}, ${tenantId}, ${restricted.user_id}, 'store', ${storeId}, 'abuse', 'high',
            'resolved', 'চ্যাটে খারাপ ভাষা', now() - interval '2 days', 'দোকানকে সতর্ক করা হয়েছে',
            ${moderator.user_id}, now() - interval '3 days')
    on conflict (id) do nothing`;
  await tx`reset role`;
  console.log(
    'bans: 1 restricted (appeal waiting), 1 blacklist recommendation, 2 complaints (1 open, 1 resolved)',
  );
}

// ---------------------------------------------------------------------------
// Bulk import and the WhatsApp catalog (ADR 056)
// ---------------------------------------------------------------------------

/**
 * The first store takes WhatsApp orders (its catalog's button works in dev)
 * and has one finished dry run with a row of each outcome, so the import
 * history and its report have something to show.
 */
async function seedStoreImport(
  tx: TransactionSql,
  storeId: string,
  categoryId: string,
): Promise<void> {
  const [store] = await tx<{ tenant_id: string; owner_member_id: string }[]>`
    update stores set whatsapp_e164 = '+8801700000777' where id = ${storeId}
    returning tenant_id, owner_member_id`;
  if (!store) return;
  const importId = seedId('store-import:demo');
  await tx`
    insert into store_imports (id, tenant_id, store_id, category_id, created_by_member_id, sheet_format, dry_run,
                               status_code, total_rows, processed_rows, created_count, skipped_count, failed_count,
                               started_at, finished_at)
    values (${importId}, ${store.tenant_id}, ${storeId}, ${categoryId}, ${store.owner_member_id}, 'xlsx', true,
            'succeeded', 3, 3, 1, 1, 1, now() - interval '1 hour', now() - interval '1 hour')
    on conflict (id) do nothing`;
  await tx`
    insert into store_import_rows (tenant_id, import_id, row_number, outcome, reason_code, reason) values
      (${store.tenant_id}, ${importId}, 2, 'valid', null, null),
      (${store.tenant_id}, ${importId}, 3, 'skipped', 'blank_row', 'খালি সারি'),
      (${store.tenant_id}, ${importId}, 4, 'failed', 'missing_title', 'শিরোনাম: লিখতে হবে')
    on conflict (tenant_id, import_id, row_number) do nothing`;
  console.log('store import: 1 demo dry run; first store takes WhatsApp orders');
}

/** Two stores' products out of stock and on order (ADR 057), so dev shows the badges. */
async function seedStock(tx: TransactionSql): Promise<void> {
  const rows = await tx`
    with picked as (
      select id, row_number() over (order by id) as n from posts
      where store_id is not null and status_code = 'live' and deleted_at is null
      limit 2
    )
    update posts p set stock_status_code = case picked.n when 1 then 'out_of_stock' else 'on_order' end
    from picked where p.id = picked.id`;
  console.log(`stock: ${rows.count} products out of stock / on order`);
}

// ---------------------------------------------------------------------------
// Seller analytics history (ADR 055)
// ---------------------------------------------------------------------------

// settings-exempt: how much demo history the dev seed writes (the screen's longest default period)
const ANALYTICS_SEED_DAYS = 30;

/**
 * Thirty finished days of analytics_daily for every live seeded post, so the
 * seller screen has a history and a trend in dev. Numbers are a stable hash
 * of post and day (the same seed, the same screen); today stays live (Redis).
 */
async function seedAnalyticsHistory(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
): Promise<void> {
  const tenants = [...tenantIds.values()];
  const rows = await tx`
    insert into analytics_daily (tenant_id, entity_type, entity_id, stat_date, metrics)
    select p.tenant_id, 'post', p.id, d::date,
           jsonb_strip_nulls(jsonb_build_object(
             'views', 5 + abs(hashtext(p.id::text || d::text)) % 40,
             'unique_viewers', 4 + abs(hashtext(p.id::text || d::text)) % 30,
             'search_appearances', 10 + abs(hashtext(d::text || p.id::text)) % 60,
             'map_taps', nullif(abs(hashtext(p.id::text || 'm' || d::text)) % 4, 0),
             'saves', nullif(abs(hashtext(p.id::text || 's' || d::text)) % 3, 0),
             'contacts_call', nullif(abs(hashtext(p.id::text || 'c' || d::text)) % 3, 0),
             'contacts_whatsapp', nullif(abs(hashtext(p.id::text || 'w' || d::text)) % 2, 0)))
    from posts p
    cross join generate_series(current_date - ${ANALYTICS_SEED_DAYS}::int, current_date - 1, interval '1 day') d
    where p.tenant_id in ${tx(tenants)} and p.status_code = 'live' and p.scrubbed_at is null
    on conflict (tenant_id, entity_type, entity_id, stat_date) do nothing`;
  console.log(`analytics history: ${rows.count} post-days`);
}

// ---------------------------------------------------------------------------
// Partner
// ---------------------------------------------------------------------------

async function seedPartner(tx: TransactionSql): Promise<string> {
  const id = seedId('partner:amar-elaka-dev');
  await tx`
    insert into partners (id, legal_name, display_name, phone_e164, status_code)
    values (${id}, 'Amar Elaka Dev Partner', 'Amar Elaka Dev Partner', '+8801711000000', 'active')
    on conflict (id) do nothing`;
  console.log('partners: 1');
  return id;
}

// ---------------------------------------------------------------------------
// Geo areas
// ---------------------------------------------------------------------------

async function seedGeoAreas(tx: TransactionSql): Promise<Map<string, string>> {
  // The real hierarchy (all of Bangladesh, by pcode) plus the pilot district's
  // boundaries — the same code path as `geo:import` (ADR 026).
  const idByPcode = await importReference(tx, readReference());
  const boundaries = await importBoundaries(tx, readBoundaries(PILOT_BOUNDARIES_PATH));
  await reparentPointsByContainment(tx);
  console.log(`geo_areas: ${idByPcode.size} from the COD-AB reference, ${boundaries} boundaries`);

  const idBySlug = new Map<string, string>();
  for (const area of GEO_AREAS) {
    idBySlug.set(
      area.slug,
      area.pcode ? idByPcode.get(area.pcode)! : seedId(`geo-area:${area.slug}`),
    );
  }

  // Dev scaffolds for what the open data lacks (the Mirpur metro thana and its
  // wards): no polygon — Mirpur's tenant is centre + radius — and marked
  // verified so a tenant may use the thana.
  const scaffolds = GEO_AREAS.filter((a) => a.pcode === undefined);
  for (const level of [...new Set(scaffolds.map((a) => a.admLevel))].sort((a, b) => a - b)) {
    const rows = scaffolds
      .filter((a) => a.admLevel === level)
      .map((area) => scaffoldRow(area, idBySlug));
    await tx`
      insert into geo_areas ${tx(
        rows,
        'id',
        'parent_id',
        'adm_level',
        'level_code',
        'bbs_code_geocode11',
        'name_en',
        'name_bn',
        'centroid',
        'needs_manual_review',
        'manually_verified_at',
        'source_release',
      )}
      on conflict (id) do nothing`;
  }
  console.log(`geo_areas: ${scaffolds.length} dev scaffolds`);
  return idBySlug;
}

function scaffoldRow(area: GeoAreaDef, idBySlug: Map<string, string>): Record<string, unknown> {
  const [lon, lat] = centroidOf(area.bbox);
  return {
    id: idBySlug.get(area.slug),
    parent_id: area.parentSlug ? idBySlug.get(area.parentSlug) : null,
    adm_level: area.admLevel,
    level_code: area.levelCode,
    bbs_code_geocode11: area.bbsCode,
    name_en: area.nameEn,
    name_bn: area.nameBn ?? null,
    centroid: `SRID=4326;POINT(${lon} ${lat})`,
    needs_manual_review: true,
    manually_verified_at: new Date(),
    source_release: 'dev-scaffold',
  };
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

const MIRPUR_SERVICE_RADIUS_KM = 4;

async function seedTenants(
  tx: TransactionSql,
  partnerId: string,
  geoAreaIdBySlug: Map<string, string>,
): Promise<Map<string, string>> {
  const mirpurId = seedId(`tenant:${TENANT_SLUGS.mirpur}`);
  const trishalId = seedId(`tenant:${TENANT_SLUGS.trishal}`);
  const [mirpurLon, mirpurLat] = centroidOf(GEO_AREAS.find((a) => a.slug === 'mirpur-thana')!.bbox);
  const [trishalLon, trishalLat] = centroidOf(
    GEO_AREAS.find((a) => a.slug === 'trishal-upazila')!.bbox,
  );

  const mirpurGeoAreaId = geoAreaIdBySlug.get('mirpur-thana')!;
  const trishalGeoAreaId = geoAreaIdBySlug.get('trishal-upazila')!;
  await tx`
    insert into tenants
      (id, partner_id, geo_area_id, slug, name_bn, name_en, status_code, map_center, launched_at,
       boundary_mode, service_radius_km)
    values
      -- A metro thana has no polygon in the open data: centre + radius (ADR 026).
      (${mirpurId}, ${partnerId}, ${mirpurGeoAreaId}, ${TENANT_SLUGS.mirpur}, 'মিরপুর', 'Mirpur',
        'active', ${`SRID=4326;POINT(${mirpurLon} ${mirpurLat})`}, now(), 'radius', ${MIRPUR_SERVICE_RADIUS_KM}),
      -- A real upazila: its COD-AB boundary.
      (${trishalId}, ${partnerId}, ${trishalGeoAreaId}, ${TENANT_SLUGS.trishal}, 'ত্রিশাল', 'Trishal',
        'active', ${`SRID=4326;POINT(${trishalLon} ${trishalLat})`}, now(), 'polygon', null)
    on conflict (id) do nothing`;

  console.log('tenants: 2');
  return new Map([
    [TENANT_SLUGS.mirpur, mirpurId],
    [TENANT_SLUGS.trishal, trishalId],
  ]);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function seedUsers(tx: TransactionSql): Promise<Map<string, string>> {
  const idByKey = new Map<string, string>();
  const rows: Record<string, unknown>[] = [];

  for (const u of NAMED_USERS) {
    const id = seedId(`user:${u.key}`);
    idByKey.set(u.key, id);
    rows.push({
      id,
      phone_e164: u.phone,
      platform_role_code: u.platformRole,
      preferred_locale: 'bn',
    });
  }
  COMMUNITY_MEMBER_NAMES.forEach((name, i) => {
    const key = `community-${i}`;
    const id = seedId(`user:${key}`);
    idByKey.set(key, id);
    rows.push({
      id,
      phone_e164: `+88017${String(20000000 + i).padStart(8, '0')}`,
      platform_role_code: null,
      preferred_locale: 'bn',
    });
  });

  await tx`insert into users ${tx(rows, 'id', 'phone_e164', 'platform_role_code', 'preferred_locale')} on conflict (id) do nothing`;
  console.log(`users: ${rows.length}`);
  return idByKey;
}

// ---------------------------------------------------------------------------
// Tenant members
// ---------------------------------------------------------------------------

interface MemberIds {
  mirpur: {
    tenantAdmin: string;
    moderator: string;
    seller: string;
    buyer: string;
    community: string[];
  };
  trishal: { seller: string; buyer: string; community: string[] };
}

async function seedTenantMembers(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  userIds: Map<string, string>,
): Promise<MemberIds> {
  const mirpurId = tenantIds.get(TENANT_SLUGS.mirpur)!;
  const trishalId = tenantIds.get(TENANT_SLUGS.trishal)!;

  const rows: Record<string, unknown>[] = [];
  const memberId = (tenantSlug: string, userKey: string) =>
    seedId(`member:${tenantSlug}:${userKey}`);

  const push = (tenantId: string, tenantSlug: string, userKey: string, roleCode: string) => {
    const id = memberId(tenantSlug, userKey);
    rows.push({ id, tenant_id: tenantId, user_id: userIds.get(userKey)!, role_code: roleCode });
    return id;
  };

  const mirpur = {
    tenantAdmin: push(mirpurId, TENANT_SLUGS.mirpur, 'tenant-admin', 'tenant_admin'),
    moderator: push(mirpurId, TENANT_SLUGS.mirpur, 'moderator', 'moderator'),
    seller: push(mirpurId, TENANT_SLUGS.mirpur, 'seller', 'member'),
    buyer: push(mirpurId, TENANT_SLUGS.mirpur, 'buyer', 'member'),
    community: [] as string[],
  };
  const trishal = {
    seller: push(trishalId, TENANT_SLUGS.trishal, 'seller', 'member'),
    buyer: push(trishalId, TENANT_SLUGS.trishal, 'buyer', 'member'),
    community: [] as string[],
  };

  // 10 generic members in Mirpur, 10 in Trishal.
  COMMUNITY_MEMBER_NAMES.forEach((_, i) => {
    const userKey = `community-${i}`;
    if (i < 10) {
      mirpur.community.push(push(mirpurId, TENANT_SLUGS.mirpur, userKey, 'member'));
    } else {
      trishal.community.push(push(trishalId, TENANT_SLUGS.trishal, userKey, 'member'));
    }
  });

  await tx`insert into tenant_members ${tx(rows, 'id', 'tenant_id', 'user_id', 'role_code')} on conflict (id) do nothing`;
  console.log(`tenant_members: ${rows.length}`);
  return { mirpur, trishal };
}

// ---------------------------------------------------------------------------
// Categories + field schemas
// ---------------------------------------------------------------------------

async function seedCategories(
  tx: TransactionSql,
  platformAdminUserId: string,
): Promise<Map<string, string>> {
  const idBySlug = new Map<string, string>();
  for (const c of CATEGORIES) idBySlug.set(c.slug, seedId(`category:${c.slug}`));

  // One row at a time, in array order: a child's parent must exist first
  // (categories_validate_parent() sets depth from it).
  for (const [i, c] of CATEGORIES.entries()) {
    await tx`
      insert into categories
        (id, parent_id, kind_code, module_code, slug, name_bn, name_en, icon_key, default_sort_order,
         default_post_cost_credits, default_moderation_mode_code, default_post_expiry_days,
         monetization_mode_code, is_active, is_shippable)
      values
        (${idBySlug.get(c.slug)!}, ${c.parent ? idBySlug.get(c.parent)! : null}, ${c.kind},
         ${c.moduleCode ?? null}, ${c.slug}, ${c.nameBn}, ${c.nameEn}, ${c.icon}, ${(i + 1) * 10},
         ${c.costCredits}, ${c.moderationMode}, ${c.expiryDays}, ${c.monetizationMode},
         ${c.phase1}, ${c.shippable ?? false})
      on conflict (id) do nothing`;
  }

  // Module tiles have no custom-field schema (0017 rejects one).
  const withSchema = CATEGORIES.filter((c) => c.kind !== 'module');
  for (const c of withSchema) {
    const definition = definitionOf(c, CATEGORIES);
    // Same checks a platform admin's publish goes through; throws on any violation.
    const { jsonSchema, uiSchema } = checkPublishable(definition);
    // What an admin would have authored: own fields only (re-flattened when a parent publishes).
    await tx`
      insert into category_field_schemas
        (id, category_id, version, json_schema, ui_schema, filterable_fields, searchable_fields,
         analytics_fields, authored_definition, status_code, published_at, published_by_user_id)
      values
        (${fieldSchemaId(c.slug)}, ${idBySlug.get(c.slug)!}, 1,
         ${tx.json(jsonSchema as never)}, ${tx.json(uiSchema as never)},
         ${definition.filterableFields}, ${definition.searchableFields}, ${definition.analyticsFields},
         ${tx.json(authoredDefinitionOf(c) as never)}, 'published', now(), ${platformAdminUserId})
      on conflict (id) do nothing`;
  }

  console.log(`categories: ${CATEGORIES.length}, category_field_schemas: ${withSchema.length}`);
  return idBySlug;
}

function fieldSchemaId(slug: string): string {
  return seedId(`category-field-schema:${slug}:1`);
}

// ---------------------------------------------------------------------------
// Tenant categories (enable the active, phase-1 categories for both tenants)
// ---------------------------------------------------------------------------

/** Provisioning inserts tenant_categories rows only for active categories (categories.md §2). */
const ACTIVE_CATEGORIES = CATEGORIES.filter((c) => c.phase1);

async function seedTenantCategories(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  categoryIds: Map<string, string>,
): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const [tenantSlug, tenantId] of tenantIds) {
    let sortOrder = 0;
    for (const c of ACTIVE_CATEGORIES) {
      sortOrder += 10;
      rows.push({
        id: seedId(`tenant-category:${tenantSlug}:${c.slug}`),
        tenant_id: tenantId,
        category_id: categoryIds.get(c.slug),
        is_enabled: true,
        sort_order: sortOrder,
      });
    }
  }
  await tx`insert into tenant_categories ${tx(rows, 'id', 'tenant_id', 'category_id', 'is_enabled', 'sort_order')} on conflict (id) do nothing`;
  console.log(`tenant_categories: ${rows.length}`);
}

/** Valid sample `fields` for a category, checked by the same validator the API uses. */
function buildFields(category: CategoryDef, label: string, rand: () => number): FieldValues {
  const schema: FieldSchema = definitionOf(category, CATEGORIES).jsonSchema;
  const context = validationContextAt(new Date(), 'Asia/Dhaka');
  const fields = sampleFields(schema, context, rand, label);
  return compileFieldsValidator(schema, context).parse(fields);
}

// ---------------------------------------------------------------------------
// Bazar commodities + markets
// ---------------------------------------------------------------------------

async function seedBazarCommodities(tx: TransactionSql): Promise<Map<string, string>> {
  const idByCode = new Map<string, string>();
  const rows = BAZAR_COMMODITIES.map((c, i) => {
    const id = seedId(`bazar-commodity:${c.code}`);
    idByCode.set(c.code, id);
    return {
      id,
      code: c.code,
      name_bn: c.nameBn,
      name_en: c.nameEn,
      group_code: c.group,
      default_unit_code: c.unit,
      sort_order: (i + 1) * 10,
    };
  });
  await tx`
    insert into bazar_commodities ${tx(rows, 'id', 'code', 'name_bn', 'name_en', 'group_code', 'default_unit_code', 'sort_order')}
    on conflict (id) do nothing`;
  console.log(`bazar_commodities: ${rows.length}`);
  return idByCode;
}

async function seedBazarMarkets(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
): Promise<Map<string, string>> {
  const idByTenant = new Map<string, string>();
  const markets = [
    {
      tenantSlug: TENANT_SLUGS.mirpur,
      nameBn: 'মিরপুর কাঁচাবাজার',
      nameEn: 'Mirpur Bazar',
      areaSlug: 'mirpur-10',
    },
    {
      tenantSlug: TENANT_SLUGS.trishal,
      nameBn: 'ত্রিশাল হাট',
      nameEn: 'Trishal Haat',
      areaSlug: 'trishal-sadar',
    },
  ];
  const rows = markets.map((m) => {
    const id = seedId(`bazar-market:${m.tenantSlug}`);
    idByTenant.set(m.tenantSlug, id);
    const area = GEO_AREAS.find((a) => a.slug === m.areaSlug)!;
    const [lon, lat] = centroidOf(area.bbox);
    return {
      id,
      tenant_id: tenantIds.get(m.tenantSlug),
      name_bn: m.nameBn,
      name_en: m.nameEn,
      market_type_code: 'daily_bazar',
      location: `SRID=4326;POINT(${lon} ${lat})`,
    };
  });
  await tx`
    insert into bazar_markets ${tx(rows, 'id', 'tenant_id', 'name_bn', 'name_en', 'market_type_code', 'location')}
    on conflict (id) do nothing`;
  console.log(`bazar_markets: ${rows.length}`);
  return idByTenant;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

async function seedStores(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  memberIds: MemberIds,
  categoryIds: Map<string, string>,
): Promise<string[]> {
  const storeNames = [
    'Rahim Electronics',
    'Nice Fashion House',
    'Green Mobile Center',
    'Dhaka Furniture Mart',
    'City Motors',
    'Amin Traders',
    'New Star Enterprise',
    'Bismillah Store',
    'Green Valley Agro',
    'Trishal Hardware',
  ];
  const rows = storeNames.map((name, i) => {
    const tenantSlug = i < 6 ? TENANT_SLUGS.mirpur : TENANT_SLUGS.trishal;
    const ownerMemberId = i < 6 ? memberIds.mirpur.seller : memberIds.trishal.seller;
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i + 1}`;
    return {
      id: seedId(`store:${slug}`),
      tenant_id: tenantIds.get(tenantSlug),
      owner_member_id: ownerMemberId,
      slug,
      name_bn: name,
      name_en: name,
      status_code: 'active',
      // What the store is (0050): the shop directory's place category, as its pin would be.
      category_id: categoryIds.get('local-shop-directory') ?? null,
    };
  });
  await tx`
    insert into stores ${tx(rows, 'id', 'tenant_id', 'owner_member_id', 'slug', 'name_bn', 'name_en', 'status_code', 'category_id')}
    on conflict (id) do nothing`;
  // A Mirpur community member edits the first store's catalog (ADR 054): posts as it, nothing else.
  const editorMemberId = memberIds.mirpur.community[0];
  if (editorMemberId) {
    await tx`
      insert into store_members (tenant_id, store_id, member_id, role_code, invited_by_member_id, accepted_at)
      values (${rows[0]!.tenant_id!}, ${rows[0]!.id}, ${editorMemberId}, 'editor', ${rows[0]!.owner_member_id}, now())
      on conflict (tenant_id, store_id, member_id) do nothing`;
  }
  console.log(`stores: ${rows.length} (1 editor)`);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

async function seedPosts(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  memberIds: MemberIds,
  storeIds: string[],
  categoryIds: Map<string, string>,
  geoAreaIdBySlug: Map<string, string>,
): Promise<void> {
  const postableCategories = ACTIVE_CATEGORIES.filter(
    (c) => c.kind !== 'place' && c.kind !== 'module',
  );
  const POST_COUNT = 30;
  const rows: unknown[][] = [];

  for (let i = 0; i < POST_COUNT; i++) {
    const category = postableCategories[i % postableCategories.length]!;
    const isMirpur = i < 20;
    const tenantSlug = isMirpur ? TENANT_SLUGS.mirpur : TENANT_SLUGS.trishal;
    const tenantId = tenantIds.get(tenantSlug)!;
    const areaSlug = isMirpur
      ? i % 2 === 0
        ? 'mirpur-10'
        : 'mirpur-11'
      : i % 2 === 0
        ? 'trishal-sadar'
        : 'amirabari';
    const area = GEO_AREAS.find((a) => a.slug === areaSlug)!;
    const community = isMirpur ? memberIds.mirpur.community : memberIds.trishal.community;
    // Every third post is authored by "seller", the only member who owns
    // any store — a post's store_id requires the author to own/manage that
    // store (posts_validate_store_authorship(), 0006), so only these posts
    // ever get a store_id.
    const authoredBySeller = i % 3 === 0;
    const authorMemberId = authoredBySeller
      ? isMirpur
        ? memberIds.mirpur.seller
        : memberIds.trishal.seller
      : community[i % community.length];
    const rand = rngFor(`post:${i}`);
    const [lon, lat] = randomPointIn(area.bbox, rand);
    const { title, fields, priceTypeCode } = buildPostContent(category, i, rand);
    const storeId =
      authoredBySeller && i % 5 === 0
        ? pick(storeIds.slice(isMirpur ? 0 : 6, isMirpur ? 6 : 10), rand)
        : null;

    rows.push([
      seedId(`post:${i}`),
      tenantId,
      authorMemberId,
      storeId,
      categoryIds.get(category.slug),
      fieldSchemaId(category.slug),
      title,
      `${title} — বিস্তারিত জানতে যোগাযোগ করুন।`,
      tx.json(fields),
      priceTypeCode,
      geoAreaIdBySlug.get(areaSlug),
      `SRID=4326;POINT(${lon} ${lat})`,
      'live',
      tx`now()`,
    ]);
  }

  await tx`
    insert into posts
      (id, tenant_id, author_member_id, store_id, category_id, field_schema_id, title, description, fields,
       price_type_code, geo_area_id, location, status_code, published_at)
    values ${tx(rows as never)}
    on conflict (id) do nothing`;
  console.log(`posts: ${rows.length}`);

  const postIds = rows.map((row) => row[0] as string);
  // Buyers reach the author's own number, as a new post defaults to (ADR
  // 032) — revealed only through POST /posts/:id/contact (ADR 036).
  await tx`
    update posts p
    set contact_phone_e164 = u.phone_e164,
        contact_name = nullif(btrim(up.display_name), '')
    from tenant_members tm
    join users u on u.id = tm.user_id
    left join user_profiles up on up.user_id = u.id
    where tm.tenant_id = p.tenant_id and tm.id = p.author_member_id
      and p.id in ${tx(postIds)}
      and p.contact_phone_e164 is null`;
  // A share code per post (/s/:code), stable across re-seeds.
  await tx`
    insert into post_short_links (tenant_id, post_id, code)
    select tenant_id, id, substr(md5(id::text), 1, 8) from posts where id in ${tx(postIds)}
    on conflict do nothing`;
  console.log(`post contacts and share links: ${postIds.length}`);
}

function buildPostContent(
  category: CategoryDef,
  index: number,
  rand: () => number,
): {
  title: string;
  fields: FieldValues;
  priceTypeCode: string;
} {
  const title = `${category.nameEn} #${index + 1}`;
  const fields = buildFields(category, title, rand);
  const priceTypeCode =
    fields.price === undefined
      ? 'on_request'
      : category.slug === 'to-let'
        ? 'per_month'
        : rand() > 0.7
          ? 'negotiable'
          : 'fixed';
  return { title, fields, priceTypeCode };
}

// ---------------------------------------------------------------------------
// Saved items and follows (ADR 037)
// ---------------------------------------------------------------------------

/**
 * The buyer's saved list, across both tenants: a few posts, places and a
 * store, and two followed stores. Each row lives in its target's tenant
 * (§13.29); the counters (saved_count, follower_count) follow by trigger.
 */
async function seedSavedAndFollows(tx: TransactionSql, buyerId: string): Promise<void> {
  const savedPosts = await tx`
    insert into saved_posts (tenant_id, user_id, post_id)
    select p.tenant_id, ${buyerId}, p.id from posts p
    where p.id in ${tx([0, 5, 12, 21].map((i) => seedId(`post:${i}`)))}
    on conflict do nothing`;
  const savedPlaces = await tx`
    insert into saved_places (tenant_id, user_id, place_id)
    select pl.tenant_id, ${buyerId}, pl.id from places pl
    where pl.status_code = 'published' and pl.deleted_at is null
    order by pl.id limit 2
    on conflict do nothing`;
  const savedStores = await tx`
    insert into saved_stores (tenant_id, user_id, store_id)
    select st.tenant_id, ${buyerId}, st.id from stores st
    where st.status_code = 'active' and st.deleted_at is null
    order by st.id limit 1
    on conflict do nothing`;
  const follows = await tx`
    insert into store_follows (tenant_id, user_id, store_id)
    select st.tenant_id, ${buyerId}, st.id from stores st
    where st.status_code = 'active' and st.deleted_at is null
    order by st.id limit 2
    on conflict do nothing`;
  console.log(
    `saved: ${savedPosts.count} posts, ${savedPlaces.count} places, ${savedStores.count} stores; follows: ${follows.count}`,
  );
}

// ---------------------------------------------------------------------------
// Search log (0034, ADR 040)
// ---------------------------------------------------------------------------

/**
 * A few days of searches per tenant, so trending, the popular queries in
 * suggestions and the zero-result report (search:zero-results) show
 * something in dev. Normalized text only, in all three scripts, from several
 * anonymous searchers; some found nothing.
 */
const SEED_SEARCHES: readonly { q: string; searchers: number; found: boolean }[] = [
  { q: 'ডাক্তার', searchers: 6, found: true },
  { q: 'daktar', searchers: 4, found: true },
  { q: 'basa vara', searchers: 5, found: true },
  { q: 'বাসা ভাড়া', searchers: 3, found: true },
  { q: 'mobile', searchers: 4, found: true },
  { q: 'ইলেকট্রিশিয়ান', searchers: 3, found: true },
  { q: 'plumbr', searchers: 3, found: false },
  { q: 'অ্যাম্বুলেন্স রাতে', searchers: 2, found: false },
];

async function seedSearchQueries(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
): Promise<void> {
  let rows = 0;
  for (const [slug, tenantId] of tenantIds) {
    for (const { q, searchers, found } of SEED_SEARCHES) {
      for (let n = 0; n < searchers; n += 1) {
        const searcher = createHash('sha256').update(`seed-searcher:${slug}:${n}`).digest('hex');
        const result = await tx`
          insert into search_queries
            (id, tenant_id, searcher_hash, q_normalized, filters_hash, result_count, created_at)
          values (${seedId(`search:${slug}:${q}:${n}`)}, ${tenantId}, ${searcher}, ${q},
                  '0000000000000000', ${found ? 7 : 0}, now() - make_interval(hours => ${n * 3}))
          on conflict (id) do nothing`;
        rows += result.count;
      }
    }
  }
  console.log(`search log: ${rows} searches`);
}

// ---------------------------------------------------------------------------
// Saved searches (0035, ADR 041)
// ---------------------------------------------------------------------------

/**
 * Two of the buyer's saved searches around each tenant's centre — one
 * instant, one daily — and, for the first, a few "new results" (its badge),
 * so the saved-search screens have something to show in dev. Matches are
 * normally the worker's (saved_search_matches is system-written); the seed
 * runs as system too.
 */
async function seedSavedSearches(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  buyerId: string,
): Promise<void> {
  let searches = 0;
  let matches = 0;
  for (const [slug, tenantId] of tenantIds) {
    const instantId = seedId(`saved-search:${slug}:instant`);
    const inserted = await tx`
      insert into saved_searches (id, user_id, name, query_text, center, radius_km, alert_frequency_code, last_engaged_at)
      select ${instantId}::uuid, ${buyerId}::uuid, 'মোবাইল', 'mobile', t.map_center, 5, 'instant', now()
      from tenants t where t.id = ${tenantId}
      union all
      select ${seedId(`saved-search:${slug}:daily`)}::uuid, ${buyerId}::uuid, 'বাসা ভাড়া', 'basa vara', t.map_center, 3, 'daily', now()
      from tenants t where t.id = ${tenantId}
      on conflict (id) do nothing`;
    searches += inserted.count;
    const newResults = await tx`
      insert into saved_search_matches (saved_search_id, user_id, post_id, post_tenant_id)
      select ${instantId}::uuid, ${buyerId}::uuid, p.id, p.tenant_id from posts p
      where p.tenant_id = ${tenantId} and p.status_code = 'live'
      order by p.id limit 3
      on conflict (saved_search_id, post_id) do nothing`;
    matches += newResults.count;
  }
  console.log(`saved searches: ${searches}, new results: ${matches}`);
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

async function seedPlaces(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  memberIds: MemberIds,
  categoryIds: Map<string, string>,
  geoAreaIdBySlug: Map<string, string>,
): Promise<void> {
  const placeCategories = ACTIVE_CATEGORIES.filter((c) => c.kind === 'place');
  const PLACE_COUNT = 20;
  const rows: unknown[][] = [];

  for (let i = 0; i < PLACE_COUNT; i++) {
    const category = placeCategories[i % placeCategories.length]!;
    const isMirpur = i < 12;
    const tenantSlug = isMirpur ? TENANT_SLUGS.mirpur : TENANT_SLUGS.trishal;
    const areaSlug = isMirpur
      ? i % 2 === 0
        ? 'mirpur-10'
        : 'mirpur-11'
      : i % 2 === 0
        ? 'trishal-sadar'
        : 'amirabari';
    const area = GEO_AREAS.find((a) => a.slug === areaSlug)!;
    const rand = rngFor(`place:${i}`);
    const [lon, lat] = randomPointIn(area.bbox, rand);
    const name = `${category.nameEn} ${i + 1}`;
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const createdBy = isMirpur ? memberIds.mirpur.tenantAdmin : memberIds.trishal.seller;
    const fields = buildFields(category, name, rand);

    rows.push([
      seedId(`place:${slug}-${i}`),
      tenantIds.get(tenantSlug),
      categoryIds.get(category.slug),
      fieldSchemaId(category.slug),
      `${slug}-${i}`,
      name,
      name,
      tx.json(fields),
      geoAreaIdBySlug.get(areaSlug),
      `SRID=4326;POINT(${lon} ${lat})`,
      'agent_survey',
      createdBy ? tx`(select user_id from tenant_members where id = ${createdBy})` : null,
      'published',
    ]);
  }

  await tx`
    insert into places
      (id, tenant_id, category_id, field_schema_id, slug, name_bn, name_en, fields, geo_area_id, location,
       source_code, created_by_user_id, status_code)
    values ${tx(rows as never)}
    on conflict (id) do nothing`;
  console.log(`places: ${rows.length}`);
}

/**
 * The moderators' Places tab has something in it (ADR 051): on Mirpur's first
 * place a wrong-location and a closed report (below the "possibly closed"
 * threshold), and on its second a pending phone suggestion. Filed through
 * report_place() / suggest_place_edit() as the members (moderation_actions
 * takes no other writer), then the seed's system context is restored.
 */
async function seedPlaceModeration(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  memberIds: MemberIds,
): Promise<void> {
  const tenantId = tenantIds.get(TENANT_SLUGS.mirpur)!;
  const places = await tx<{ id: string }[]>`
    select id from places where tenant_id = ${tenantId} and status_code = 'published'
    order by slug limit 2`;
  if (places.length < 2) return;
  const [first, second] = [places[0]!.id, places[1]!.id];

  const asMember = async (memberId: string, work: () => Promise<unknown>) => {
    const [m] = await tx<{ user_id: string }[]>`
      select user_id from tenant_members where id = ${memberId}`;
    await tx`select set_config('app.tenant_id', ${tenantId}, true),
                    set_config('app.user_id', ${m!.user_id}, true),
                    set_config('app.member_id', ${memberId}, true),
                    set_config('app.role', 'member', true)`;
    try {
      await work();
    } finally {
      await tx`select set_config('app.tenant_id', '', true), set_config('app.user_id', '', true),
                      set_config('app.member_id', '', true), set_config('app.role', 'system', true)`;
    }
  };

  // A repeat run finds the open reports again (report_place returns them).
  await asMember(
    memberIds.mirpur.buyer,
    () => tx`select report_place(${first}, 'wrong_location', 'পিনটা রাস্তার উল্টো পাশে')`,
  );
  await asMember(
    memberIds.mirpur.seller,
    () => tx`select report_place(${first}, 'closed_permanently', 'দোকান বন্ধ হয়ে গেছে')`,
  );
  const [pending] = await tx<{ n: number }[]>`
    select count(*)::int as n from place_edit_suggestions
    where place_id = ${second} and suggester_member_id = ${memberIds.mirpur.buyer}
      and status_code = 'pending'`;
  if (pending!.n === 0) {
    await asMember(
      memberIds.mirpur.buyer,
      () =>
        tx`select suggest_place_edit(${second}, ${tx.json({ phones: ['+8801711000777'] })},
                                   (select jsonb_build_object('phones', to_jsonb(phones))
                                    from places where id = ${second}),
                                   'দোকানের নতুন নম্বর')`,
    );
  }
  console.log('place moderation: 2 reports, 1 suggestion');
}

// ---------------------------------------------------------------------------
// Emergency contacts
// ---------------------------------------------------------------------------

async function seedEmergencyContacts(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
): Promise<void> {
  const serviceTypes = [
    'ambulance',
    'fire_service',
    'police',
    'hospital',
    'pharmacy_24h',
    'electricity',
    'gas',
    'union_parishad',
  ];
  const CONTACT_COUNT = 15;
  const rows: unknown[][] = [];

  for (let i = 0; i < CONTACT_COUNT; i++) {
    const isMirpur = i < 8;
    const tenantSlug = isMirpur ? TENANT_SLUGS.mirpur : TENANT_SLUGS.trishal;
    const areaSlug = isMirpur ? 'mirpur-thana' : 'trishal-upazila';
    const area = GEO_AREAS.find((a) => a.slug === areaSlug)!;
    const rand = rngFor(`emergency-contact:${i}`);
    const [lon, lat] = randomPointIn(area.bbox, rand);
    const serviceType = serviceTypes[i % serviceTypes.length]!;
    const name = `${tenantSlug === TENANT_SLUGS.mirpur ? 'Mirpur' : 'Trishal'} ${serviceType.replace(/_/g, ' ')}`;

    rows.push([
      seedId(`emergency-contact:${tenantSlug}:${i}`),
      tenantIds.get(tenantSlug),
      serviceType,
      name,
      [`+8801${intBetween(700000000, 999999999, rand)}`],
      `SRID=4326;POINT(${lon} ${lat})`,
      true,
    ]);
  }

  await tx`
    insert into emergency_contacts (id, tenant_id, service_type_code, name_bn, phones, location, is_active)
    values ${tx(rows as never)}
    on conflict (id) do nothing`;
  console.log(`emergency_contacts: ${rows.length}`);
}

// ---------------------------------------------------------------------------
// Blood donors
// ---------------------------------------------------------------------------

async function seedBloodDonors(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  memberIds: MemberIds,
): Promise<void> {
  const bloodGroups = ['a_pos', 'a_neg', 'b_pos', 'b_neg', 'ab_pos', 'ab_neg', 'o_pos', 'o_neg'];
  const donorMembers = [
    ...memberIds.mirpur.community.slice(0, 5),
    ...memberIds.trishal.community.slice(0, 5),
  ];
  const rows = donorMembers.map((memberId, i) => {
    const isMirpur = i < 5;
    return [
      seedId(`blood-donor:${i}`),
      isMirpur ? tenantIds.get(TENANT_SLUGS.mirpur) : tenantIds.get(TENANT_SLUGS.trishal),
      memberId,
      bloodGroups[i % bloodGroups.length]!,
      true,
      tx`now()`,
    ];
  });
  await tx`
    insert into blood_donors (id, tenant_id, member_id, blood_group_code, is_available, eligibility_confirmed_at)
    values ${tx(rows as never)}
    on conflict (id) do nothing`;
  console.log(`blood_donors: ${rows.length}`);
}

// ---------------------------------------------------------------------------
// Bazar prices (7 days)
// ---------------------------------------------------------------------------

async function seedBazarPrices(
  tx: TransactionSql,
  tenantIds: Map<string, string>,
  commodityIds: Map<string, string>,
  bazarMarketIds: Map<string, string>,
  publishedByUserId: string,
): Promise<void> {
  const rows: unknown[][] = [];
  for (const [tenantSlug, tenantId] of tenantIds) {
    for (const commodity of BAZAR_COMMODITIES) {
      const rand = rngFor(`bazar-price:${tenantSlug}:${commodity.code}`);
      const base = intBetween(30, 200, rand);
      for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        const wobble = intBetween(-5, 5, rand);
        const min = Math.max(10, base + wobble);
        const max = min + intBetween(2, 15, rand);
        rows.push([
          seedId(`bazar-price:${tenantSlug}:${commodity.code}:${dayOffset}`),
          tenantId,
          commodityIds.get(commodity.code),
          bazarMarketIds.get(tenantSlug),
          tx`current_date - ${dayOffset}::int`,
          commodity.unit,
          min,
          max,
          'staff',
          'published',
          publishedByUserId,
        ]);
      }
    }
  }
  await tx`
    insert into bazar_prices
      (id, tenant_id, commodity_id, bazar_market_id, price_date, unit_code, min_price, max_price, source_code,
       status_code, published_by_user_id)
    values ${tx(rows as never)}
    on conflict (id) do nothing`;
  console.log(`bazar_prices: ${rows.length}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
