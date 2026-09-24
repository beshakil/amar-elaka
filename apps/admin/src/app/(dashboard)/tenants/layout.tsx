import { requirePlatformAdmin } from '@/lib/auth/guards';

export default async function TenantsLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformAdmin();
  return children;
}
