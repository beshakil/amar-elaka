-- 0055_notifications
--
-- The notification system (ADR 059) on the 0009 tables, nothing new:
--
--   notification_types   + default_channels, is_urgent, sms_eligible,
--                          collapsible, user_configurable, audience: how each type is
--                          delivered (data an admin can change, not code).
--                        + saved_post_price_drop, store_import_finished,
--                          saved_search_weekly_digest.
--   notifications        + tenant_id (where it happened; null = platform),
--                          title, body (rendered from the templates in the
--                          user's locale), channels_sent, collapse_key,
--                          collapse_count, last_event_at. Still per user: one
--                          inbox across every tenant.
--                        + RLS notifications_system_update (the worker
--                          collapses into an unread row).
--   notification_templates
--                        + variant (single | collapsed: "৪টি নতুন মেসেজ").
--                          CHANGED notification_templates_version_uq and
--                          _active_uq (dropped and recreated with variant).
--                          Seeded: Bengali and English for every type that
--                          is sent today. No user-facing text in code.
--   notification_deliveries
--                        + scheduled_for (a push held back by quiet hours),
--                          index for the per-user daily cap.
--   moderation_reasons   + label_bn, label_en: the reason a push, SMS or email
--                          names ("কারণ: স্প্যাম").
--   user_notification_preferences
--                        + RLS ..._system_read (the worker reads them).
--   register_push_token()  a device's (FCM) token, moved from any other user.
--   scheduled_jobs       + relay-notification-outbox, send-saved-search-digests.
--   settings             notification_* and saved_search_weekly_digest_*.
--
-- No column is dropped or renamed. Tests: apps/api/test/notifications.db-spec.ts,
-- notifications.e2e-spec.ts, src/notifications/*.spec.ts.

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

-- ============================================================================
-- notification_types: delivery behaviour
-- ============================================================================

ALTER TABLE public.notification_types
  ADD COLUMN default_channels text[] NOT NULL DEFAULT '{in_app,push}',
  -- Security and account notices: never held by quiet hours, never capped.
  ADD COLUMN is_urgent boolean NOT NULL DEFAULT false,
  -- SMS costs money: only these (plus notification_sms_extra_types) may use it.
  ADD COLUMN sms_eligible boolean NOT NULL DEFAULT false,
  -- Several within notification_collapse_window_minutes become one.
  ADD COLUMN collapsible boolean NOT NULL DEFAULT false,
  -- False: the user can't switch it off (security, account).
  ADD COLUMN user_configurable boolean NOT NULL DEFAULT true,
  -- platform: for platform staff only (geo budget alerts); never in a member's preferences.
  ADD COLUMN audience text NOT NULL DEFAULT 'member',
  ADD CONSTRAINT notification_types_audience_ck CHECK (audience IN ('member', 'platform')),
  ADD CONSTRAINT notification_types_default_channels_ck
    CHECK (default_channels <@ ARRAY['in_app', 'push', 'sms', 'email']::text[]
           AND 'in_app' = ANY (default_channels));
--> statement-breakpoint

INSERT INTO public.notification_types (code, label_key, sort_order) VALUES
  ('saved_post_price_drop', 'enum.notification_types.saved_post_price_drop', 280),
  ('store_import_finished', 'enum.notification_types.store_import_finished', 290),
  ('saved_search_weekly_digest', 'enum.notification_types.saved_search_weekly_digest', 300);
--> statement-breakpoint

UPDATE public.notification_types SET collapsible = true
WHERE code IN ('new_message', 'saved_post_price_drop');
--> statement-breakpoint
UPDATE public.notification_types SET default_channels = '{in_app}'
WHERE code IN ('saved_search_paused');
--> statement-breakpoint
UPDATE public.notification_types SET default_channels = '{in_app,email}'
WHERE code IN ('saved_search_weekly_digest', 'geo_budget_warning', 'geo_budget_exhausted');
--> statement-breakpoint
UPDATE public.notification_types SET audience = 'platform'
WHERE code IN ('geo_budget_warning', 'geo_budget_exhausted');
--> statement-breakpoint
-- Account notices: urgent, SMS-eligible, always on.
UPDATE public.notification_types
SET default_channels = '{in_app,push,sms}', is_urgent = true, sms_eligible = true, user_configurable = false
WHERE code IN ('ban_issued', 'appeal_decided');
--> statement-breakpoint
-- A store suspended or back: account notices too, but no SMS.
UPDATE public.notification_types SET is_urgent = true, user_configurable = false
WHERE code IN ('store_suspended', 'store_reinstated');
--> statement-breakpoint

-- ============================================================================
-- notifications
-- ============================================================================

ALTER TABLE public.notifications
  ADD COLUMN tenant_id uuid,
  ADD COLUMN title text,
  ADD COLUMN body text,
  ADD COLUMN channels_sent text[] NOT NULL DEFAULT '{}',
  ADD COLUMN collapse_key text,
  ADD COLUMN collapse_count integer NOT NULL DEFAULT 1,
  ADD COLUMN last_event_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT notifications_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE SET NULL,
  ADD CONSTRAINT notifications_collapse_count_ck CHECK (collapse_count >= 1),
  ADD CONSTRAINT notifications_channels_sent_ck
    CHECK (channels_sent <@ ARRAY['in_app', 'push', 'sms', 'email']::text[]);
--> statement-breakpoint
-- Collapse: the user's unread row of this type and key, newest first.
CREATE INDEX notifications_collapse_idx ON public.notifications (user_id, type_code, collapse_key, last_event_at DESC)
  WHERE read_at IS NULL AND collapse_key IS NOT NULL;
--> statement-breakpoint
-- Per-type daily cap.
CREATE INDEX notifications_user_type_day_idx ON public.notifications (user_id, type_code, created_at);
--> statement-breakpoint
CREATE POLICY notifications_system_update ON public.notifications
  FOR UPDATE
  USING ((SELECT public.app_is_system()))
  WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint

-- ============================================================================
-- notification_deliveries
-- ============================================================================

ALTER TABLE public.notification_deliveries ADD COLUMN scheduled_for timestamptz;
--> statement-breakpoint
-- The per-user daily cap counts interruptions (push, SMS, email), not inbox rows.
CREATE INDEX notification_deliveries_user_day_idx ON public.notification_deliveries (user_id, created_at)
  WHERE channel_code <> 'in_app';
--> statement-breakpoint

-- ============================================================================
-- user_notification_preferences: the worker reads them
-- ============================================================================

CREATE POLICY user_notification_preferences_system_read ON public.user_notification_preferences
  FOR SELECT USING ((SELECT public.app_is_system()));
--> statement-breakpoint

-- ============================================================================
-- moderation_reasons: the words a notification uses for the reason
-- ============================================================================

ALTER TABLE public.moderation_reasons ADD COLUMN label_bn text, ADD COLUMN label_en text;
--> statement-breakpoint
UPDATE public.moderation_reasons r SET label_bn = v.bn, label_en = v.en
FROM (VALUES
  ('meets_guidelines', 'নিয়ম মেনে চলে', 'meets the guidelines'),
  ('community_reports', 'একাধিক অভিযোগ', 'several reports'),
  ('spam', 'স্প্যাম', 'spam'),
  ('wrong_category', 'ভুল ক্যাটাগরি', 'wrong category'),
  ('duplicate', 'একই বিজ্ঞাপন আগে দেওয়া আছে', 'a duplicate'),
  ('policy_violation', 'নীতিমালা লঙ্ঘন', 'a policy violation'),
  ('prohibited_item', 'নিষিদ্ধ পণ্য', 'a prohibited item'),
  ('scam_suspected', 'প্রতারণার সন্দেহ', 'suspected scam'),
  ('poor_quality_listing', 'বিজ্ঞাপনের মান ভালো নয়', 'a low-quality listing'),
  ('contact_info_exposed', 'লেখায় যোগাযোগের তথ্য', 'contact details in the text'),
  ('other', 'অন্যান্য', 'other'),
  ('illegal_content', 'বেআইনি বিষয়বস্তু', 'illegal content'),
  ('doxxing', 'অন্যের ব্যক্তিগত তথ্য প্রকাশ', 'someone else''s personal details'),
  ('csam', 'নিষিদ্ধ বিষয়বস্তু', 'prohibited content'),
  ('credible_threat', 'হুমকি', 'a threat'),
  ('privacy_request', 'গোপনীয়তার অনুরোধ', 'a privacy request'),
  ('law_enforcement_request', 'আইনশৃঙ্খলা বাহিনীর অনুরোধ', 'a law enforcement request'),
  ('otp_verified', 'কোড দিয়ে যাচাই হয়েছে', 'verified by code'),
  ('owner_request', 'মালিকের অনুরোধ', 'the owner''s request'),
  ('place_already_claimed', 'জায়গাটির মালিকানা অন্য কেউ নিশ্চিত করেছেন', 'someone else confirmed ownership'),
  ('member_report', 'সদস্যের অভিযোগ', 'a member report'),
  ('member_suggestion', 'সদস্যের পরামর্শ', 'a member suggestion'),
  ('confirmed_closed', 'বন্ধ হয়ে গেছে', 'it has closed'),
  ('still_open', 'এখনো খোলা', 'it is still open'),
  ('report_unfounded', 'অভিযোগের ভিত্তি পাওয়া যায়নি', 'the report was unfounded'),
  ('info_corrected', 'তথ্য ঠিক করা হয়েছে', 'the details were corrected'),
  ('suggestion_incorrect', 'দেওয়া তথ্য সঠিক নয়', 'the suggestion was incorrect'),
  ('harassment', 'হয়রানি', 'harassment')
) AS v (code, bn, en)
WHERE r.code = v.code;
--> statement-breakpoint

-- ============================================================================
-- notification_templates: variant, and the texts
-- ============================================================================

ALTER TABLE public.notification_templates
  ADD COLUMN variant text NOT NULL DEFAULT 'single',
  ADD CONSTRAINT notification_templates_variant_ck CHECK (variant IN ('single', 'collapsed'));
--> statement-breakpoint
DROP INDEX public.notification_templates_version_uq;
--> statement-breakpoint
DROP INDEX public.notification_templates_active_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX notification_templates_version_uq
  ON public.notification_templates (type_code, channel_code, locale, variant, version);
--> statement-breakpoint
-- One live template per combination.
CREATE UNIQUE INDEX notification_templates_active_uq
  ON public.notification_templates (type_code, channel_code, locale, variant) WHERE is_active;
--> statement-breakpoint

-- Syntax (apps/api/src/notifications/templates/template-renderer.ts):
--   {{name}}            the value as is (titles, names)
--   {{name|number}}     a count, in the locale's digits ("৪", "১,২৪০")
--   {{name|taka}}       money ("৳১২,০০০")
--   {{name|date}}       a date, Asia/Dhaka ("১২ অক্টোবর")
--   {{#name}}…{{/name}} only when the value is there (and not "0")
--   {{^name}}…{{/name}} only when it isn't
-- Lookup: the channel's own template, else the in_app one; the user's
-- locale, else Bengali. Push and email reuse in_app; SMS has its own.
INSERT INTO public.notification_templates
  (type_code, channel_code, locale, variant, title_template, body_template, variables)
VALUES
  -- Chat
  ('new_message', 'in_app', 'bn', 'single', 'নতুন মেসেজ',
   '{{#senderName}}{{senderName}} আপনাকে মেসেজ পাঠিয়েছেন।{{/senderName}}{{^senderName}}আপনার একটি নতুন মেসেজ এসেছে।{{/senderName}}',
   '{senderName}'),
  ('new_message', 'in_app', 'en', 'single', 'New message',
   '{{#senderName}}{{senderName}} sent you a message.{{/senderName}}{{^senderName}}You have a new message.{{/senderName}}',
   '{senderName}'),
  ('new_message', 'in_app', 'bn', 'collapsed', '{{count|number}}টি নতুন মেসেজ',
   'আপনার চ্যাটে নতুন মেসেজ এসেছে।', '{count}'),
  ('new_message', 'in_app', 'en', 'collapsed', '{{count|number}} new messages',
   'You have new messages in your chats.', '{count}'),
  -- Posts
  ('post_approved', 'in_app', 'bn', 'single', 'বিজ্ঞাপন প্রকাশিত হয়েছে',
   'আপনার বিজ্ঞাপন "{{postTitle}}" এখন সবাই দেখতে পাচ্ছেন।', '{postTitle}'),
  ('post_approved', 'in_app', 'en', 'single', 'Your listing is live',
   'Everyone can now see "{{postTitle}}".', '{postTitle}'),
  ('post_rejected', 'in_app', 'bn', 'single', 'বিজ্ঞাপন প্রকাশ করা যায়নি',
   '"{{postTitle}}" প্রকাশ করা যায়নি।{{#reason}} কারণ: {{reason}}।{{/reason}} ঠিক করে আবার জমা দিন।', '{postTitle,reason}'),
  ('post_rejected', 'in_app', 'en', 'single', 'Your listing was not published',
   '"{{postTitle}}" could not be published.{{#reason}} Reason: {{reason}}.{{/reason}} Fix it and submit again.', '{postTitle,reason}'),
  ('post_removed', 'in_app', 'bn', 'single', 'বিজ্ঞাপন সরানো হয়েছে',
   '"{{postTitle}}" সরিয়ে দেওয়া হয়েছে।{{#reason}} কারণ: {{reason}}।{{/reason}}', '{postTitle,reason}'),
  ('post_removed', 'in_app', 'en', 'single', 'Your listing was removed',
   '"{{postTitle}}" was removed.{{#reason}} Reason: {{reason}}.{{/reason}}', '{postTitle,reason}'),
  ('post_expiring', 'in_app', 'bn', 'single', 'বিজ্ঞাপনের মেয়াদ শেষ হচ্ছে',
   '"{{postTitle}}" {{expiresAt|date}} তারিখে শেষ হবে। চালু রাখতে আবার পোস্ট করুন।', '{postTitle,expiresAt}'),
  ('post_expiring', 'in_app', 'en', 'single', 'Your listing is about to expire',
   '"{{postTitle}}" ends on {{expiresAt|date}}. Repost it to keep it live.', '{postTitle,expiresAt}'),
  -- Saved searches and saved posts
  ('saved_search_match', 'in_app', 'bn', 'single', 'নতুন বিজ্ঞাপন',
   '"{{name}}" খোঁজে {{count|number}}টি নতুন ফলাফল।', '{name,count}'),
  ('saved_search_match', 'in_app', 'en', 'single', 'New listings',
   '{{count|number}} new results for "{{name}}".', '{name,count}'),
  ('saved_search_paused', 'in_app', 'bn', 'single', 'সেভ করা খোঁজের সতর্কবার্তা বন্ধ',
   '"{{name}}" খোঁজটি {{idleDays|number}} দিন খোলা হয়নি, তাই সতর্কবার্তা বন্ধ করা হয়েছে।', '{name,idleDays}'),
  ('saved_search_paused', 'in_app', 'en', 'single', 'Saved search alerts paused',
   'Alerts for "{{name}}" were paused after {{idleDays|number}} days without a visit.', '{name,idleDays}'),
  ('saved_search_weekly_digest', 'in_app', 'bn', 'single', 'এই সপ্তাহের নতুন বিজ্ঞাপন',
   'আপনার {{searches|number}}টি সেভ করা খোঁজে এই সপ্তাহে মোট {{total|number}}টি নতুন ফলাফল এসেছে।', '{searches,total}'),
  ('saved_search_weekly_digest', 'in_app', 'en', 'single', 'This week''s new listings',
   'Your {{searches|number}} saved searches found {{total|number}} new results this week.', '{searches,total}'),
  ('saved_post_price_drop', 'in_app', 'bn', 'single', 'দাম কমেছে',
   '"{{postTitle}}" এর দাম {{from|taka}} থেকে কমে {{to|taka}} হয়েছে।', '{postTitle,from,to}'),
  ('saved_post_price_drop', 'in_app', 'en', 'single', 'Price dropped',
   '"{{postTitle}}" dropped from {{from|taka}} to {{to|taka}}.', '{postTitle,from,to}'),
  ('saved_post_price_drop', 'in_app', 'bn', 'collapsed', '{{count|number}}টি সেভ করা বিজ্ঞাপনের দাম কমেছে',
   'দেখে নিন, দেরি করলে বিক্রি হয়ে যেতে পারে।', '{count}'),
  ('saved_post_price_drop', 'in_app', 'en', 'collapsed', 'Prices dropped on {{count|number}} saved listings',
   'Take a look before they sell.', '{count}'),
  -- Places
  ('place_approved', 'in_app', 'bn', 'single', 'জায়গা ম্যাপে যোগ হয়েছে',
   'আপনার যোগ করা "{{placeName}}" এখন ম্যাপে দেখা যাচ্ছে।', '{placeName}'),
  ('place_approved', 'in_app', 'en', 'single', 'Your place is on the map',
   '"{{placeName}}" is now on the map.', '{placeName}'),
  ('place_rejected', 'in_app', 'bn', 'single', 'জায়গা যোগ করা যায়নি',
   '"{{placeName}}" ম্যাপে যোগ করা যায়নি।{{#reason}} কারণ: {{reason}}।{{/reason}}', '{placeName,reason}'),
  ('place_rejected', 'in_app', 'en', 'single', 'Your place was not added',
   '"{{placeName}}" was not added to the map.{{#reason}} Reason: {{reason}}.{{/reason}}', '{placeName,reason}'),
  ('place_claim_approved', 'in_app', 'bn', 'single', 'মালিকানা নিশ্চিত হয়েছে',
   '"{{placeName}}" এখন আপনার দোকান হিসেবে যুক্ত।', '{placeName}'),
  ('place_claim_approved', 'in_app', 'en', 'single', 'Ownership confirmed',
   '"{{placeName}}" is now linked to you as its owner.', '{placeName}'),
  ('place_claim_rejected', 'in_app', 'bn', 'single', 'মালিকানার দাবি গ্রহণ হয়নি',
   '"{{placeName}}" এর মালিকানার দাবি গ্রহণ করা যায়নি।{{#reason}} কারণ: {{reason}}।{{/reason}}', '{placeName,reason}'),
  ('place_claim_rejected', 'in_app', 'en', 'single', 'Ownership claim declined',
   'Your claim to "{{placeName}}" was declined.{{#reason}} Reason: {{reason}}.{{/reason}}', '{placeName,reason}'),
  ('place_edit_approved', 'in_app', 'bn', 'single', 'আপনার সংশোধন যোগ হয়েছে',
   '"{{placeName}}" এ আপনার দেওয়া তথ্য যোগ হয়েছে। ধন্যবাদ!', '{placeName}'),
  ('place_edit_approved', 'in_app', 'en', 'single', 'Your edit was added',
   'Thanks! Your details for "{{placeName}}" were added.', '{placeName}'),
  ('place_edit_rejected', 'in_app', 'bn', 'single', 'সংশোধন গ্রহণ হয়নি',
   '"{{placeName}}" এর সংশোধন গ্রহণ করা যায়নি।{{#reason}} কারণ: {{reason}}।{{/reason}}', '{placeName,reason}'),
  ('place_edit_rejected', 'in_app', 'en', 'single', 'Your edit was not added',
   'Your edit to "{{placeName}}" was not added.{{#reason}} Reason: {{reason}}.{{/reason}}', '{placeName,reason}'),
  -- Stores
  ('store_staff_invited', 'in_app', 'bn', 'single', 'দোকানে যোগ দেওয়ার আমন্ত্রণ',
   '"{{storeName}}" আপনাকে তাদের দোকানে যোগ দিতে আমন্ত্রণ জানিয়েছে।', '{storeName}'),
  ('store_staff_invited', 'in_app', 'en', 'single', 'Invitation to join a store',
   '"{{storeName}}" invited you to join their store.', '{storeName}'),
  ('store_suspended', 'in_app', 'bn', 'single', 'দোকান স্থগিত করা হয়েছে',
   '"{{storeName}}" সাময়িকভাবে স্থগিত করা হয়েছে।{{#reason}} কারণ: {{reason}}।{{/reason}}', '{storeName,reason}'),
  ('store_suspended', 'in_app', 'en', 'single', 'Your store was suspended',
   '"{{storeName}}" was suspended.{{#reason}} Reason: {{reason}}.{{/reason}}', '{storeName,reason}'),
  ('store_reinstated', 'in_app', 'bn', 'single', 'দোকান আবার চালু',
   '"{{storeName}}" আবার চালু করা হয়েছে।', '{storeName}'),
  ('store_reinstated', 'in_app', 'en', 'single', 'Your store is back',
   '"{{storeName}}" is active again.', '{storeName}'),
  ('store_import_finished', 'in_app', 'bn', 'single', 'পণ্য আপলোড শেষ',
   '{{^importFailed}}"{{storeName}}" দোকানে {{created|number}}টি পণ্য যোগ হয়েছে।{{#failed}} {{failed|number}}টি যোগ হয়নি, রিপোর্ট দেখুন।{{/failed}}{{/importFailed}}{{#importFailed}}"{{storeName}}" দোকানের আপলোড শেষ করা যায়নি। ফাইলটি দেখে আবার চেষ্টা করুন।{{/importFailed}}',
   '{storeName,created,failed,importFailed}'),
  ('store_import_finished', 'in_app', 'en', 'single', 'Product upload finished',
   '{{^importFailed}}{{created|number}} products were added to "{{storeName}}".{{#failed}} {{failed|number}} were not, see the report.{{/failed}}{{/importFailed}}{{#importFailed}}The upload to "{{storeName}}" could not finish. Check the file and try again.{{/importFailed}}',
   '{storeName,created,failed,importFailed}'),
  -- Platform admins
  ('geo_budget_warning', 'in_app', 'bn', 'single', 'জিও বাজেট সতর্কতা',
   '{{provider}}: আজ {{used|number}}টি কল হয়েছে, দৈনিক বাজেট {{budget|number}}।', '{provider,used,budget}'),
  ('geo_budget_warning', 'in_app', 'en', 'single', 'Geo budget warning',
   '{{provider}}: {{used|number}} calls today of a daily budget of {{budget|number}}.', '{provider,used,budget}'),
  ('geo_budget_exhausted', 'in_app', 'bn', 'single', 'জিও বাজেট শেষ',
   '{{provider}}: আজকের {{budget|number}}টি কলের বাজেট শেষ। বাকি অনুরোধ নিজস্ব ডেটা থেকে দেওয়া হচ্ছে।', '{provider,budget}'),
  ('geo_budget_exhausted', 'in_app', 'en', 'single', 'Geo budget exhausted',
   '{{provider}}: today''s budget of {{budget|number}} calls is spent. Requests fall back to our own data.', '{provider,budget}'),
  -- Account notices (SMS too)
  ('ban_issued', 'in_app', 'bn', 'single', 'অ্যাকাউন্টে নিষেধাজ্ঞা',
   'আপনার অ্যাকাউন্টে নিষেধাজ্ঞা দেওয়া হয়েছে।{{#reason}} কারণ: {{reason}}।{{/reason}} আপনি আপিল করতে পারেন।', '{reason}'),
  ('ban_issued', 'in_app', 'en', 'single', 'Your account was restricted',
   'A ban was placed on your account.{{#reason}} Reason: {{reason}}.{{/reason}} You can appeal.', '{reason}'),
  ('ban_issued', 'sms', 'bn', 'single', NULL,
   'আমার এলাকা: আপনার অ্যাকাউন্টে নিষেধাজ্ঞা দেওয়া হয়েছে।{{#reason}} কারণ: {{reason}}।{{/reason}} অ্যাপে আপিল করতে পারেন।', '{reason}'),
  ('ban_issued', 'sms', 'en', 'single', NULL,
   'Amar Elaka: a ban was placed on your account.{{#reason}} Reason: {{reason}}.{{/reason}} You can appeal in the app.', '{reason}'),
  ('appeal_decided', 'in_app', 'bn', 'single', 'আপিলের সিদ্ধান্ত',
   '{{#upheld}}আপনার আপিল বিবেচনা করা হয়েছে, তবে নিষেধাজ্ঞা বহাল আছে।{{/upheld}}{{^upheld}}আপনার আপিল গ্রহণ করা হয়েছে, নিষেধাজ্ঞা তুলে নেওয়া হয়েছে।{{/upheld}}', '{upheld}'),
  ('appeal_decided', 'in_app', 'en', 'single', 'Your appeal was decided',
   '{{#upheld}}Your appeal was reviewed and the ban stays.{{/upheld}}{{^upheld}}Your appeal was accepted and the ban is lifted.{{/upheld}}', '{upheld}'),
  ('appeal_decided', 'sms', 'bn', 'single', NULL,
   'আমার এলাকা: {{#upheld}}আপনার আপিল বিবেচনা করা হয়েছে, নিষেধাজ্ঞা বহাল আছে।{{/upheld}}{{^upheld}}আপনার আপিল গ্রহণ করা হয়েছে, নিষেধাজ্ঞা তুলে নেওয়া হয়েছে।{{/upheld}}', '{upheld}'),
  ('appeal_decided', 'sms', 'en', 'single', NULL,
   'Amar Elaka: {{#upheld}}your appeal was reviewed and the ban stays.{{/upheld}}{{^upheld}}your appeal was accepted and the ban is lifted.{{/upheld}}', '{upheld}');
--> statement-breakpoint

-- ============================================================================
-- Push tokens
-- ============================================================================

-- Registers the caller's device push token (FCM, every platform — ADR 059),
-- or refreshes it (FCM rotates tokens). A token belongs to one device: if
-- another user held it (a shared phone, a new login), it moves here. The
-- caller's own row with it is touched; otherwise a new device row.
CREATE OR REPLACE FUNCTION public.register_push_token(p_platform text, p_token text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := public.current_user_id();
  v_id uuid;
BEGIN
  IF v_user IS NULL OR NOT public.app_is_active_user() THEN
    RAISE EXCEPTION 'register_push_token: a signed-in user is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.user_devices SET push_token = NULL WHERE push_token = p_token AND user_id <> v_user;
  UPDATE public.user_devices
  SET platform_code = p_platform, last_seen_at = now(), revoked_at = NULL
  WHERE user_id = v_user AND push_token = p_token
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    INSERT INTO public.user_devices (user_id, platform_code, push_token)
    VALUES (v_user, p_platform, p_token)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.register_push_token(text, text) OWNER TO ae_rls_bypass;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.register_push_token(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.register_push_token(text, text) TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Scheduled jobs (ADR 031)
-- ============================================================================

INSERT INTO public.scheduled_jobs (code, label_key, sort_order) VALUES
  ('relay-notification-outbox', 'enum.scheduled_jobs.relay-notification-outbox', 140),
  ('send-saved-search-digests', 'enum.scheduled_jobs.send-saved-search-digests', 150);
--> statement-breakpoint

-- ============================================================================
-- Settings (CLAUDE.md rule 9)
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('notification_daily_cap', '20', 'integer', 'notifications', 0, 500, 'platform',
   'Push, SMS and email notifications one user gets per Asia/Dhaka day, all types together; over it they stay in the in-app inbox only. Urgent types are exempt.'),
  ('notification_type_daily_caps', '{"new_message": 30, "saved_search_match": 6, "saved_post_price_drop": 5, "post_expiring": 5}', 'json', NULL, NULL, NULL, 'platform',
   'Per type: notifications one user gets per day before the rest stay in-app only. Types not listed are capped by notification_daily_cap alone.'),
  ('notification_quiet_hours_start', '"22:00"', 'text', 'time', NULL, NULL, 'tenant_admin',
   'Quiet hours begin (HH:MM, the tenant''s timezone): non-urgent pushes wait until they end.'),
  ('notification_quiet_hours_end', '"08:00"', 'text', 'time', NULL, NULL, 'tenant_admin',
   'Quiet hours end (HH:MM, the tenant''s timezone). Equal to the start = no quiet hours.'),
  ('notification_collapse_window_minutes', '60', 'integer', 'minutes', 0, 1440, 'platform',
   'Notifications of a collapsible type arriving within this many minutes of an unread one become one ("৪টি নতুন মেসেজ"); 0 = never collapse.'),
  ('notification_sms_extra_types', '[]', 'text_array', NULL, NULL, NULL, 'platform',
   'Notification types a platform admin allows SMS for, beyond the SMS-eligible ones (OTP, account security, bans and appeals). SMS costs money.'),
  ('notification_outbox_max_attempts', '8', 'integer', 'attempts', 1, 50, 'none',
   'Tries for a notification outbox event (a price drop) before it is set aside with its error.'),
  ('saved_search_weekly_digest_weekday', '5', 'integer', 'weekday', 1, 7, 'platform',
   'Day the weekly saved-search digest goes out (1 = Monday … 7 = Sunday, Asia/Dhaka). Default Friday.'),
  ('saved_search_weekly_digest_hour', '10', 'integer', 'hour', 0, 23, 'platform',
   'Hour (Asia/Dhaka) from which the weekly saved-search digest goes out.');
