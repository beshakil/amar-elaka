import { z } from 'zod';
import { createZodDto } from '../../common/pipes/zod-dto';

// Validated before it reaches a uuid column, where a malformed id would
// otherwise surface as a database error rather than a 400.
export const roleIdParamSchema = z.object({ roleId: z.string().uuid() });

export class RoleIdParamDto extends createZodDto(roleIdParamSchema) {}
