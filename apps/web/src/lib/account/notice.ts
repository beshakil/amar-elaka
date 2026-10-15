import type { BanNotice } from '../api/schemas';

/**
 * What a notice line says, as message keys and values (ADR 063): why (the
 * reason code — the internal text never reaches the person), how long, which
 * area (its name, never a person), the reference. Pure, so it's testable.
 */
export interface NoticeLines {
  severityKey: `severity.${BanNotice['severity']}`;
  reasonKey: string;
  until: string | null;
  area: string | null;
  reference: string;
  appeal: { reference: string; statusKey: string } | null;
  canAppeal: boolean;
}

const REASONS: Record<string, string> = {
  scam: 'scam',
  advance_payment_scam: 'scam',
  harassment: 'harassment',
  spam: 'spam',
  fake_listings: 'fakeListings',
  fake_product: 'fakeListings',
  payment_fraud: 'paymentFraud',
  identity_fraud: 'identityFraud',
  repeated_violations: 'repeated',
};

export function noticeLines(notice: BanNotice, locale: 'bn' | 'en' = 'bn'): NoticeLines {
  return {
    severityKey: `severity.${notice.severity}`,
    reasonKey: `reason.${REASONS[notice.reasonCode] ?? 'other'}`,
    until: notice.permanent ? null : notice.expiresAt,
    area:
      notice.kind === 'platform'
        ? null
        : ((locale === 'en' ? (notice.areaName?.en ?? notice.areaName?.bn) : notice.areaName?.bn) ??
          null),
    reference: notice.reference,
    appeal: notice.appeal
      ? {
          reference: notice.appeal.reference,
          // An escalation is internal: the person sees "waiting" until it is final.
          statusKey: `appealStatus.${['submitted', 'in_review', 'escalated'].includes(notice.appeal.status) ? 'waiting' : notice.appeal.status}`,
        }
      : null,
    canAppeal: notice.canAppeal,
  };
}
