import { SetMetadata } from '@nestjs/common';

export const ALLOW_ANY_TENANT_KEY = 'allowAnyTenant';

/** Marks a route as tenant-agnostic: reachable with no resolved tenant, and exempt from the suspended/terminated gate. Read by TenantGateGuard. */
export const AllowAnyTenant = (): ReturnType<typeof SetMetadata> =>
  SetMetadata(ALLOW_ANY_TENANT_KEY, true);
