import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import type { CreateAgentInput, CreateTaskInput, UpdateAgentInput } from './dto/agents.dto';

const nText = z.string().nullable();
const date = z.coerce.date();

const one = <T extends z.ZodTypeAny>(schema: T, rows: Iterable<unknown>): z.infer<T> | undefined =>
  z
    .array(schema)
    .max(1)
    .parse([...rows])[0];
const many = <T extends z.ZodTypeAny>(schema: T, rows: Iterable<unknown>): z.infer<T>[] =>
  z.array(schema).parse([...rows]);

const point = (p: { lat: number; lng: number } | null | undefined) =>
  p ? sql`st_setsrid(st_makepoint(${p.lng}, ${p.lat}), 4326)::geography` : sql`null::geography`;

const agentRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  member_id: z.string(),
  agent_code: z.string(),
  status_code: z.string(),
  commission_rate: nText,
  targets: z.object({ daily_shops: z.number().optional(), weekly_shops: z.number().optional() }),
});
export type AgentRow = z.infer<typeof agentRow>;

const submissionRow = z.object({
  id: z.string(),
  field_agent_id: z.string(),
  kind_code: z.string(),
  place_id: nText,
  fraud_flags: z.array(z.string()),
});
export type SubmissionRow = z.infer<typeof submissionRow>;

const neighbourRow = z.object({ captured_at: date, lat: z.number(), lng: z.number() });

const taskRow = z.object({
  id: z.string(),
  type_code: z.string(),
  title: z.string(),
  status_code: z.string(),
  due_on: z.string(),
  notes: nText,
  place_id: nText,
  place_name: nText,
  locality_name: nText,
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  done_at: date.nullable(),
});
export type TaskRow = z.infer<typeof taskRow>;

const outcomeRow = z.object({
  submission_id: z.string(),
  field_agent_id: z.string(),
  kind_code: z.string(),
  captured_at: date,
  created_at: date,
  place_id: nText,
  review_status: z.enum(['pending', 'approved', 'rejected']),
  reason_code: nText,
  reason_text: nText,
  fraud_flags: z.array(z.string()),
  commission: z.string(),
  name: nText,
});
export type OutcomeRow = z.infer<typeof outcomeRow>;

const dayRow = z.object({ day: z.string(), from: date, to: date });
export type DayBounds = z.infer<typeof dayRow>;

const listRow = z.object({
  id: z.string(),
  member_id: z.string(),
  agent_code: z.string(),
  name: nText,
  status_code: z.string(),
  commission_rate: nText,
  targets: z.object({ daily_shops: z.number().optional(), weekly_shops: z.number().optional() }),
});
export type AgentListRow = z.infer<typeof listRow>;

const daySubmissionRow = z.object({
  id: z.string(),
  field_agent_id: z.string(),
  agent_code: z.string(),
  kind_code: z.string(),
  captured_at: date,
  lat: z.number(),
  lng: z.number(),
  accuracy_m: z.coerce.number(),
  place_id: nText,
  place_edit_suggestion_id: nText,
  fraud_flags: z.array(z.string()),
  fraud_detail: z.record(z.unknown()),
  phone_check_status: z.string(),
  photo_media_ids: z.array(z.string()),
  notes: nText,
});
export type DaySubmissionRow = z.infer<typeof daySubmissionRow>;

const mediaRow = z.object({ id: z.string(), variants: z.unknown(), kind_code: z.string() });
export type MediaRow = z.infer<typeof mediaRow>;

export interface NewSubmission {
  id: string;
  agentId: string;
  taskId: string | null;
  kind: string;
  capturedAt: string;
  location: { lat: number; lng: number };
  accuracyM: number;
  photoLocation: { lat: number; lng: number } | null;
  photoTakenAt: string | null;
  photoMediaIds: readonly string[];
  payload: Record<string, unknown>;
  placeId: string | null;
  suggestionId: string | null;
  visitId: string | null;
  duplicateDecision: 'new' | 'same' | null;
  duplicateOfPlaceId: string | null;
  fraudFlags: readonly string[];
  fraudDetail: Record<string, unknown>;
  phoneCheck: 'none' | 'verified' | 'failed';
}

/** Field agent mode's SQL (ADR 066). Every query runs under RLS in the caller's area. */
@Injectable()
export class AgentsRepository {
  // ---- the agent ---------------------------------------------------------------

