import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import { SUGGESTION_STATUSES, type SuggestionChanges } from './dto/place-moderation.dto';

const hoursEntry = z.object({ day: z.number(), opens: z.string(), closes: z.string() });
const changesSchema = z
  .object({
    location: z.object({ lat: z.number(), lng: z.number() }).optional(),
    phones: z.array(z.string()).optional(),
    hours: z.array(hoursEntry).optional(),
  })
  .passthrough();

const REPORT_QUEUE_ROW = z.object({
  place_id: z.string(),
  first_id: z.string(),
  first_at: z.coerce.date(),
  reporters: z.number(),
  reasons: z.record(z.number()),
  notes: z.array(z.string()).nullable(),
  name_bn: z.string(),
  name_en: z.string().nullable(),
  status_code: z.string(),
  lat: z.number(),
  lng: z.number(),
  possibly_closed: z.boolean(),
});
export type ReportQueueRow = z.infer<typeof REPORT_QUEUE_ROW>;

const SUGGESTION_ROW = z.object({
  id: z.string(),
  tenant_id: z.string(),
  place_id: z.string(),
  suggester_member_id: z.string(),
  changes: changesSchema,
  note: z.string().nullable(),
  status_code: z.enum(SUGGESTION_STATUSES),
  created_at: z.coerce.date(),
});
export type SuggestionRow = z.infer<typeof SUGGESTION_ROW>;

const SUGGESTION_QUEUE_ROW = SUGGESTION_ROW.extend({
  place_name_bn: z.string(),
  place_name_en: z.string().nullable(),
  place_lat: z.number(),
  place_lng: z.number(),
  place_phones: z.array(z.string()),
  place_hours: z.array(hoursEntry.extend({ next_day: z.boolean() })),
});
export type SuggestionQueueRow = z.infer<typeof SUGGESTION_QUEUE_ROW>;

const SUGGESTION_COLUMNS = sql`
  s.id, s.tenant_id, s.place_id, s.suggester_member_id, s.changes, s.note, s.status_code, s.created_at`;

/**
 * SQL for place reports and edit suggestions (0046). Filing goes through the
 * SECURITY DEFINER functions report_place() and suggest_place_edit() as the
 * member; everything else is plain RLS (the reporter / suggester reads their
 * own, staff read and decide in their tenant).
 */
@Injectable()
export class PlaceModerationRepository {
  /** Reports the caller filed in this tenant within the last `seconds`. */
  async reportsSince(tx: DatabaseTransaction, seconds: number): Promise<number> {
    const rows = await tx.execute(sql`
      select count(*)::int as n from public.reports
      where reporter_member_id = public.current_member_id()
        and created_at > now() - make_interval(secs => ${seconds})`);
    return z
      .array(z.object({ n: z.number() }))
      .length(1)
      .parse([...rows])[0]!.n;
  }

  async reportPlace(
    tx: DatabaseTransaction,
    placeId: string,
    reasonCode: string,
    details: string | null,
  ): Promise<{ reportId: string; created: boolean; flagged: boolean }> {
    const rows = await tx.execute(sql`
      select report_id, created, flagged
      from public.report_place(${placeId}::uuid, ${reasonCode}, ${details})`);
    const row = z
      .array(z.object({ report_id: z.string(), created: z.boolean(), flagged: z.boolean() }))
      .length(1)
      .parse([...rows])[0]!;
    return { reportId: row.report_id, created: row.created, flagged: row.flagged };
  }

  /** Places with open reports, grouped, oldest first report first. */
  async reportQueue(
    tx: DatabaseTransaction,
    reason: string | null,
    after: string | null,
    limit: number,
    notesMax: number,
  ): Promise<ReportQueueRow[]> {
    const rows = await tx.execute(sql`
      with open_reports as (
        select r.id, r.place_id, r.reporter_member_id, r.reason_code, r.details, r.created_at
        from public.reports r
        where r.place_id is not null and r.status_code in ('open', 'in_review')
      ), grouped as (
        select o.place_id, min(o.id::text)::uuid as first_id, min(o.created_at) as first_at,
               count(distinct o.reporter_member_id)::int as reporters,
               (array_agg(o.details order by o.id desc) filter (where o.details is not null))[1:${notesMax}::int] as notes
        from open_reports o
        group by o.place_id
        ${reason ? sql`having bool_or(o.reason_code = ${reason})` : sql``}
      )
      select g.place_id, g.first_id, g.first_at, g.reporters, g.notes,
             (select jsonb_object_agg(x.reason_code, x.n) from (
                select o.reason_code, count(*)::int as n from open_reports o
                where o.place_id = g.place_id group by o.reason_code) x) as reasons,
             p.name_bn, p.name_en, p.status_code,
             st_y(p.location::geometry) as lat, st_x(p.location::geometry) as lng,
             p.possibly_closed_at is not null as possibly_closed
      from grouped g join public.places p on p.id = g.place_id
      where p.deleted_at is null ${after ? sql`and g.first_id > ${after}::uuid` : sql``}
      order by g.first_id
      limit ${limit}`);
    return z.array(REPORT_QUEUE_ROW).parse([...rows]);
  }

