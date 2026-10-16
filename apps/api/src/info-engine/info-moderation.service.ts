import { Injectable } from '@nestjs/common';
import type { DecisionInput, ModerationQueue } from './dto/info-engine.dto';
import { mapInfoEngineErrors } from './info-engine.exceptions';
import { InfoEngineRepository } from './info-engine.repository';
import { InfoMedia } from './info-media';
import { InfoNotifier } from './info-notifier';
import { InfoScope } from './info-scope';

/**
 * The engine's one moderation path (ADR 065): community notices and lost &
 * found waiting for review, or reported, in one queue; a decision is
 * decide_info_item() — the status and the moderation_actions row in one
 * transaction (rule 13) — closes the item's open reports and tells the
 * author. Approving a live, reported item keeps it (reports dismissed).
 */
@Injectable()
export class InfoModerationService {
  constructor(
    private readonly scope: InfoScope,
    private readonly repo: InfoEngineRepository,
    private readonly media: InfoMedia,
    private readonly notifier: InfoNotifier,
  ) {}

  async queue(): Promise<ModerationQueue> {
    this.scope.requireStaff();
    const limit = await this.scope.settings.get('info_page_size_max');
    const rows = await this.scope.read((tx) => this.repo.moderationQueue(tx, limit));
    const items: ModerationQueue['items'] = [];
    for (const r of rows) {
      const photos =
        r.kind === 'lost_found'
          ? await this.media.resolve(
              await this.scope.asSystem((tx) =>
                this.repo.attachments(tx, 'lost_found_item_id', r.id),
              ),
            )
          : [];
      items.push({
        kind: r.kind,
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        template: r.template_code,
        templateFields: r.template_fields,
        authorName: r.author_name,
        createdAt: r.created_at.toISOString(),
        photos,
        openReports: r.open_reports,
        status: r.status,
      });
    }
    return { items };
  }

  async decide(
    kind: 'notice' | 'lost_found',
    id: string,
    input: DecisionInput,
  ): Promise<{ status: string }> {
    this.scope.requireStaff();
    const { status, author } = await mapInfoEngineErrors(() =>
      this.scope.write(async (tx) => {
        // Read first: whether it was waiting decides whether its author hears of it.
        const before = await this.repo.infoAuthor(tx, kind, id);
        const next = await this.repo.decide(
          tx,
          kind,
          id,
          input.decision,
          input.reasonCode,
          input.reasonText ?? null,
        );
        await this.repo.closeReports(tx, kind, id, input.decision !== 'approve');
        return { status: next, author: before };
      }),
    );
    // The author hears a decision on their post — not "kept" after a report
    // (nothing changed for them), nor a moderator deciding their own.
    const kept = input.decision === 'approve' && author?.status_code !== 'pending_review';
    if (author && !kept && author.user_id !== this.scope.context.require().userId) {
      await this.notifier.decided(
        { userId: author.user_id, tenantId: this.scope.tenantId(), title: author.title },
        kind,
        id,
        input.decision,
        input.reasonText ?? null,
      );
    }
    return { status };
  }
}
