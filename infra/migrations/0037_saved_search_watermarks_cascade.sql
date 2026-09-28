-- 0037_saved_search_watermarks_cascade
--
-- saved_search_watermarks (0035) is the saved-search matcher's bookmark: the
-- last post of each tenant it has looked at. It is system state that means
-- nothing without its tenant, so deleting a tenant takes it along (CASCADE)
-- instead of being blocked by it (RESTRICT).
--
-- Why now: the matcher walks every active tenant and creates a watermark for
-- each one it meets for the first time. With RESTRICT, any tenant it had
-- seen could no longer be deleted: in CI, the API e2e suites run in parallel
-- and each deletes its own fixture tenants afterwards, which failed as soon as
-- the saved-search suite's matcher had passed over them.
--
-- Only the foreign key's ON DELETE changes: no column is dropped or renamed.
-- No new table, so no new RLS or seed.

ALTER TABLE public.saved_search_watermarks
  DROP CONSTRAINT saved_search_watermarks_tenant_id_fk;
--> statement-breakpoint
ALTER TABLE public.saved_search_watermarks
  ADD CONSTRAINT saved_search_watermarks_tenant_id_fk FOREIGN KEY (tenant_id)
    REFERENCES public.tenants (id) ON DELETE CASCADE;