  /** The caller's own field agent row in this area (RLS: field_agents_self_select). */
  async myAgent(tx: DatabaseTransaction): Promise<AgentRow | undefined> {
    const rows = await tx.execute(sql`
      select id, tenant_id, member_id, agent_code, status_code, commission_rate::text as commission_rate, targets
      from public.field_agents
      where tenant_id = public.current_tenant_id() and member_id = public.current_member_id()
        and deleted_at is null`);
    return one(agentRow, rows);
  }

  /** Serialises every upload of one submission (a sync retried, or run twice at once). */
  async lockSubmission(tx: DatabaseTransaction, id: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`agent_submission:${id}`}, 0))`,
    );
  }

  async findSubmission(tx: DatabaseTransaction, id: string): Promise<SubmissionRow | undefined> {
    const rows = await tx.execute(sql`
      select id, field_agent_id, kind_code, place_id, fraud_flags
      from public.agent_submissions where id = ${id}::uuid`);
    return one(submissionRow, rows);
  }

  /** The agent's captures nearest in time on either side (a queue syncs out of order). */
  async neighbours(
    tx: DatabaseTransaction,
    agentId: string,
    capturedAt: string,
    excludeId: string,
  ): Promise<z.infer<typeof neighbourRow>[]> {
    const rows = await tx.execute(sql`
      (select captured_at, st_y(location::geometry) as lat, st_x(location::geometry) as lng
       from public.agent_submissions
       where field_agent_id = ${agentId}::uuid and id <> ${excludeId}::uuid and captured_at <= ${capturedAt}::timestamptz
       order by captured_at desc limit 1)
      union all
      (select captured_at, st_y(location::geometry), st_x(location::geometry)
       from public.agent_submissions
       where field_agent_id = ${agentId}::uuid and id <> ${excludeId}::uuid and captured_at > ${capturedAt}::timestamptz
       order by captured_at limit 1)`);
    return many(neighbourRow, rows);
  }

  async photoReuse(
    tx: DatabaseTransaction,
    submissionId: string,
    media: readonly string[],
    lookbackDays: number,
  ): Promise<number> {
    if (media.length === 0) return 0;
    const rows = await tx.execute(sql`
      select count(distinct other_submission_id)::integer as n
      from public.agent_photo_reuse(${submissionId}::uuid, ${`{${media.join(',')}}`}::uuid[],
                                    now() - make_interval(days => ${lookbackDays}))`);
    return one(z.object({ n: z.number() }), rows)?.n ?? 0;
  }

  async phoneCheckStatus(tx: DatabaseTransaction, submissionId: string): Promise<string | null> {
    const rows = await tx.execute(sql`
      select status_code from public.agent_phone_checks where submission_id = ${submissionId}::uuid`);
    return one(z.object({ status_code: z.string() }), rows)?.status_code ?? null;
  }

  async insertVisit(
    tx: DatabaseTransaction,
    visit: {
      agentId: string;
      placeId: string;
      purpose: 'onboarding' | 'verification' | 'info_update';
      outcome: 'submitted' | 'verified';
      visitedAt: string;
      location: { lat: number; lng: number };
      accuracyM: number;
      notes: string | null;
      clientVisitId: string;
    },
  ): Promise<string> {
    const rows = await tx.execute(sql`
      insert into public.agent_visits
        (field_agent_id, place_id, purpose_code, outcome_code, visited_at, check_in_location, check_in_accuracy_m,
         notes, client_visit_id)
      values (${visit.agentId}::uuid, ${visit.placeId}::uuid, ${visit.purpose}, ${visit.outcome},
              ${visit.visitedAt}::timestamptz, ${point(visit.location)}, ${Math.round(visit.accuracyM)},
              ${visit.notes}, ${visit.clientVisitId})
      returning id`);
    return one(z.object({ id: z.string() }), rows)!.id;
  }

  /** A field agent was there (0042 lets agents set field_verified_at). */
  async markFieldVerified(tx: DatabaseTransaction, placeId: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.places set field_verified_at = now()
      where id = ${placeId}::uuid and deleted_at is null
      returning id`);
    return [...rows].length === 1;
  }

  async insertSubmission(tx: DatabaseTransaction, s: NewSubmission): Promise<void> {
    await tx.execute(sql`
      insert into public.agent_submissions
        (id, field_agent_id, task_id, kind_code, captured_at, location, accuracy_m, photo_location, photo_taken_at,
         photo_media_ids, payload, place_id, place_edit_suggestion_id, agent_visit_id, duplicate_decision,
         duplicate_of_place_id, fraud_flags, fraud_detail, phone_check_status)
      values (${s.id}::uuid, ${s.agentId}::uuid, ${s.taskId}::uuid, ${s.kind}, ${s.capturedAt}::timestamptz,
              ${point(s.location)}, ${s.accuracyM}, ${point(s.photoLocation)}, ${s.photoTakenAt}::timestamptz,
              ${`{${s.photoMediaIds.join(',')}}`}::uuid[], ${JSON.stringify(s.payload)}::text::jsonb,
              ${s.placeId}::uuid, ${s.suggestionId}::uuid, ${s.visitId}::uuid, ${s.duplicateDecision},
              ${s.duplicateOfPlaceId}::uuid, ${`{${s.fraudFlags.join(',')}}`}::text[],
              ${JSON.stringify(s.fraudDetail)}::text::jsonb, ${s.phoneCheck})`);
  }

  /** The task this submission answers is done (the agent's own, still open). */
  async completeTask(tx: DatabaseTransaction, taskId: string, agentId: string): Promise<void> {
    await tx.execute(sql`
      update public.agent_tasks set status_code = 'done', done_at = now()
      where id = ${taskId}::uuid and field_agent_id = ${agentId}::uuid and status_code = 'open'`);
  }

  async taskExists(tx: DatabaseTransaction, taskId: string, agentId: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      select 1 as x from public.agent_tasks where id = ${taskId}::uuid and field_agent_id = ${agentId}::uuid`);
    return [...rows].length === 1;
  }

  /** A phone check, as the system: flag an already-synced submission. */
  async addFlag(
    tx: DatabaseTransaction,
    submissionId: string,
    flag: string,
    phoneCheck: string,
  ): Promise<void> {
    await tx.execute(sql`
      update public.agent_submissions
      set fraud_flags = (select coalesce(array_agg(distinct f order by f), '{}') from unnest(fraud_flags || ${flag}::text) f),
          phone_check_status = ${phoneCheck}
      where id = ${submissionId}::uuid`);
  }

  async setPhoneCheck(
    tx: DatabaseTransaction,
    submissionId: string,
    status: string,
  ): Promise<void> {
    await tx.execute(sql`
      update public.agent_submissions set phone_check_status = ${status} where id = ${submissionId}::uuid`);
  }

  async upsertPhoneCheck(
    tx: DatabaseTransaction,
    agentId: string,
    submissionId: string,
    phoneHash: string,
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.agent_phone_checks (field_agent_id, submission_id, phone_hash)
      values (${agentId}::uuid, ${submissionId}::uuid, ${phoneHash})
      on conflict (tenant_id, submission_id)
      do update set phone_hash = excluded.phone_hash,
                    status_code = case when agent_phone_checks.status_code = 'verified'
                                        and agent_phone_checks.phone_hash = excluded.phone_hash
                                       then 'verified' else 'sent' end`);
  }

  async recordPhoneResult(
    tx: DatabaseTransaction,
    submissionId: string,
    phoneHash: string,
    verified: boolean,
  ): Promise<string | null> {
    const rows = await tx.execute(sql`
      update public.agent_phone_checks
      set attempts = attempts + 1,
          status_code = case when ${verified} then 'verified'
                             when status_code = 'verified' then 'verified' else 'failed' end
      where submission_id = ${submissionId}::uuid and phone_hash = ${phoneHash}
      returning status_code`);
    return one(z.object({ status_code: z.string() }), rows)?.status_code ?? null;
  }

  // ---- days and outcomes ---------------------------------------------------------

  /** A calendar day in the area's own zone (today when `day` is null), as instants. */
  async dayBounds(tx: DatabaseTransaction, day: string | null): Promise<DayBounds> {
    const rows = await tx.execute(sql`
      with d as (
        select coalesce(${day}::date, (now() at time zone t.timezone)::date) as day, t.timezone
        from public.tenants t where t.id = public.current_tenant_id()
      )
      select day::text as day, (day::timestamp at time zone timezone) as "from",
             ((day + 1)::timestamp at time zone timezone) as "to"
      from d`);
    return one(dayRow, rows)!;
  }

  /** The week containing `day`, starting on agent_stats_week_start_iso_day. */
  async weekBounds(tx: DatabaseTransaction, day: string, startIsoDay: number): Promise<DayBounds> {
    const rows = await tx.execute(sql`
      with d as (
        select (${day}::date - ((extract(isodow from ${day}::date)::integer - ${startIsoDay} + 7) % 7)) as day,
               t.timezone
        from public.tenants t where t.id = public.current_tenant_id()
      )
      select day::text as day, (day::timestamp at time zone timezone) as "from",
             ((day + 7)::timestamp at time zone timezone) as "to"
      from d`);
    return one(dayRow, rows)!;
  }

  /** THE review status and commission (agent_submission_outcomes), with the shop's name. */
  async outcomes(
    tx: DatabaseTransaction,
    agentId: string | null,
    from: Date,
    to: Date,
  ): Promise<OutcomeRow[]> {
    const rows = await tx.execute(sql`
      select o.submission_id, o.field_agent_id, o.kind_code, o.captured_at, o.created_at, o.place_id,
             o.review_status, o.reason_code, o.reason_text, o.fraud_flags, o.commission::text as commission,
             coalesce(s.payload ->> 'nameBn', p.name_bn) as name
      from public.agent_submission_outcomes(${agentId}::uuid, ${from.toISOString()}::timestamptz,
                                            ${to.toISOString()}::timestamptz) o
      join public.agent_submissions s on s.id = o.submission_id
      left join public.places p on p.id = o.place_id`);
    return many(outcomeRow, rows);
  }

  // ---- tasks ---------------------------------------------------------------------

  /** An agent's open tasks due by `day`, and those done on it. */
  async tasksFor(
    tx: DatabaseTransaction,
    agentId: string,
    day: DayBounds | null,
  ): Promise<TaskRow[]> {
    const rows = await tx.execute(sql`
      select t.id, t.type_code, t.title, t.status_code, t.due_on::text as due_on, t.notes, t.place_id,
             p.name_bn as place_name, l.name_bn as locality_name,
             st_y(coalesce(t.target_location, p.location, l.center)::geometry) as lat,
             st_x(coalesce(t.target_location, p.location, l.center)::geometry) as lng,
             t.done_at
      from public.agent_tasks t
      left join public.places p on p.tenant_id = t.tenant_id and p.id = t.place_id
      left join public.localities l on l.tenant_id = t.tenant_id and l.id = t.locality_id
      where t.field_agent_id = ${agentId}::uuid
        and ${
          day
            ? sql`((t.status_code = 'open' and t.due_on <= ${day.day}::date)
                   or (t.status_code = 'done' and t.done_at >= ${day.from.toISOString()}::timestamptz
                       and t.done_at < ${day.to.toISOString()}::timestamptz))`
            : sql`t.status_code <> 'cancelled'`
        }
      order by t.status_code = 'done', t.due_on, t.created_at`);
    return many(taskRow, rows);
  }

  async createTask(
    tx: DatabaseTransaction,
    agentId: string,
    input: CreateTaskInput,
    userId: string,
  ): Promise<string> {
    const rows = await tx.execute(sql`
      insert into public.agent_tasks
        (field_agent_id, type_code, title, locality_id, target_location, place_id, due_on, notes, created_by_user_id)
      values (${agentId}::uuid, ${input.type}, ${input.title}, ${input.localityId ?? null}::uuid,
              ${point(input.location)}, ${input.placeId ?? null}::uuid, ${input.dueOn}::date,
              ${input.notes ?? null}, ${userId}::uuid)
      returning id`);
    return one(z.object({ id: z.string() }), rows)!.id;
  }

  async setTaskStatus(
    tx: DatabaseTransaction,
    taskId: string,
    status: 'open' | 'cancelled',
  ): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.agent_tasks set status_code = ${status}, done_at = null
      where id = ${taskId}::uuid and status_code <> 'done'
      returning id`);
    return [...rows].length === 1;
  }

  // ---- staff ---------------------------------------------------------------------

  async listAgents(tx: DatabaseTransaction): Promise<AgentListRow[]> {
    const rows = await tx.execute(sql`
      select fa.id, fa.member_id, fa.agent_code, up.display_name as name, fa.status_code,
             fa.commission_rate::text as commission_rate, fa.targets
      from public.field_agents fa
      join public.tenant_members tm on tm.tenant_id = fa.tenant_id and tm.id = fa.member_id
      left join public.user_profiles up on up.user_id = tm.user_id
      where fa.tenant_id = public.current_tenant_id() and fa.deleted_at is null
      order by fa.status_code = 'active' desc, fa.agent_code`);
    return many(listRow, rows);
  }

  /** Members with the agent role who are not field agents yet. */
  async candidates(tx: DatabaseTransaction): Promise<{ member_id: string; name: string | null }[]> {
    const rows = await tx.execute(sql`
      select tm.id as member_id, up.display_name as name
      from public.tenant_members tm
      left join public.user_profiles up on up.user_id = tm.user_id
      where tm.tenant_id = public.current_tenant_id() and tm.role_code = 'agent' and tm.deleted_at is null
        and not exists (select 1 from public.field_agents fa
                        where fa.tenant_id = tm.tenant_id and fa.member_id = tm.id and fa.deleted_at is null)
      order by up.display_name nulls last`);
    return many(z.object({ member_id: z.string(), name: nText }), rows);
  }

  async createAgent(tx: DatabaseTransaction, input: CreateAgentInput): Promise<string> {
    const rows = await tx.execute(sql`
      insert into public.field_agents (member_id, agent_code, employment_type_code, commission_rate, targets, joined_on)
      select ${input.memberId}::uuid, ${input.agentCode}, ${input.employmentType}, ${input.commissionRate}::numeric,
             ${JSON.stringify(input.targets)}::text::jsonb, (now() at time zone t.timezone)::date
      from public.tenants t where t.id = public.current_tenant_id()
      returning id`);
    return one(z.object({ id: z.string() }), rows)!.id;
  }

  async memberIsAgent(tx: DatabaseTransaction, memberId: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      select 1 as x from public.tenant_members
      where id = ${memberId}::uuid and role_code = 'agent' and deleted_at is null`);
    return [...rows].length === 1;
  }

  async updateAgent(
    tx: DatabaseTransaction,
    id: string,
    input: UpdateAgentInput,
  ): Promise<boolean> {
    const rows = await tx.execute(sql`
      update public.field_agents
      set status_code = coalesce(${input.status ?? null}, status_code),
          commission_rate = case when ${input.commissionRate !== undefined}
                                 then ${input.commissionRate ?? null}::numeric else commission_rate end,
          targets = coalesce(${input.targets ? JSON.stringify(input.targets) : null}::text::jsonb, targets),
          terminated_on = case when ${input.status ?? null} = 'terminated' and terminated_on is null
                               then current_date else terminated_on end
      where id = ${id}::uuid and deleted_at is null
      returning id`);
    return [...rows].length === 1;
  }

  async agentExists(tx: DatabaseTransaction, id: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      select 1 as x from public.field_agents where id = ${id}::uuid and deleted_at is null`);
    return [...rows].length === 1;
  }

  /** A day's submissions in the area (the admin's map and review list). */
  async submissionsBetween(
    tx: DatabaseTransaction,
    from: Date,
    to: Date,
    agentId: string | null,
    limit: number,
  ): Promise<DaySubmissionRow[]> {
    const rows = await tx.execute(sql`
      select s.id, s.field_agent_id, fa.agent_code, s.kind_code, s.captured_at,
             st_y(s.location::geometry) as lat, st_x(s.location::geometry) as lng, s.accuracy_m,
             s.place_id, s.place_edit_suggestion_id, s.fraud_flags, s.fraud_detail, s.phone_check_status,
             s.photo_media_ids::text[] as photo_media_ids, s.payload ->> 'notes' as notes
      from public.agent_submissions s
      join public.field_agents fa on fa.tenant_id = s.tenant_id and fa.id = s.field_agent_id
      where s.tenant_id = public.current_tenant_id()
        and s.created_at >= ${from.toISOString()}::timestamptz and s.created_at < ${to.toISOString()}::timestamptz
        and (${agentId}::uuid is null or s.field_agent_id = ${agentId}::uuid)
      order by s.created_at desc
      limit ${limit}`);
    return many(daySubmissionRow, rows);
  }

  async media(tx: DatabaseTransaction, ids: readonly string[]): Promise<MediaRow[]> {
    if (ids.length === 0) return [];
    const rows = await tx.execute(sql`
      select id, variants, kind_code from public.media_assets
      where id = any(${`{${ids.join(',')}}`}::uuid[]) and status_code = 'ready'`);
    return many(mediaRow, rows);
  }
}
