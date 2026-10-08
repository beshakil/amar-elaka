import { z } from 'zod';
import { createZodDto } from '../../../common/pipes/zod-dto';

/** `7d`, `30d`, `90d` …: the allowed lengths are analytics_periods_days; the service checks. */
export const analyticsQuerySchema = z
  .object({
    period: z
      .string()
      .regex(/^\d{1,3}d$/, 'a period like 30d')
      .optional(),
  })
  .strict();
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export class AnalyticsQueryDto extends createZodDto(analyticsQuerySchema) {}

const metricsSchema = z.object({
  views: z.number(),
  /** Distinct people who saw (deduped per viewer across the whole period). */
  uniqueViewers: z.number(),
  contacts: z.object({
    total: z.number(),
    call: z.number(),
    whatsapp: z.number(),
    sms: z.number(),
    /** Chat arrives in week 11; 0 until then. */
    chat: z.number(),
  }),
  /** Distinct people who contacted. */
  uniqueContacters: z.number(),
  saves: z.number(),
  /** Opens of a shared link (/s/:code). */
  shares: z.number(),
  /** How often a search results page showed it. */
  searchAppearances: z.number(),
  /** How often its pin was tapped on the map. */
  mapTaps: z.number(),
  /** contacts ÷ views, 0 when there were no views. */
  conversionRate: z.number(),
});
export type AnalyticsMetrics = z.infer<typeof metricsSchema>;

const change = z.number().nullable();

export const sellerAnalyticsSchema = z.object({
  scope: z.enum(['store', 'posts']),
  period: z.object({
    days: z.number(),
    from: z.string(),
    to: z.string(),
    previousFrom: z.string(),
    previousTo: z.string(),
    /** The lengths a client may ask for (analytics_periods_days). */
    available: z.array(z.number()),
  }),
  /** The headline: "গত ৩০ দিনে ১,২৪০ জন আপনার পোস্ট দেখেছেন, ৪৭ জন যোগাযোগ করেছেন।" */
  summary: z.object({ bn: z.string(), en: z.string() }),
  totals: metricsSchema,
  previous: metricsSchema,
  /** Percent change against the previous period; null when it had none. */
  trend: z.object({
    views: change,
    uniqueViewers: change,
    contacts: change,
    uniqueContacters: change,
    saves: change,
    shares: change,
    searchAppearances: change,
    mapTaps: change,
    conversionRate: change,
  }),
  /** One point per day of the period, oldest first. */
  daily: z.array(z.object({ date: z.string(), views: z.number(), contacts: z.number() })),
  topPosts: z.array(
    z.object({
      postId: z.string(),
      tenantId: z.string(),
      title: z.string(),
      status: z.string(),
      metrics: metricsSchema,
    }),
  ),
  /** The searches that led people to these posts (only queries enough different people made). */
  topQueries: z.array(z.object({ query: z.string(), searchers: z.number(), clicks: z.number() })),
  generatedAt: z.string(),
});
export type SellerAnalytics = z.infer<typeof sellerAnalyticsSchema>;
export class SellerAnalyticsDto extends createZodDto(sellerAnalyticsSchema) {}
