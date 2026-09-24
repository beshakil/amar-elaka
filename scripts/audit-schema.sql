-- Schema audit: seven verification queries.
--
-- Every query must return ZERO rows. Any row is a violation, and CI fails
-- (apps/api/test/schema-audit.db-spec.ts, run by `pnpm test:db`).
--
-- Run by hand:  psql "$TEST_DATABASE_URL" -f scripts/audit-schema.sql
--
-- Schema under audit: `public` by default. The self-test points it at a
-- throwaway schema with:  select set_config('audit.schema', '<schema>', true);
--
-- Each check starts with a `-- @check <name>` marker line. The test parses
-- these markers, so keep one statement per check and don't rename them.
-- Every check returns a `table_name` column.


-- @check missing_rls
-- Tables and partitions without RLS enabled AND forced, or with zero policies
-- (docs/specs/schema.md §0.6). Objects owned by extensions (e.g. PostGIS
-- spatial_ref_sys) are excluded.
select
  n.nspname                 as schema_name,
  c.relname                 as table_name,
  c.relrowsecurity          as rls_enabled,
  c.relforcerowsecurity     as rls_forced,
  (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid) as policy_count
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = coalesce(nullif(current_setting('audit.schema', true), ''), 'public')
  and c.relkind in ('r', 'p')
  and not exists (
    select 1
    from pg_catalog.pg_depend d
    where d.classid = 'pg_catalog.pg_class'::regclass
      and d.objid = c.oid
      and d.deptype = 'e'
  )
  and (
    not c.relrowsecurity
    or not c.relforcerowsecurity
    or not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = c.oid)
  )
order by c.relname;


-- @check unspecified_on_delete
-- Foreign keys whose ON DELETE is NO ACTION, i.e. left unspecified. The schema
-- only uses CASCADE, RESTRICT or SET NULL (§0.5). Constraints cloned onto
-- partitions are skipped (conparentid <> 0); the parent's constraint is checked.
select
  n.nspname                              as schema_name,
  cl.relname                             as table_name,
  con.conname                            as constraint_name,
  pg_catalog.pg_get_constraintdef(con.oid) as definition
from pg_catalog.pg_constraint con
join pg_catalog.pg_class cl on cl.oid = con.conrelid
join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
where n.nspname = coalesce(nullif(current_setting('audit.schema', true), ''), 'public')
  and con.contype = 'f'
  and con.confdeltype = 'a'
  and con.conparentid = 0
order by cl.relname, con.conname;


-- @check float_money_columns
-- (a) Any real / double precision / money column (or array of them), anywhere.
-- (b) Any numeric column with a money-like name that isn't exactly numeric(12,2).
--     Names with a pct/percent/rate/credits/count segment are percentages, rates
--     (e.g. platform_share_rate_final numeric(5,4)) or counts, and aren't flagged.
select
  n.nspname                                        as schema_name,
  c.relname                                        as table_name,
  a.attname                                        as column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod)  as data_type
from pg_catalog.pg_attribute a
join pg_catalog.pg_class c on c.oid = a.attrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_type t on t.oid = a.atttypid
where n.nspname = coalesce(nullif(current_setting('audit.schema', true), ''), 'public')
  and c.relkind in ('r', 'p')
  and not c.relispartition
  and a.attnum > 0
  and not a.attisdropped
  and (
    t.typname in ('float4', 'float8', 'money', '_float4', '_float8', '_money')
    or (
      t.typname = 'numeric'
      and a.attname ~ '(^|_)(price|amount|fee|fees|total|cost|subtotal|discount|tax|payable|revenue|share|fare|reward)(_|$)'
      and a.attname !~ '(^|_)(pct|percent|rate|credits|count)(_|$)'
      and pg_catalog.format_type(a.atttypid, a.atttypmod) <> 'numeric(12,2)'
    )
  )
order by c.relname, a.attname;


-- @check timestamp_without_time_zone
-- Every instant is timestamptz (§0.2). Plain `timestamp` columns are violations.
-- (Wall-clock `time` and calendar `date` are deliberate and not flagged, §13.15.)
select
  n.nspname                                        as schema_name,
  c.relname                                        as table_name,
  a.attname                                        as column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod)  as data_type
from pg_catalog.pg_attribute a
join pg_catalog.pg_class c on c.oid = a.attrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_type t on t.oid = a.atttypid
where n.nspname = coalesce(nullif(current_setting('audit.schema', true), ''), 'public')
  and c.relkind in ('r', 'p')
  and not c.relispartition
  and a.attnum > 0
  and not a.attisdropped
  and t.typname in ('timestamp', '_timestamp')
order by c.relname, a.attname;


