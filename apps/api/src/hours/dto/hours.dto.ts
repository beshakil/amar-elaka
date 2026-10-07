import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';
import { openStateSchema } from '../open-state';

// settings-exempt: ISO weekdays, Monday = 1 … Sunday = 7.
const ISO_DAYS = 7;
// settings-exempt: abuse bound on input size; the per-day limit is hours_ranges_per_day_max.
const MAX_WEEKLY_RANGES = 84;
// settings-exempt: abuse bound on input size; the real limit is hours_special_days_max.
const MAX_SPECIAL_DAYS = 366;
// settings-exempt: abuse bound on a free-text note's length.
const NOTE_MAX_CHARS = 200;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time like 09:30');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-12-16');

/** One opening range; `closes` at or before `opens` runs past midnight. */
export const rangeSchema = z.object({ opens: clock, closes: clock }).strict();

/**
 * A weekly schedule: any number of ranges per day (split shifts — closed for
 * Jummah or the afternoon). A day without an entry is closed.
 */
export const weeklyHoursSchema = z
  .array(rangeSchema.extend({ day: z.number().int().min(1).max(ISO_DAYS) }).strict())
  .max(MAX_WEEKLY_RANGES);
export type WeeklyHoursInput = z.infer<typeof weeklyHoursSchema>;

export const storeWeeklySchema = z.object({ weekly: weeklyHoursSchema }).strict();
export type StoreWeeklyInput = z.infer<typeof storeWeeklySchema>;
export class StoreWeeklyDto extends createZodDto(storeWeeklySchema) {}

/** A holiday (closed) or a day with its own hours. Replaces the weekly schedule that date. */
export const specialDaySchema = z
  .object({
    date: isoDate,
    closed: z.boolean(),
    ranges: z.array(rangeSchema).default([]),
    note: z.string().trim().min(1).max(NOTE_MAX_CHARS).optional(),
  })
  .strict()
  .refine((d) => d.closed === (d.ranges.length === 0), {
    message: 'A closed day has no ranges; an open one has at least one.',
    path: ['ranges'],
  });
export type SpecialDayInput = z.infer<typeof specialDaySchema>;

/** The whole list of upcoming special days (today on); past ones are kept as they were. */
export const specialDaysSchema = z
  .object({ days: z.array(specialDaySchema).max(MAX_SPECIAL_DAYS) })
  .strict();
export type SpecialDaysInput = z.infer<typeof specialDaysSchema>;
export class SpecialDaysDto extends createZodDto(specialDaysSchema) {}

/** "Closed today": true closes it until the next local midnight; false opens it again. */
export const closedTodaySchema = z.object({ closed: z.boolean() }).strict();
export type ClosedTodayInput = z.infer<typeof closedTodaySchema>;
export class ClosedTodayDto extends createZodDto(closedTodaySchema) {}

export const entityIdParamSchema = z.object({ id: z.string().uuid() }).strict();
export class EntityIdParamDto extends createZodDto(entityIdParamSchema) {}

// ---- responses ---------------------------------------------------------------

export const specialDayViewSchema = z.object({
  date: z.string(),
  closed: z.boolean(),
  ranges: z.array(z.object({ opens: z.string(), closes: z.string(), closesNextDay: z.boolean() })),
  note: z.string().nullable(),
});
export type SpecialDayView = z.infer<typeof specialDayViewSchema>;

export const hoursViewSchema = z.object({
  weekly: z.array(
    z.object({
      day: z.number(),
      opens: z.string(),
      closes: z.string(),
      closesNextDay: z.boolean(),
    }),
  ),
  /** A store with no hours of its own shows its place's (its map pin). */
  usesPlaceHours: z.boolean(),
  specialDays: z.array(specialDayViewSchema),
  /** "Closed today" until this instant; null when not set. */
  closedUntil: z.string().nullable(),
  openState: openStateSchema.nullable(),
});
export type HoursView = z.infer<typeof hoursViewSchema>;
export class HoursViewDto extends createZodDto(hoursViewSchema) {}

export const closedTodayResultSchema = z.object({
  closedUntil: z.string().nullable(),
  openState: openStateSchema.nullable(),
});
export type ClosedTodayResult = z.infer<typeof closedTodayResultSchema>;
export class ClosedTodayResultDto extends createZodDto(closedTodayResultSchema) {}
