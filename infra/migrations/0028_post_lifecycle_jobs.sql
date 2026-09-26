-- 0028_post_lifecycle_jobs
--
-- Scheduled post-lifecycle jobs and their health record (ADR 031):
--
--   scheduled_jobs      ENUM: the jobs the worker runs on a schedule (and a
--                       platform admin can trigger by hand).
--   job_runs            PLATFORM: one row per run — trigger, timing, rows
--                       affected, outcome, error. Written only by the system
--                       (the worker); read by platform staff. A partial
--                       unique index keeps one job from running twice at once.
--   posts               + expiry_reminder_for: the expires_at the owner was
--                       last reminded about, so the reminder goes once per
--                       listing period; + DELETE, but only for the system
--                       removing a stale, unheld draft (RESTRICTIVE policy).
--
-- Plus the post_expiring notification type and the settings: reminder lead
-- time, draft retention, per-run batch caps, stale-run and run-history windows.
-- Seeds: the settings and lookup rows below; job_runs starts empty.

-- ============================================================================
-- Lookup codes
-- ============================================================================

INSERT INTO public.notification_types (code, label_key, sort_order) VALUES
  ('post_expiring', 'enum.notification_types.post_expiring', 36);
--> statement-breakpoint

CREATE TABLE public.scheduled_jobs (
  code text NOT NULL, label_key text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_jobs_pk PRIMARY KEY (code), CONSTRAINT scheduled_jobs_code_ck CHECK (code ~ '^[a-z][a-z0-9-]*$')
);
--> statement-breakpoint
CREATE TRIGGER scheduled_jobs_set_updated_at BEFORE UPDATE ON public.scheduled_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
-- Codes are the BullMQ job names (apps/api/src/queue/queue.types.ts).
INSERT INTO public.scheduled_jobs (code, label_key, sort_order) VALUES
  ('expire-posts', 'enum.scheduled_jobs.expire-posts', 10),
  ('remind-expiring-posts', 'enum.scheduled_jobs.remind-expiring-posts', 20),
  ('clean-stale-drafts', 'enum.scheduled_jobs.clean-stale-drafts', 30),
  ('clean-orphan-media', 'enum.scheduled_jobs.clean-orphan-media', 40),
  ('purge-deleted-media', 'enum.scheduled_jobs.purge-deleted-media', 50);
--> statement-breakpoint

-- ============================================================================
-- job_runs
-- ============================================================================

