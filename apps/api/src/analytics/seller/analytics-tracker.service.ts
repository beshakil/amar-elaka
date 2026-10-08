import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { SettingsService } from '../../settings/settings.service';
import { localDay } from './analytics-day';
import {
  ANALYTICS_COUNTER_STORE,
  type AnalyticsCounterStore,
  type CounterTtls,
  type EntityRef,
  type SketchOwner,
} from './analytics-counter.store';
import { contactField, type ContactChannel } from './analytics-metrics';

// settings-exempt: unit conversions (the retentions themselves are settings)
const SECONDS_PER_DAY = 24 * 60 * 60;
// settings-exempt: see above
const SECONDS_PER_HOUR = 60 * 60;

/**
 * Records what sellers see on their analytics screen (ADR 055), as it
 * happens: one Redis round trip per event, today's numbers live, the nightly
 * rollup making history of them. Fire-and-forget: a counting failure is
 * logged, never a failed request (the event itself — a view, a lead — is
 * what matters to the buyer).
 */
@Injectable()
export class AnalyticsTracker {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(ANALYTICS_COUNTER_STORE) private readonly store: AnalyticsCounterStore,
    private readonly settings: SettingsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnalyticsTracker.name);
  }

  /** A counted (deduped) view of a post: its views, and its distinct viewers for the post, its store and its author. */
  view(event: {
    tenantId: string;
    postId: string;
    storeId: string | null;
    authorMemberId: string | null;
    visitor: string;
  }): void {
    this.safe(async (ttls, day) => {
      const post: EntityRef = { tenantId: event.tenantId, type: 'post', id: event.postId };
      await this.store.increment(day, post, 'views', 1, ttls);
      await this.store.addUnique(
        day,
        'viewers',
        this.owners(event.postId, event.storeId, event.authorMemberId),
        event.visitor,
        ttls,
        event.storeId ? [{ tenantId: event.tenantId, type: 'store', id: event.storeId }] : [],
      );
    });
  }

  /** A store page view, once per visitor per view_dedupe_hours (as post views). */
  storePageView(event: { tenantId: string; storeId: string; visitor: string }): void {
    this.safe(async (ttls, day) => {
      const hours = await this.settings.get('view_dedupe_hours');
      if (
        !(await this.store.claimOnce(
          `store:${event.storeId}:${event.visitor}`,
          hours * SECONDS_PER_HOUR,
        ))
      ) {
        return;
      }
      const store: EntityRef = { tenantId: event.tenantId, type: 'store', id: event.storeId };
      await this.store.increment(day, store, 'views', 1, ttls);
      await this.store.addUnique(
        day,
        'viewers',
        [{ type: 'store', id: event.storeId }],
        event.visitor,
        ttls,
      );
    });
  }

  /** A new lead (ContactService records the lead_events row; this is today's live count). */
  contact(event: {
    tenantId: string;
    postId: string | null;
    storeId: string | null;
    authorMemberId: string | null;
    channel: ContactChannel;
    visitor: string;
  }): void {
    this.safe(async (ttls, day) => {
      const target: EntityRef | null = event.postId
        ? { tenantId: event.tenantId, type: 'post', id: event.postId }
        : event.storeId
          ? { tenantId: event.tenantId, type: 'store', id: event.storeId }
          : null;
      if (!target) return;
      await this.store.increment(day, target, contactField(event.channel), 1, ttls);
      await this.store.addUnique(
        day,
        'contacters',
        this.owners(event.postId, event.storeId, event.authorMemberId),
        event.visitor,
        ttls,
        event.storeId ? [{ tenantId: event.tenantId, type: 'store', id: event.storeId }] : [],
      );
    });
  }

  save(entity: EntityRef): void {
    this.safe((ttls, day) => this.store.increment(day, entity, 'saves', 1, ttls));
  }

  /** Someone opened a shared link to the post (GET /s/:code). */
  shareOpen(tenantId: string, postId: string): void {
    this.safe((ttls, day) =>
      this.store.increment(day, { tenantId, type: 'post', id: postId }, 'share_opens', 1, ttls),
    );
  }

  /** A page of search results showed these posts and stores. */
  searchAppearances(hits: readonly { type: string; id: string; tenantId: string }[]): void {
    const entities = hits.flatMap((hit): EntityRef[] =>
      hit.type === 'posts' || hit.type === 'stores'
        ? [{ tenantId: hit.tenantId, type: hit.type === 'posts' ? 'post' : 'store', id: hit.id }]
        : [],
    );
    if (entities.length === 0) return;
    this.safe((ttls, day) => this.store.incrementMany(day, entities, 'search_appearances', ttls));
  }

  /** A pin tapped on the map (its preview opened). */
  mapTap(entity: EntityRef): void {
    this.safe((ttls, day) => this.store.increment(day, entity, 'map_taps', 1, ttls));
  }

  private owners(
    postId: string | null,
    storeId: string | null,
    memberId: string | null,
  ): SketchOwner[] {
    return [
      ...(postId ? [{ type: 'post' as const, id: postId }] : []),
      ...(storeId ? [{ type: 'store' as const, id: storeId }] : []),
      ...(memberId ? [{ type: 'member' as const, id: memberId }] : []),
    ];
  }

  /** Resolves once every counter recorded so far has landed (tests, graceful shutdown). */
  async settle(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  private safe(work: (ttls: CounterTtls, day: string) => Promise<void>): void {
    const task = (async () => {
      const [counters, uniques] = await Promise.all([
        this.settings.get('analytics_counter_retention_days'),
        this.settings.get('analytics_unique_retention_days'),
      ]);
      await work(
        { counters: counters * SECONDS_PER_DAY, uniques: uniques * SECONDS_PER_DAY },
        localDay(new Date()),
      );
    })().catch((error: unknown) => {
      this.logger.warn({ err: error }, 'analytics counter not recorded');
    });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }
}
