import { requirePlatformAdmin } from '@/lib/auth/guards';

/** Platform scope only (escalated and global appeals, the blacklist); a denial is a real 404. */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformAdmin();
  return children;
}
