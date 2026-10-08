/**
 * Who may do what to a store (ADR 054). The database enforces the same
 * lines (can_manage_store = owner or accepted manager for store rows and
 * hours; member_may_post_as_store for posts; store_invite_staff for
 * invites); this table gives the API a clear 403 before it gets there.
 */

export type StoreRole = 'owner' | 'manager' | 'editor';

export type StoreAction =
  /** Name, description, category, logo, banner, phone, address, location, hours, "closed today". */
  | 'edit_settings'
  /** The slug, once. */
  | 'change_slug'
  | 'invite_manager'
  | 'invite_editor'
  | 'remove_manager'
  | 'remove_editor'
  /** The staff list (with masked phones). */
  | 'view_staff'
  | 'post_as_store';

const ALLOWED: Record<StoreAction, readonly StoreRole[]> = {
  edit_settings: ['owner', 'manager'],
  change_slug: ['owner'],
  invite_manager: ['owner'],
  invite_editor: ['owner', 'manager'],
  remove_manager: ['owner'],
  remove_editor: ['owner', 'manager'],
  view_staff: ['owner', 'manager'],
  post_as_store: ['owner', 'manager', 'editor'],
};

export function storeCan(role: StoreRole | null, action: StoreAction): boolean {
  return role !== null && ALLOWED[action].includes(role);
}

/** The invite/remove action for a staff role. */
export function staffAction(kind: 'invite' | 'remove', role: 'manager' | 'editor'): StoreAction {
  return `${kind}_${role}`;
}
