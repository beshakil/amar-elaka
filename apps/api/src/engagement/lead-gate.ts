import { Inject, Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { ContactLimitReachedException } from './engagement.exceptions';
import { ENGAGEMENT_STORE, type EngagementStore } from './engagement.store';

// settings-exempt: unit conversions (the limits themselves are settings)
const SECONDS_PER_MINUTE = 60;
// settings-exempt: see above; "per day" is a rolling 24 hours
const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * THE gate in front of every number that leaves the API (ADR 036): a lead is
 * recorded unless this viewer revealed this target on this channel within
 * lead_dedupe_minutes (a double tap isn't two leads), and new reveals are
 * capped per viewer by contact_reveals_per_user_per_day, so no endpoint can
 * be walked to harvest numbers. Posts, stores, the WhatsApp catalog and the
 * blood donor / request contacts (ADR 064) all pass through here.
 */
@Injectable()
export class LeadGate {
  constructor(
    private readonly settings: SettingsService,
    @Inject(ENGAGEMENT_STORE) private readonly store: EngagementStore,
  ) {}

  /**
   * Runs `write` (the lead's row) unless this is a repeat tap. Anything
   * refused or failed after claiming gives the claim and the count back, so a
   * failed request never costs the viewer a reveal. Returns whether `write` ran.
   */
  async count(
    key: string,
    channel: string,
    /** The post id, or `store:<id>`, `donor:<id>`, `blood_request:<id>`… */
    target: string,
    write: () => Promise<void>,
  ): Promise<boolean> {
    const [dedupeMinutes, max] = await Promise.all([
      this.settings.get('lead_dedupe_minutes'),
      this.settings.get('contact_reveals_per_user_per_day'),
    ]);
    const claim = `lead:${target}:${channel}:${key}`;
    if (
      dedupeMinutes > 0 &&
      !(await this.store.claimOnce(claim, dedupeMinutes * SECONDS_PER_MINUTE))
    ) {
      return false; // a repeat tap: same lead, no new row
    }
    const rate = `contact-rate:${key}`;
    const used = await this.store.count(rate, SECONDS_PER_DAY);
    try {
      if (used > max) throw new ContactLimitReachedException(max);
      await write();
      return true;
    } catch (error) {
      await this.store.uncount(rate);
      if (dedupeMinutes > 0) await this.store.release(claim);
      throw error;
    }
  }
}
