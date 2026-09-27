import { Inject, Injectable } from '@nestjs/common';
import { UnauthenticatedException } from '../auth/exceptions/auth.exceptions';
import { sqlStateOf } from '../common/utils/sql-state';
import { TenantContext } from '../database/tenant-context';
import { TenantDb } from '../database/tenant-db';
import { PostOwnershipService } from '../posts/post-ownership.service';
import { PostNotFoundException } from '../posts/posts.exceptions';
import { SettingsService } from '../settings/settings.service';
import type { ReportInput, ReportResult } from './dto/engagement.dto';
import {
  ReportDetailsTooLongException,
  ReportLimitReachedException,
  ReportOwnPostException,
} from './engagement.exceptions';
import { EngagementRepository } from './engagement.repository';
import { ENGAGEMENT_STORE, type EngagementStore } from './engagement.store';

// settings-exempt: "per day" is a rolling 24 hours (the limit itself is a setting)
const SECONDS_PER_DAY = 24 * 60 * 60;
const NO_DATA_FOUND = 'P0002';
const OWN_POST = 'AE201';

/**
 * POST /posts/:id/report (ADR 036). report_post (0031) does the work in one
 * transaction, in the post's owning tenant as the reporter: the report (one
 * open report per reporter per post) and, when distinct reporters reach
 * auto_hide_report_threshold, the auto-hide — live → pending, a
 * moderation_actions row and a moderation queue item (source 'report').
 *
 * The answer never says how many others reported or whether the post was
 * hidden: a reporter mustn't learn how close a post is to the threshold.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly context: TenantContext,
    private readonly ownership: PostOwnershipService,
    private readonly repo: EngagementRepository,
    private readonly settings: SettingsService,
    @Inject(ENGAGEMENT_STORE) private readonly store: EngagementStore,
  ) {}

  async report(postId: string, input: ReportInput): Promise<ReportResult> {
    const userId = this.context.require().userId;
    if (!userId) throw new UnauthenticatedException();
    const [detailsMax, perDay] = await Promise.all([
      this.settings.get('report_details_max_length'),
      this.settings.get('reports_per_user_per_day'),
    ]);
    const text = input.text && input.text.length > 0 ? input.text : null;
    if (text !== null && [...text].length > detailsMax) {
      throw new ReportDetailsTooLongException(detailsMax);
    }
    const tenantId = await this.ownership.tenantOf(postId);
    if (!tenantId) throw new PostNotFoundException();

    const rate = `report-rate:${userId}`;
    if ((await this.store.count(rate, SECONDS_PER_DAY)) > perDay) {
      await this.store.uncount(rate);
      throw new ReportLimitReachedException(perDay);
    }
    try {
      // `ensure`: a report is filed by a member of the post's tenant (0010).
      const result = await this.ownership.inTenant(tenantId, 'ensure', () =>
        this.tenantDb.transaction((tx) => this.repo.reportPost(tx, postId, input.reasonCode, text)),
      );
      // Reporting the same post again returns the open report; no quota used.
      if (!result.created) await this.store.uncount(rate);
      return { reportId: result.reportId, created: result.created };
    } catch (error) {
      await this.store.uncount(rate);
      const state = sqlStateOf(error);
      if (state === NO_DATA_FOUND) throw new PostNotFoundException();
      if (state === OWN_POST) throw new ReportOwnPostException();
      throw error;
    }
  }
}
