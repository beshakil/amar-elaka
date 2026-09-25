-- 0022_settings_parity
--
-- Seeds profile_display_name_max_length. ADR 020 introduced it and
-- AuthService.updateProfile reads it, but no migration ever inserted the
-- row, so PATCH /auth/me with a displayName threw SettingNotFoundException.
--
-- settings.registry.ts and the seeded rows are now kept in step by
-- src/settings/settings-seed-parity.spec.ts (CLAUDE.md rule 9: a setting is a
-- seed row plus a registry entry in the same change).

INSERT INTO public.platform_settings
  (key, value, value_type_code, unit, min_value, max_value, tenant_override_scope_code, description)
VALUES
  ('profile_display_name_max_length', '60', 'integer', 'characters', 10, 200, 'none',
   'Longest display name a member may set on their profile (PATCH /auth/me).');
