import { staffAction, storeCan, type StoreAction, type StoreRole } from './store-access';
import { asStoreTier, catalogLimitKey, staffLimitKey } from './store-limits';
import { verificationBadge } from './store-page.service';

describe('who may do what to a store (ADR 054)', () => {
  const settings: StoreAction[] = [
    'edit_settings',
    'change_slug',
    'invite_manager',
    'invite_editor',
  ];

  it('an editor posts as the store and changes none of its settings or staff', () => {
    expect(storeCan('editor', 'post_as_store')).toBe(true);
    for (const action of [
      ...settings,
      'remove_manager',
      'remove_editor',
      'view_staff',
    ] as StoreAction[]) {
      expect(storeCan('editor', action)).toBe(false);
    }
  });

  it('a manager runs the store but not its slug or its managers', () => {
    expect(storeCan('manager', 'edit_settings')).toBe(true);
    expect(storeCan('manager', 'invite_editor')).toBe(true);
    expect(storeCan('manager', 'remove_editor')).toBe(true);
    expect(storeCan('manager', 'post_as_store')).toBe(true);
    expect(storeCan('manager', 'change_slug')).toBe(false);
    expect(storeCan('manager', 'invite_manager')).toBe(false);
    expect(storeCan('manager', 'remove_manager')).toBe(false);
  });

  it('the owner may do everything; a stranger nothing', () => {
    const all: StoreAction[] = [
      ...settings,
      'remove_manager',
      'remove_editor',
      'view_staff',
      'post_as_store',
    ];
    for (const action of all) {
      expect(storeCan('owner', action)).toBe(true);
      expect(storeCan(null, action)).toBe(false);
    }
  });

  it('names the staff action for a role', () => {
    const cases: [StoreRole | null, 'invite' | 'remove', 'manager' | 'editor', boolean][] = [
      ['manager', 'invite', 'editor', true],
      ['manager', 'invite', 'manager', false],
      ['owner', 'remove', 'manager', true],
    ];
    for (const [role, kind, staffRole, allowed] of cases) {
      expect(storeCan(role, staffAction(kind, staffRole))).toBe(allowed);
    }
  });
});

describe('store tiers', () => {
  it('reads limits from the tier’s settings; unknown tiers are basic', () => {
    expect(staffLimitKey('basic')).toBe('store_staff_max_basic');
    expect(catalogLimitKey('premium')).toBe('store_catalog_max_premium');
    expect(asStoreTier('pro')).toBe('pro');
    expect(asStoreTier('gold')).toBe('basic');
  });
});

describe('the verification badge', () => {
  it('is business for a verified store, else the owner’s seller level', () => {
    expect(verificationBadge(true, 'phone')).toBe('business');
    expect(verificationBadge(false, 'identity')).toBe('identity');
    expect(verificationBadge(false, null)).toBe('none');
    expect(verificationBadge(false, 'something_new')).toBe('none');
  });
});
