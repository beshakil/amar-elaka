import { describe, expect, it } from 'vitest';
import type { BanNotice } from '../api/schemas';
import { noticeLines } from './notice';

const notice = (over: Partial<BanNotice> = {}): BanNotice => ({
  kind: 'area',
  id: 'b1',
  reference: 'BN-0A1B2C3D4E',
  severity: 'banned',
  reasonCode: 'scam',
  areaName: { bn: 'মিরপুর', en: 'Mirpur' },
  startsAt: '2026-10-12T10:00:00.000Z',
  expiresAt: '2026-11-12T10:00:00.000Z',
  permanent: false,
  appeal: null,
  canAppeal: true,
  ...over,
});

describe('a ban notice', () => {
  it('says why, how long, which area and the reference', () => {
    expect(noticeLines(notice())).toEqual({
      severityKey: 'severity.banned',
      reasonKey: 'reason.scam',
      until: '2026-11-12T10:00:00.000Z',
      area: 'মিরপুর',
      reference: 'BN-0A1B2C3D4E',
      appeal: null,
      canAppeal: true,
    });
  });

  it('a global entry names no area; a permanent one no end', () => {
    const lines = noticeLines(
      notice({
        kind: 'platform',
        areaName: null,
        permanent: true,
        expiresAt: null,
        reasonCode: 'advance_payment_scam',
      }),
    );
    expect(lines).toMatchObject({ area: null, until: null, reasonKey: 'reason.scam' });
  });

  it('an escalated appeal still reads "waiting"; an unknown reason reads "other"', () => {
    const lines = noticeLines(
      notice({
        reasonCode: 'something_new',
        appeal: { id: 'a1', reference: 'AP-1', status: 'escalated' },
        canAppeal: false,
      }),
    );
    expect(lines.appeal).toEqual({ reference: 'AP-1', statusKey: 'appealStatus.waiting' });
    expect(lines.reasonKey).toBe('reason.other');
  });
});
