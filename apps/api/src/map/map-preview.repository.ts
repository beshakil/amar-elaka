import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../database/database.client';
import type { MapLayer } from './map-features.dto';

const previewRow = z.object({
  name_bn: z.string().nullable(),
  name_en: z.string().nullable(),
  phones: z.array(z.string()).nullable(),
  address: z.string().nullable(),
  cover_thumbhash: z.string().nullable(),
  cover_variants: z.unknown(),
  /** posts only: the title, split into name_bn/name_en by script in the service. */
  title: z.string().nullable(),
});
export type PreviewRow = z.infer<typeof previewRow>;

/** One cover per owner: the first public, ready image attached to it. */
const firstImage = (owner: 'post_id' | 'place_id', ownerAlias: string) =>
  sql.raw(`
    left join lateral (
      select m.thumbhash, m.variants
      from public.media_attachments a
      join public.media_assets m on m.tenant_id = a.tenant_id and m.id = a.media_asset_id
      where a.tenant_id = ${ownerAlias}.tenant_id and a.${owner} = ${ownerAlias}.id
        and m.status_code = 'ready' and m.visibility_code = 'public'
      order by a.sort_order
      limit 1
    ) cover on true`);

/**
 * The map preview's reads (ADR 046). Called inside the owning tenant's
 * anonymous context, so every row is what that table's public-read policy
 * shows (a hidden post or a pending place simply isn't found).
 */
@Injectable()
export class MapPreviewRepository {
  async preview(tx: DatabaseTransaction, layer: MapLayer, id: string): Promise<PreviewRow | null> {
    switch (layer) {
      case 'posts':
        return this.one(
          tx,
          sql`
          select null::text as name_bn, null::text as name_en, null::text[] as phones,
                 coalesce(l.name_bn, ga.name_bn, l.name_en, ga.name_en) as address,
                 cover.thumbhash as cover_thumbhash, cover.variants as cover_variants, p.title
          from public.posts p
          left join public.localities l on l.tenant_id = p.tenant_id and l.id = p.locality_id
          left join public.geo_areas ga on ga.id = p.geo_area_id
          ${firstImage('post_id', 'p')}
          where p.id = ${id} and public.post_is_listed(p.status_code, p.deleted_at, p.scrubbed_at, p.hidden_by_owner, p.store_hidden, p.expires_at, now())`,
        );
      case 'stores':
        return this.one(
          tx,
          sql`
          -- A store's numbers leave only through POST /stores/:id/contact (a lead).
          select s.name_bn, s.name_en, null::text[] as phones,
                 s.address_text as address,
                 m.thumbhash as cover_thumbhash, m.variants as cover_variants, null::text as title
          from public.stores s
          left join public.media_assets m
            on m.tenant_id = s.tenant_id and m.id = coalesce(s.cover_media_id, s.logo_media_id)
           and m.status_code = 'ready' and m.visibility_code = 'public'
          where s.id = ${id} and s.status_code = 'active' and s.deleted_at is null`,
        );
      case 'places':
      case 'landmarks':
        return this.place(tx, id);
      case 'info':
        // An info feature is an emergency service, a bus stop or an info place (banks…).
        return (
          (await this.one(
            tx,
            sql`
            select e.name_bn, e.name_en, e.phones, e.address_text as address,
                   null::text as cover_thumbhash, null::jsonb as cover_variants, null::text as title
            from public.emergency_contacts e
            where e.id = ${id} and e.is_active and e.deleted_at is null`,
          )) ??
          (await this.one(
            tx,
            sql`
            select st.name_bn, st.name_en, null::text[] as phones, null::text as address,
                   null::text as cover_thumbhash, null::jsonb as cover_variants, null::text as title
            from public.transport_route_stops st
            where st.id = ${id}`,
          )) ??
          (await this.place(tx, id))
        );
    }
  }

  private place(tx: DatabaseTransaction, id: string): Promise<PreviewRow | null> {
    return this.one(
      tx,
      sql`
      select pl.name_bn, pl.name_en, pl.phones, pl.address_text as address,
             cover.thumbhash as cover_thumbhash, cover.variants as cover_variants, null::text as title
      from public.places pl
      ${firstImage('place_id', 'pl')}
      where pl.id = ${id} and pl.status_code in ('published', 'temporarily_closed')
        and pl.deleted_at is null`,
    );
  }

  private async one(
    tx: DatabaseTransaction,
    query: ReturnType<typeof sql>,
  ): Promise<PreviewRow | null> {
    const rows = z.array(previewRow).parse([...(await tx.execute(query))]);
    return rows[0] ?? null;
  }
}