  /** The place's open reports (all, or of one reason), locked. */
  async openReports(
    tx: DatabaseTransaction,
    placeId: string,
    reason: string | null,
  ): Promise<string[]> {
    const rows = await tx.execute(sql`
      select id from public.reports
      where place_id = ${placeId}::uuid and status_code in ('open', 'in_review')
        ${reason ? sql`and reason_code = ${reason}` : sql``}
      order by id
      for update`);
    return z
      .array(z.object({ id: z.string() }))
      .parse([...rows])
      .map((r) => r.id);
  }

  async closeReports(
    tx: DatabaseTransaction,
    ids: readonly string[],
    close: {
      status: 'actioned' | 'dismissed';
      resolution: string;
      note: string | null;
      userId: string;
    },
  ): Promise<void> {
    if (ids.length === 0) return;
    await tx.execute(sql`
      update public.reports
      set status_code = ${close.status}, resolution_code = ${close.resolution},
          resolution_note = ${close.note}, resolved_at = now(),
          assigned_to_user_id = ${close.userId}::uuid
      where id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`);
  }

  /** Staff only (the places guard keeps it from anyone else). */
  async setPossiblyClosed(tx: DatabaseTransaction, placeId: string, on: boolean): Promise<void> {
    await tx.execute(sql`
      update public.places set possibly_closed_at = ${on ? sql`now()` : sql`null`}
      where id = ${placeId}::uuid`);
  }

  async possiblyClosed(tx: DatabaseTransaction, placeId: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      select possibly_closed_at is not null as flagged from public.places where id = ${placeId}::uuid`);
    return (
      z
        .array(z.object({ flagged: z.boolean() }))
        .max(1)
        .parse([...rows])[0]?.flagged ?? false
    );
  }

  // ---- suggestions ---------------------------------------------------------

  /** Suggestions the caller filed in this tenant within the last `seconds`. */
  async suggestionsSince(tx: DatabaseTransaction, seconds: number): Promise<number> {
    const rows = await tx.execute(sql`
      select count(*)::int as n from public.place_edit_suggestions
      where suggester_member_id = public.current_member_id()
        and created_at > now() - make_interval(secs => ${seconds})`);
    return z
      .array(z.object({ n: z.number() }))
      .length(1)
      .parse([...rows])[0]!.n;
  }

  async suggest(
    tx: DatabaseTransaction,
    placeId: string,
    changes: SuggestionChanges,
    current: SuggestionChanges,
    note: string | null,
  ): Promise<string> {
    const rows = await tx.execute(sql`
      select public.suggest_place_edit(${placeId}::uuid, ${JSON.stringify(changes)}::jsonb,
                                       ${JSON.stringify(current)}::jsonb, ${note}) as id`);
    return z
      .array(z.object({ id: z.string() }))
      .length(1)
      .parse([...rows])[0]!.id;
  }

  async findSuggestion(
    tx: DatabaseTransaction,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<SuggestionRow | undefined> {
    const rows = await tx.execute(sql`
      select ${SUGGESTION_COLUMNS} from public.place_edit_suggestions s
      where s.id = ${id}::uuid ${options.forUpdate ? sql`for update` : sql``}`);
    return z
      .array(SUGGESTION_ROW)
      .max(1)
      .parse([...rows])[0];
  }

  /** Pending suggestions, oldest first, with the place's current values. */
  async suggestionQueue(
    tx: DatabaseTransaction,
    after: string | null,
    limit: number,
  ): Promise<SuggestionQueueRow[]> {
    const rows = await tx.execute(sql`
      select ${SUGGESTION_COLUMNS},
             p.name_bn as place_name_bn, p.name_en as place_name_en,
             st_y(p.location::geometry) as place_lat, st_x(p.location::geometry) as place_lng,
             p.phones as place_phones, public.place_hours_json(p.id) as place_hours
      from public.place_edit_suggestions s
      join public.places p on p.id = s.place_id
      where s.status_code = 'pending' and p.deleted_at is null
        ${after ? sql`and s.id > ${after}::uuid` : sql``}
      order by s.id
      limit ${limit}`);
    return z.array(SUGGESTION_QUEUE_ROW).parse([...rows]);
  }

  async decideSuggestion(
    tx: DatabaseTransaction,
    id: string,
    decision: {
      status: 'approved' | 'rejected';
      userId: string;
      reasonCode: string;
      note: string | null;
    },
  ): Promise<void> {
    await tx.execute(sql`
      update public.place_edit_suggestions
      set status_code = ${decision.status}, decided_by_user_id = ${decision.userId}::uuid,
          decided_at = now(), decision_reason_code = ${decision.reasonCode},
          decision_note = ${decision.note}
      where id = ${id}::uuid`);
  }

  /**
   * A moderation_actions row about a place, with plain ids as evidence (as
   * report_place() and suggest_place_edit() write them).
   */
  async recordAction(
    tx: DatabaseTransaction,
    action: {
      placeId: string;
      actorUserId: string;
      actionCode: string;
      reasonCode: string;
      reasonText: string | null;
      evidenceIds: readonly string[];
    },
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.moderation_actions
        (place_id, actor_user_id, action_code, reason_code, reason_text, evidence_refs)
      values (${action.placeId}::uuid, ${action.actorUserId}::uuid, ${action.actionCode},
              ${action.reasonCode}, ${action.reasonText}, ${JSON.stringify(action.evidenceIds)}::jsonb)`);
  }
}
