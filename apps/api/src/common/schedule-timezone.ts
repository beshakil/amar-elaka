/**
 * The zone every repeatable job's cron pattern is written in ("03:00" means
 * 03:00 in Bangladesh). One constant, not one per scheduler (month 2 review
 * §6): a job's daily window and the saved-search "per day" cap must agree.
 * Per-tenant dates (hours, date fields) use tenants.timezone instead.
 */
export const SCHEDULE_TIMEZONE = 'Asia/Dhaka';
