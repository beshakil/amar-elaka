import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api/fetch';
import { agentListSchema, commissionReportSchema } from '@/lib/api/schemas';
import { requireRoles } from '@/lib/auth/guards';
import { AGENT_ADMIN_ROLES } from '@/lib/nav/nav';
import { AgentsTabs } from '../agents-tabs';

const isoDay = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The commission report (ADR 066): per agent for a period, approved new
 * shops (and verifications, updates) times the rate. A calculation — payouts
 * are made by hand, outside the platform (Month 4–5 builds payments).
 */
export default async function CommissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const viewer = await requireRoles(AGENT_ADMIN_ROLES);
  const auth = { tenantId: viewer.session.tenantId, accessToken: viewer.session.accessToken };
  const query = await searchParams;
  const t = await getTranslations('agents');
  // The default period: this month so far, in the area's own days.
  const today = (await apiFetch({ path: '/agents', schema: agentListSchema, ...auth })).date;
  const from = query.from && isoDay.test(query.from) ? query.from : `${today.slice(0, 8)}01`;
  const to = query.to && isoDay.test(query.to) && query.to >= from ? query.to : today;
  const report = await apiFetch({
    path: '/agents/commissions',
    query: { from, to },
    schema: commissionReportSchema,
    ...auth,
  });

  return (
    <>
      <AgentsTabs active="commissions" />
      <h1 className="mb-1 text-xl font-semibold">{t('commissionsTitle')}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t('commissionsDescription')}</p>
      <form className="mb-4 flex flex-wrap items-end gap-3" method="get">
        <div className="grid gap-1">
          <Label htmlFor="c-from">{t('from')}</Label>
          <Input id="c-from" name="from" type="date" defaultValue={from} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="c-to">{t('to')}</Label>
          <Input id="c-to" name="to" type="date" defaultValue={to} />
        </div>
        <Button type="submit">{t('show')}</Button>
      </form>
      {report.items.length === 0 ? (
        <p className="text-muted-foreground">{t('noCommissions')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="commission-report">
            <thead className="bg-muted text-left">
              <tr>
                <th className="px-3 py-2">{t('agent')}</th>
                <th className="px-3 py-2">{t('rate')}</th>
                <th className="px-3 py-2">{t('newShops')}</th>
                <th className="px-3 py-2">{t('verifications')}</th>
                <th className="px-3 py-2">{t('updates')}</th>
                <th className="px-3 py-2">{t('rejectedCol')}</th>
                <th className="px-3 py-2">{t('pendingCol')}</th>
                <th className="px-3 py-2 text-right">{t('amount')}</th>
              </tr>
            </thead>
            <tbody>
              {report.items.map((i) => (
                <tr key={i.agentId} className="border-t">
                  <td className="px-3 py-2">
                    {i.name ?? i.agentCode}{' '}
                    <span className="text-muted-foreground">· {i.agentCode}</span>
                  </td>
                  <td className="px-3 py-2">৳ {i.rate}</td>
                  <td className="px-3 py-2">{i.newShops}</td>
                  <td className="px-3 py-2">{i.verifications}</td>
                  <td className="px-3 py-2">{i.updates}</td>
                  <td className="px-3 py-2">{i.rejected}</td>
                  <td className="px-3 py-2">{i.pending}</td>
                  <td className="px-3 py-2 text-right font-medium">৳ {i.amount}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-semibold">
                <td className="px-3 py-2" colSpan={7}>
                  {t('total')}
                </td>
                <td className="px-3 py-2 text-right">৳ {report.total}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{t('commissionsNote')}</p>
    </>
  );
}
