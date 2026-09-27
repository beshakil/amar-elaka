import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { TenantDb } from '../database/tenant-db';
import { SettingsService } from '../settings/settings.service';
import type { ShortLink } from './dto/engagement.dto';
import { ShortLinkNotFoundException } from './engagement.exceptions';
import { EngagementRepository } from './engagement.repository';

/** Lowercase letters and digits without the look-alikes (0/o, 1/l/i): easy to read out and type. */
export const SHORT_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
// settings-exempt: retry bound for a random-code collision, not a business rule
const CODE_ATTEMPTS = 5;

export function randomShortCode(length: number): string {
  let code = '';
  for (let i = 0; i < length; i++)
    code += SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)];
  return code;
}

/**
 * Share links (ADR 036): one short code per post, `https://<tenant>/s/<code>`.
 * The code is made the first time anyone needs it (detail, contact message),
 * by whoever can see the post (post_short_links' insert policy).
 */
@Injectable()
export class ShareService {
  private readonly baseTemplate: string;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly repo: EngagementRepository,
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) env: Pick<Env, 'APP_ROOT_DOMAIN' | 'SHARE_BASE_URL_TEMPLATE'>,
  ) {
    this.baseTemplate = env.SHARE_BASE_URL_TEMPLATE ?? `https://{slug}.${env.APP_ROOT_DOMAIN}`;
  }

  /** The post's code, creating it on first use. Call in the post's owning tenant context. */
  async codeFor(postId: string): Promise<string> {
    const existing = await this.tenantDb.transaction((tx) => this.repo.shortCodeOf(tx, postId), {
      accessMode: 'read only',
    });
    if (existing) return existing;

    const length = await this.settings.get('share_code_length');
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      const code = await this.tenantDb.transaction(async (tx) => {
        await this.repo.insertShortCode(tx, postId, randomShortCode(length));
        // Ours, or a concurrent request's for the same post; none = the random
        // code was taken by another post: try again.
        return this.repo.shortCodeOf(tx, postId);
      });
      if (code) return code;
    }
    throw new Error(`share code: no free code after ${CODE_ATTEMPTS} attempts`);
  }

  urlFor(tenantSlug: string, code: string): string {
    return `${this.baseTemplate.replace('{slug}', tenantSlug)}/s/${code}`;
  }

  /** GET /s/:code — which post, in which tenant, at which URL. Ids only: the post's own visibility applies when it's read. */
  async resolve(code: string): Promise<ShortLink> {
    const found = await this.tenantDb.transaction(
      async (tx) => {
        const link = await this.repo.resolveShortCode(tx, code);
        const slug = link && (await this.repo.tenantSlug(tx, link.tenantId));
        return link && slug ? { ...link, slug } : undefined;
      },
      { accessMode: 'read only' },
    );
    if (!found) throw new ShortLinkNotFoundException();
    return {
      code,
      postId: found.postId,
      tenantId: found.tenantId,
      tenantSlug: found.slug,
      url: this.urlFor(found.slug, code),
    };
  }
}
