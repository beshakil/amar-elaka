-- 0047_notification_inbox
--
-- The in-app notification inbox (GET /notifications): the table, its RLS
-- (the owner reads and marks their own) and grants have existed since 0009;
-- this adds only the page-size settings (CLAUDE.md rule 9). Tests:
-- apps/api/test/notification-inbox.e2e-spec.ts.

SELECT set_config('app.is_platform_admin', 'true', true);
--> statement-breakpoint

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('notifications_page_size_default', '20', 'integer', 'count', 1, 200, 'none',
   'Notifications per inbox page when the client asks for no size.'),
  ('notifications_page_size_max', '50', 'integer', 'count', 1, 500, 'none',
   'Most notifications one inbox page returns.');
