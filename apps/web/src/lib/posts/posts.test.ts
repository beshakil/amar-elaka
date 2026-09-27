import { describe, expect, it } from 'vitest';
import type { CategoryFieldSchema } from '@amar-elaka/dynamic-form';
import { safeNext } from '../auth/session';
import { emptyDraft, toE164 } from './draft';
import { cardFacts } from './display';
import { clearDraft, draftKey, loadDraft, saveDraft } from './draft-storage';
import { moderationReasonKey, postErrorMessage } from './errors';
import { actionsFor, tabCount, tabQuery } from './my-posts';
import { postRequestBody, sectionIssues } from './request-body';

const schema: CategoryFieldSchema = {
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      condition: { 'x-field-type': 'select', type: 'string', enum: ['new', 'used'] },
      price: {
        'x-field-type': 'money',
        type: 'string',
        'x-money-min': '100.00',
        'x-money-max': '10000000.00',
      },
    },
    required: ['condition', 'price'],
  },
  uiSchema: {
    order: ['condition', 'price'],
    card: ['condition'],
    labels: { condition: { bn: 'অবস্থা', en: 'Condition' }, price: { bn: 'দাম', en: 'Price' } },
    options: { condition: { new: { bn: 'নতুন', en: 'New' }, used: { bn: 'ব্যবহৃত', en: 'Used' } } },
  },
  filterableFields: [],
  searchableFields: [],
} as unknown as CategoryFieldSchema;

const ready = () => ({
  ...emptyDraft({ name: 'রহিম', phone: '+8801712345678' }, () => 'k1'),
  categoryId: 'c1',
  title: '  আইফোন ১৩ বিক্রি ',
  formState: { condition: 'used', price: '৬৫,০০০' },
  location: { lat: 23.8, lng: 90.36 },
});

describe('draft', () => {
  it('starts from the profile: name, and the number as a Bangladeshi types it', () => {
    const draft = emptyDraft({ name: 'রহিম', phone: '+8801712345678' }, () => 'abc');
    expect(draft).toMatchObject({
      contactName: 'রহিম',
      contactPhone: '01712345678',
      idempotencyKey: 'post-abc',
    });
  });

  it('normalizes a number in either script to E.164, and refuses a wrong one', () => {
    expect(toE164('০১৮১২-৩৪৫৬৭৮')).toBe('+8801812345678');
    expect(toE164('+8801712345678')).toBe('+8801712345678');
    expect(toE164('01212345678')).toBeNull();
    expect(toE164('12345')).toBeNull();
  });
});

describe('request body', () => {
  it('is API-shaped: trimmed title, parsed money, E.164 phone, photos in order', () => {
    const draft = { ...ready(), existingMedia: [{ id: 'm-old', thumbUrl: null }] };
    const body = postRequestBody(draft, schema, ['m-new'], { isEdit: false });
    expect(body).toEqual({
      categoryId: 'c1',
      title: 'আইফোন ১৩ বিক্রি',
      fields: { condition: 'used', price: '65000.00' },
      location: { lat: 23.8, lng: 90.36 },
      mediaIds: ['m-old', 'm-new'],
      showPhone: true,
      allowChat: true,
      showWhatsapp: false,
      contactName: 'রহিম',
      contactPhone: '+8801712345678',
    });
  });

  it('an edit clears an emptied description; WhatsApp needs the phone shown', () => {
    const draft = { ...ready(), showPhone: false, showWhatsapp: true };
    const body = postRequestBody(draft, schema, [], { isEdit: true });
    expect(body.description).toBeNull();
    expect(body.showWhatsapp).toBe(false);
  });

  it('names what each section still needs', () => {
    expect(sectionIssues(ready())).toEqual([]);
    const empty = {
      ...emptyDraft({ name: '', phone: '' }, () => 'k'),
      showPhone: false,
      allowChat: false,
    };
    expect(sectionIssues(empty)).toEqual([
      'category',
      'title',
      'location',
      'contactName',
      'unreachable',
    ]);
    expect(sectionIssues({ ...ready(), contactPhone: '০১২৩' })).toEqual(['contactPhone']);
  });
});

describe('card facts', () => {
  it('shows the price grouped in Bengali and the card fields by label', () => {
    expect(
      cardFacts(schema, { condition: 'used', price: '65000.00' }, 'bn', { yes: 'হ্যাঁ', no: 'না' }),
    ).toEqual({
      price: '৳ ৬৫,০০০',
      attributes: ['অবস্থা ব্যবহৃত'],
    });
  });
});

