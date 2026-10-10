import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DatabaseTransaction } from '../../database/database.client';
import type { ChannelCode } from '../notification-channel';
import { NotificationsRepository } from '../notifications.repository';
import { renderTemplate, type Locale, type TemplateVars } from './template-renderer';

export interface RenderedText {
  title: string | null;
  body: string;
}

/**
 * A notification's words (ADR 059): the active notification_templates row
 * for the type, channel, locale and variant (falling back to in_app, then
 * Bengali — see NotificationsRepository.template), filled in by
 * renderTemplate. The variables are the sender's params plus:
 *  - `reason`: the moderator's own words, else the reason code's label
 *    (moderation_reasons.label_bn / label_en);
 *  - `count`: how many events a collapsed notification holds.
 * A type without a template renders to undefined (logged): the inbox row
 * still carries the type and params for the client.
 */
@Injectable()
export class NotificationTexts {
  constructor(
    private readonly repo: NotificationsRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationTexts.name);
  }

  async render(
    tx: DatabaseTransaction,
    input: {
      type: string;
      channel: ChannelCode;
      locale: Locale;
      params: Record<string, unknown>;
      count: number;
    },
  ): Promise<RenderedText | undefined> {
    const variant = input.count > 1 ? 'collapsed' : 'single';
    const template = await this.repo.template(tx, input.type, input.channel, input.locale, variant);
    if (!template) {
      this.logger.error({ type: input.type, channel: input.channel }, 'no notification template');
      return undefined;
    }
    const vars = await this.variables(tx, input.params, input.locale, input.count);
    return {
      title: template.title === null ? null : renderTemplate(template.title, vars, input.locale),
      body: renderTemplate(template.body, vars, input.locale),
    };
  }

  private async variables(
    tx: DatabaseTransaction,
    params: Record<string, unknown>,
    locale: Locale,
    count: number,
  ): Promise<TemplateVars> {
    const vars: TemplateVars = { count: String(count) };
    for (const [key, value] of Object.entries(params)) {
      vars[key] =
        value === null || value === undefined
          ? null
          : typeof value === 'string'
            ? value
            : typeof value === 'number' || typeof value === 'boolean'
              ? String(value)
              : JSON.stringify(value);
    }
    const reasonText = vars.reasonText;
    const reasonCode = vars.reasonCode;
    vars.reason =
      reasonText && reasonText.trim() !== ''
        ? reasonText
        : reasonCode
          ? await this.repo.reasonLabel(tx, reasonCode, locale)
          : null;
    return vars;
  }
}
