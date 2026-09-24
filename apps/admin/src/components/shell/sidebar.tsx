'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Building2,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Shield,
  Users,
} from 'lucide-react';
import { useTransition } from 'react';
import { setSidebarCollapsed } from '@/app/actions/sidebar';
import type { NavItem } from '@/lib/nav/nav';
import { cn } from '@/lib/utils';

const ICONS = {
  dashboard: LayoutDashboard,
  shield: Shield,
  users: Users,
  building: Building2,
} as const;

/**
 * Collapsed state is a cookie the server already read when rendering, so the
 * sidebar is the right width in the first paint instead of snapping after
 * hydration.
 */
export function Sidebar({ items, collapsed }: { items: NavItem[]; collapsed: boolean }) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const [, startTransition] = useTransition();

  function toggle() {
    startTransition(async () => {
      await setSidebarCollapsed(!collapsed);
    });
  }

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-border bg-card transition-[width]',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div className="flex h-14 items-center justify-between px-3">
        {collapsed ? null : <span className="font-semibold">আমার এলাকা</span>}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
          className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" aria-hidden />
          ) : (
            <PanelLeftClose className="size-4" aria-hidden />
          )}
        </button>
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {items.map((item) => {
          const Icon = ICONS[item.icon];
          const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              title={collapsed ? t(item.key) : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm',
                isActive ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {collapsed ? <span className="sr-only">{t(item.key)}</span> : t(item.key)}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