describe('draft storage', () => {
  class MemoryStorage {
    data = new Map<string, string>();
    getItem = (k: string) => this.data.get(k) ?? null;
    setItem = (k: string, v: string) => void this.data.set(k, v);
    removeItem = (k: string) => void this.data.delete(k);
  }

  it('round-trips a draft per area and post, and ignores junk', () => {
    const storage = new MemoryStorage() as unknown as Storage;
    const key = draftKey('t1', null);
    expect(key).toBe('ae-post-draft:t1:new');
    saveDraft(key, ready(), storage);
    expect(loadDraft(key, storage)?.title).toBe('  আইফোন ১৩ বিক্রি ');
    storage.setItem(key, '{"not":"a draft"}');
    expect(loadDraft(key, storage)).toBeNull();
    clearDraft(key, storage);
    expect(loadDraft(key, storage)).toBeNull();
  });

  it('never throws when storage does', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(loadDraft('k', broken)).toBeNull();
    expect(() => saveDraft('k', ready(), broken)).not.toThrow();
    expect(() => clearDraft('k', broken)).not.toThrow();
  });
});

describe('error messages', () => {
  const date = () => '১৭ অক্টোবর';
  it('uses the details: which limit, which field, when', () => {
    expect(
      postErrorMessage({ code: 'POST_LIMIT_REACHED', details: { limit: 'daily', max: 10 } }, date),
    ).toEqual({
      key: 'limitDaily',
      values: { max: '১০' },
    });
    expect(
      postErrorMessage(
        { code: 'POST_TEXT_TOO_LONG', details: { field: 'description', max: 5000 } },
        date,
      ).key,
    ).toBe('descriptionTooLong');
    expect(
      postErrorMessage(
        { code: 'POST_RENEW_TOO_EARLY', details: { renewableFrom: '2026-10-17T00:00:00Z' } },
        date,
      ),
    ).toEqual({
      key: 'renewTooEarly',
      values: { date: '১৭ অক্টোবর' },
    });
    expect(
      postErrorMessage(
        { code: 'VALIDATION_FAILED', details: [{ path: 'contactPhone', message: 'x' }] },
        date,
      ).key,
    ).toBe('contactPhone');
  });

  it('an unknown code names itself; a 5xx says it is ours', () => {
    expect(postErrorMessage({ code: 'NEW_THING', status: 400 }, date)).toEqual({
      key: 'unknown',
      values: { code: 'NEW_THING' },
    });
    expect(postErrorMessage({ code: 'NEW_THING', status: 503 }, date).key).toBe('server');
    expect(moderationReasonKey('csam')).toBe('illegal_content');
    expect(moderationReasonKey('whatever')).toBe('other');
  });
});

describe('my posts', () => {
  it('status tabs leave hidden posts out; rejected covers removed', () => {
    expect(tabQuery('live')).toEqual({ status: 'live', hidden: 'false' });
    expect(tabQuery('rejected')).toEqual({ status: 'rejected,removed', hidden: 'false' });
    expect(tabQuery('hidden')).toEqual({ hidden: 'true' });
    const counts = {
      draft: 0,
      pending: 1,
      live: 2,
      rejected: 1,
      sold: 3,
      expired: 0,
      removed: 2,
      hidden: 4,
    };
    expect(tabCount('rejected', counts)).toBe(3);
    expect(tabCount('hidden', counts)).toBe(4);
  });

  it('offers what each state allows; sold is never deleted', () => {
    expect(actionsFor({ status: 'live', hiddenByOwner: false })).toEqual([
      'edit',
      'markSold',
      'renew',
      'hide',
      'delete',
    ]);
    expect(actionsFor({ status: 'rejected', hiddenByOwner: false })).toEqual([
      'resubmit',
      'delete',
    ]);
    expect(actionsFor({ status: 'expired', hiddenByOwner: false })).toContain('repost');
    expect(actionsFor({ status: 'sold', hiddenByOwner: false })).not.toContain('delete');
    expect(actionsFor({ status: 'sold', hiddenByOwner: true })).toEqual(['unhide']);
  });
});

describe('safeNext', () => {
  it('follows only an in-app path', () => {
    expect(safeNext('/me/posts?tab=sold')).toBe('/me/posts?tab=sold');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext(undefined, '/me/posts')).toBe('/me/posts');
  });
});
