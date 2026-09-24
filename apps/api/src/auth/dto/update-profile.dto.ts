import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

// The real max (profile_display_name_max_length) is a platform setting; this
// is just a structural non-empty check, enforced properly in AuthService —
// same split as email-register.dto.ts's password.
export const updateProfileSchema = z.object({
  displayName: z.string().min(1).optional(),
  // A storage key is server-generated as `${tenantId}/${kind}/${uuid}` (~80 chars).
  // settings-exempt: a sanity guard against abuse input, not a business threshold.
  avatarStorageKey: z.string().min(1).max(500).nullable().optional(),
});

export class UpdateProfileDto extends createZodDto(updateProfileSchema) {}
