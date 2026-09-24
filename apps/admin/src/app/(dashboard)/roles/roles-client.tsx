'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { z } from 'zod';
import { CrudPage } from '@/components/crud/crud-page';
import { dataTableColumnHelper } from '@/components/data-table/data-table';
import { ZodForm, TextField } from '@/components/form/zod-form';
import { Button } from '@/components/ui/button';
import type { ActionResult } from '@/lib/action-result';
import type { Role } from '@/lib/api/schemas';
import { createRole, deleteRole, updateRole, type RoleInput } from './actions';

const ACTIONS = ['read', 'write', 'approve', 'delete', '*'] as const;
type PermissionAction = (typeof ACTIONS)[number];
type RoleGrant = RoleInput['permissions'][number];

function isPermissionAction(action: string): action is PermissionAction {
  return (ACTIONS as readonly string[]).includes(action);
}

/** What the viewer's own grants allow on this page; decided on the server. */
export interface RolesAbilities {
  canWrite: boolean;
  canDelete: boolean;
}

// Built-in roles are templates shared by every tenant; the API refuses to
// change them (ROLE_BUILTIN_IMMUTABLE), so the page never offers to.
const isCustom = (role: Role): boolean => !role.isBuiltin;

/**
 * Roles on CrudPage: list, create, edit and delete — each shown only when the
 * viewer holds the grant for it, and edit/delete only on the tenant's own
 * custom roles.
 */
export function RolesClient({
  roles,
  modules,
  abilities,
}: {
  roles: Role[];
  modules: string[];
  abilities: RolesAbilities;
}) {
  const t = useTranslations('roles');

  const columns = useMemo(() => {
    const helper = dataTableColumnHelper<Role>();
    return helper.columns([
      helper.accessor('name', { header: t('name') }),
      helper.accessor('code', { header: t('code') }),
      helper.accessor((role) => (role.isBuiltin ? t('builtin') : t('custom')), {
        id: 'kind',
        header: t('kind'),
      }),
      helper.accessor((role) => role.permissions.length, {
        id: 'permissionCount',
        header: t('permissions'),
        cell: ({ getValue }) => t('permissionCount', { count: getValue() }),
      }),
    ]);
  }, [t]);

  return (
    <CrudPage
      title={t('title')}
      description={t('description')}
      columns={columns}
      rows={roles}
      getRowId={(role) => role.id}
      exportFilename="roles"
      canEdit={isCustom}
      canDelete={isCustom}
      {...(abilities.canWrite
        ? {
            renderCreateForm: (close: () => void) => (
              <RoleForm
                modules={modules}
                submit={createRole}
                successMessage={t('created')}
                onDone={close}
              />
            ),
            renderEditForm: (role: Role, close: () => void) => (
              <RoleForm
                modules={modules}
                initial={role}
                submit={(input) => updateRole(role.id, input)}
                successMessage={t('updated')}
                onDone={close}
              />
            ),
          }
        : {})}
      {...(abilities.canDelete ? { onDelete: (role: Role) => deleteRole(role.id) } : {})}
    />
  );
}

function RoleForm({
  modules,
  initial,
  submit,
  successMessage,
  onDone,
}: {
  modules: string[];
  initial?: Role;
  submit: (input: RoleInput) => Promise<ActionResult>;
  successMessage: string;
  onDone: () => void;
}) {
  const t = useTranslations('roles');
  const tError = useTranslations('apiError');
  const [permissions, setPermissions] = useState<RoleGrant[]>(() =>
    (initial?.permissions ?? []).flatMap((grant) =>
      isPermissionAction(grant.action) ? [{ module: grant.module, action: grant.action }] : [],
    ),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  // A role being edited may hold a module the built-in matrix never used.
  const moduleOptions = useMemo(
    () => [...new Set([...modules, ...permissions.map((grant) => grant.module)])],
    [modules, permissions],
  );

  // Messages come from the catalog so the form never shows an English zod default.
  const schema = useMemo(
    () => z.object({ name: z.string().trim().min(1, t('nameRequired')) }),
    [t],
  );

  function toggle(module: string, action: PermissionAction) {
    setPermissions((current) =>
      current.some((grant) => grant.module === module && grant.action === action)
        ? current.filter((grant) => !(grant.module === module && grant.action === action))
        : [...current, { module, action }],
    );
  }

  async function onSubmit(values: { name: string }) {
    if (permissions.length === 0) {
      toast.error(t('permissionsRequired'));
      return;
    }

    setIsSubmitting(true);
    const result = await submit({ name: values.name, permissions });
    setIsSubmitting(false);

    if (result.ok) {
      toast.success(successMessage);
      onDone();
    } else {
      toast.error(tError(result.messageKey));
    }
  }

  return (
    <ZodForm schema={schema} defaultValues={{ name: initial?.name ?? '' }} onSubmit={onSubmit}>
      <TextField name="name" label={t('nameLabel')} />

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('permissions')}</legend>
        <div className="max-h-72 space-y-3 overflow-y-auto rounded-md border border-border p-3">
          {moduleOptions.map((module) => (
            // One labelled group per module, so each action checkbox is
            // announced (and addressable) as "<module>: <action>".
            <fieldset key={module}>
              <legend className="text-sm font-medium">{module}</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {ACTIONS.map((action) => {
                  const checked = permissions.some(
                    (grant) => grant.module === module && grant.action === action,
                  );
                  return (
                    <label
                      key={action}
                      className={
                        checked
                          ? 'cursor-pointer rounded-md border border-brand bg-brand px-2 py-1 text-xs text-brand-foreground has-[:focus-visible]:outline-2'
                          : 'cursor-pointer rounded-md border border-border px-2 py-1 text-xs has-[:focus-visible]:outline-2'
                      }
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        onChange={() => toggle(module, action)}
                      />
                      {action}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      </fieldset>

      <Button type="submit" disabled={isSubmitting}>
        {t('save')}
      </Button>
    </ZodForm>
  );
}
