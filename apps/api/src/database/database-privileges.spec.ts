import { describePrivilegeViolations, type RolePrivileges } from './database-privileges';

const safe: RolePrivileges = {
  role: 'ae_app',
  isSuperuser: false,
  canBypassRls: false,
  ownedTables: [],
  unprotectedTables: [],
};

describe('describePrivilegeViolations', () => {
  it('accepts an unprivileged, non-owning role', () => {
    expect(describePrivilegeViolations(safe)).toEqual([]);
  });

  it('rejects a superuser', () => {
    const [violation] = describePrivilegeViolations({
      ...safe,
      role: 'postgres',
      isSuperuser: true,
    });
    expect(violation).toContain('SUPERUSER');
  });

  it('rejects BYPASSRLS', () => {
    const [violation] = describePrivilegeViolations({
      ...safe,
      canBypassRls: true,
    });
    expect(violation).toContain('BYPASSRLS');
  });

  it('rejects a role that owns tables, because an owner can drop policies', () => {
    const [violation] = describePrivilegeViolations({
      ...safe,
      role: 'ae_migrator',
      ownedTables: ['tenant_members', 'tenants'],
    });
    expect(violation).toContain('owns 2 table(s)');
  });

  it('reports every problem at once', () => {
    expect(
      describePrivilegeViolations({
        ...safe,
        isSuperuser: true,
        canBypassRls: true,
        ownedTables: ['tenants'],
      }),
    ).toHaveLength(3);
  });

  it('does not treat tables without forced RLS as a startup failure', () => {
    expect(describePrivilegeViolations({ ...safe, unprotectedTables: ['posts'] })).toEqual([]);
  });
});
