-- 0000_foundation
--
-- Extensions and helper functions every later migration relies on
-- (docs/specs/schema.md §0.1, §0.2). Hand-written; applied by `pnpm db:migrate`.
-- Statements are separated by drizzle's statement-breakpoint marker because
-- the migrator sends each chunk as a single statement. Never write the marker
-- itself inside a comment: the migrator splits on it wherever it appears.

CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint

-- uuid_generate_v7(): RFC 9562 UUID version 7.
-- PostgreSQL 16 has no native v7 (uuidv7() arrives in PG18) and uuid-ossp only
-- does v1/v4. Layout:
--   bytes 0-5  : Unix time in milliseconds (clock_timestamp, big-endian)
--   byte  6    : version nibble 0111 + 4 random bits
--   byte  8    : variant bits 10 + 6 random bits
--   remaining  : random, taken from the built-in gen_random_uuid()
-- Ids are ordered across milliseconds; within the same millisecond ordering is
-- random, which is fine for index locality (no strict monotonic counter).
CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
PARALLEL SAFE
AS $$
DECLARE
  unix_ts_ms bytea;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms := substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  uuid_bytes := unix_ts_ms || substring(uuid_send(gen_random_uuid()) FROM 7);
  -- casting an integer to bit(n) keeps its rightmost n bits
  uuid_bytes := set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
  uuid_bytes := set_byte(uuid_bytes, 8, (b'10' || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.uuid_generate_v7() IS 'RFC 9562 UUIDv7 (ms timestamp + random). Default for every entity id.';
--> statement-breakpoint

-- set_updated_at(): BEFORE UPDATE row trigger for every table with updated_at.
-- now() is the transaction start time, so all rows touched by one transaction
-- share one updated_at (matches created_at semantics).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION public.set_updated_at() IS 'BEFORE UPDATE trigger: keeps updated_at current. Attach to every table that has updated_at.';