CREATE TABLE public.job_runs (
  id                    uuid        NOT NULL DEFAULT public.uuid_generate_v7(),
  job_code              text        NOT NULL,
  trigger_code          text        NOT NULL,
  triggered_by_user_id  uuid,
  -- The BullMQ job id, to line a run up with the queue and the worker logs.
  queue_job_id          text,
  status_code           text        NOT NULL DEFAULT 'running',
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  duration_ms           integer,
  rows_affected         integer     NOT NULL DEFAULT 0,
  -- Per-job counters (e.g. whether the run stopped at its batch cap).
  details               jsonb       NOT NULL DEFAULT '{}',
  -- The error's class and message only; stacks stay in the worker logs.
  error_message         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_runs_pk PRIMARY KEY (id),
  CONSTRAINT job_runs_job_code_fk FOREIGN KEY (job_code)
    REFERENCES public.scheduled_jobs (code) ON DELETE RESTRICT,
  CONSTRAINT job_runs_triggered_by_user_id_fk FOREIGN KEY (triggered_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT job_runs_trigger_code_ck CHECK (trigger_code IN ('schedule', 'manual')),
  CONSTRAINT job_runs_status_code_ck CHECK (status_code IN ('running', 'succeeded', 'failed', 'skipped')),
  CONSTRAINT job_runs_finished_ck CHECK ((status_code = 'running') = (finished_at IS NULL)),
  CONSTRAINT job_runs_rows_affected_ck CHECK (rows_affected >= 0),
  CONSTRAINT job_runs_duration_ms_ck CHECK (duration_ms IS NULL OR duration_ms >= 0)
);
--> statement-breakpoint
-- One run of a job at a time: a second start (a manual trigger during the
-- scheduled run, a second worker) finds this and records itself as skipped.
CREATE UNIQUE INDEX job_runs_one_running_uq ON public.job_runs (job_code) WHERE status_code = 'running';
--> statement-breakpoint
CREATE INDEX job_runs_job_code_started_at_idx ON public.job_runs (job_code, started_at DESC);
--> statement-breakpoint
CREATE INDEX job_runs_triggered_by_user_id_idx ON public.job_runs (triggered_by_user_id)
  WHERE triggered_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER job_runs_set_updated_at BEFORE UPDATE ON public.job_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- posts: expiry reminders and stale-draft deletion
-- ============================================================================

ALTER TABLE public.posts ADD COLUMN expiry_reminder_for timestamptz;
--> statement-breakpoint
COMMENT ON COLUMN public.posts.expiry_reminder_for IS
  'The expires_at the owner was last reminded about (remind-expiring-posts). A repost sets a new expires_at, so the next period gets its own reminder.';
--> statement-breakpoint
CREATE INDEX posts_draft_updated_at_idx ON public.posts (updated_at) WHERE status_code = 'draft';
--> statement-breakpoint
GRANT DELETE ON public.posts TO ae_app;
--> statement-breakpoint
-- Hard delete exists for one case only: the system removing a draft nobody
-- touched for draft_retention_days, never one under a legal hold. RESTRICTIVE,
-- so it narrows every permissive FOR ALL policy (author, staff, platform) for
-- DELETE: no other role or status can ever hard-delete a post.
CREATE POLICY posts_delete_stale_draft_only ON public.posts
  AS RESTRICTIVE
  FOR DELETE
  USING (
    (SELECT public.app_is_system())
    AND status_code = 'draft'
    AND deletion_reason_code IS DISTINCT FROM 'legal_hold'
    AND NOT public.legal_hold_blocks('post', id)
  );
--> statement-breakpoint

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE public.scheduled_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.scheduled_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY scheduled_jobs_read_all ON public.scheduled_jobs FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY scheduled_jobs_platform_admin ON public.scheduled_jobs
  FOR ALL USING ((SELECT public.is_platform_admin())) WITH CHECK ((SELECT public.is_platform_admin()));
--> statement-breakpoint
GRANT SELECT ON public.scheduled_jobs TO ae_app;
--> statement-breakpoint

ALTER TABLE public.job_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.job_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY job_runs_platform_read ON public.job_runs
  FOR SELECT USING ((SELECT public.app_is_platform()));
--> statement-breakpoint
CREATE POLICY job_runs_system_write ON public.job_runs
  FOR ALL USING ((SELECT public.app_is_system())) WITH CHECK ((SELECT public.app_is_system()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_runs TO ae_app;
--> statement-breakpoint

-- ============================================================================
-- Settings
-- ============================================================================

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('post_expiry_reminder_days', '3', 'integer', 'days', 1, 30, 'none',
   'How long before a live post expires its owner is reminded, with a one-tap repost that renews it.'),
  ('draft_retention_days', '30', 'integer', 'days', 1, 365, 'none',
   'A draft nobody touched for this long is deleted (never one under a legal hold).'),
  ('job_batch_size', '200', 'integer', 'count', 1, 5000, 'none',
   'Rows a scheduled job handles per transaction.'),
  ('job_max_batches_per_run', '50', 'integer', 'count', 1, 1000, 'none',
   'Batches one run may take before it stops; the rest waits for the next run.'),
  ('job_run_stale_minutes', '60', 'integer', 'minutes', 5, 1440, 'none',
   'A run still marked running after this long is taken as lost (worker died) and no longer blocks the next one.'),
  ('job_run_retention_days', '30', 'integer', 'days', 1, 365, 'none',
   'How long the job run history (job_runs) is kept.'),
  ('job_runs_page_size', '20', 'integer', 'count', 1, 200, 'none',
   'Runs listed per job in the platform jobs view.');
