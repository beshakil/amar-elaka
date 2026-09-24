export const REQUIRE_OWNERSHIP_KEY = 'requireOwnership';

export interface OwnershipSpec {
  /** Table to check against — a compile-time constant from the decorator call, never derived from request input. */
  table: string;
  /** Column on that table naming the owning tenant_members.id, e.g. author_member_id, owner_member_id. */
  ownerColumn: string;
  /** Route param carrying the row's id. */
  idParam: string;
}