-- @check geography_without_gist
-- Every geography/geometry column must be covered by a GiST index, either on the
-- column itself or in an index expression that names it. Partial indexes count.
-- Types are matched by name so this query also runs where PostGIS isn't installed.
select
  n.nspname                                        as schema_name,
  c.relname                                        as table_name,
  a.attname                                        as column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod)  as data_type
from pg_catalog.pg_attribute a
join pg_catalog.pg_class c on c.oid = a.attrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_type t on t.oid = a.atttypid
where n.nspname = coalesce(nullif(current_setting('audit.schema', true), ''), 'public')
  and c.relkind in ('r', 'p')
  and not c.relispartition
  and a.attnum > 0
  and not a.attisdropped
  and t.typname in ('geography', 'geometry')
  and not exists (
    select 1
    from pg_catalog.pg_index i
    join pg_catalog.pg_class ic on ic.oid = i.indexrelid
    join pg_catalog.pg_am am on am.oid = ic.relam
    where i.indrelid = c.oid
      and am.amname = 'gist'
      and (
        a.attnum = any (i.indkey::smallint[])
        or (
          i.indexprs is not null
          and pg_catalog.pg_get_indexdef(i.indexrelid) ~ ('\m' || a.attname || '\M')
        )
      )
  )
order by c.relname, a.attname;


-- @check status_deletion_enum_overlap
-- A value must never be both a status and a deletion reason (e.g. 'sold' is a
-- status, never a deletion; docs/specs/schema.md §13.31). For every table with
-- FK columns named status/status_code AND deletion_reason/deletion_reason_code,
-- this intersects the two referenced enum tables' keys. Uses query_to_xml so it
-- works generically without knowing the enum tables in advance.
with fk_columns as (
  select
    con.conrelid,
    a.attname          as column_name,
    con.confrelid      as enum_table,
    ra.attname         as enum_key_column
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class cl on cl.oid = con.conrelid
  join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
  join pg_catalog.pg_attribute ra on ra.attrelid = con.confrelid and ra.attnum = con.confkey[1]
  where n.nspname = coalesce(nullif(current_setting('audit.schema', true), ''), 'public')
    and con.contype = 'f'
    and con.conparentid = 0
    and cardinality(con.conkey) = 1
    and a.attname in ('status', 'status_code', 'deletion_reason', 'deletion_reason_code')
),
pairs as (
  select
    s.conrelid,
    s.enum_table       as status_table,
    s.enum_key_column  as status_key,
    d.enum_table       as deletion_table,
    d.enum_key_column  as deletion_key
  from fk_columns s
  join fk_columns d on d.conrelid = s.conrelid
  where s.column_name in ('status', 'status_code')
    and d.column_name in ('deletion_reason', 'deletion_reason_code')
)
select
  n.nspname                      as schema_name,
  cl.relname                     as table_name,
  st.relname                     as status_enum_table,
  dt.relname                     as deletion_enum_table,
  overlap.value_xml::text        as overlapping_value
from pairs p
join pg_catalog.pg_class cl on cl.oid = p.conrelid
join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
join pg_catalog.pg_class st on st.oid = p.status_table
join pg_catalog.pg_class dt on dt.oid = p.deletion_table
cross join lateral unnest(
  xpath(
    '/table/row/code/text()',
    query_to_xml(
      format(
        'select s.%1$I::text as code from %2$s s join %3$s d on d.%4$I::text = s.%1$I::text',
        p.status_key, p.status_table::regclass, p.deletion_table::regclass, p.deletion_key
      ),
      false, false, ''
    )
  )
) as overlap(value_xml)
order by cl.relname, overlapping_value;


-- @check purge_job_without_legal_hold_check
-- Every purge, scrub or anonymise job is a DB function named purge_* / scrub_* /
-- anonymize_* (anonymise_* too), and must skip subjects under an open legal hold
-- (docs/specs/schema.md §11.9). A function passes if its definition calls
-- legal_hold_blocks( or carries an explicit `legal-hold-exempt: <reason>` comment
-- (for purges that can never touch a holdable subject, e.g. the outbox).
-- The function name is reported in table_name so every check has that column.
select
  n.nspname                                            as schema_name,
  p.proname                                            as table_name,
  p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as function_signature
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = coalesce(nullif(current_setting('audit.schema', true), ''), 'public')
  and p.prokind in ('f', 'p')
  and p.proname ~ '^(purge|scrub|anonymi[sz]e)_'
  and not exists (
    select 1
    from pg_catalog.pg_depend d
    where d.classid = 'pg_catalog.pg_proc'::regclass
      and d.objid = p.oid
      and d.deptype = 'e'
  )
  and pg_catalog.pg_get_functiondef(p.oid) !~ 'legal_hold_blocks\s*\('
  and pg_catalog.pg_get_functiondef(p.oid) !~ 'legal-hold-exempt:'
order by p.proname;
