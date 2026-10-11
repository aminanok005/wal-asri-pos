import { useEffect, useState } from 'react';
import { ECO_ACTIVITY } from '../data/mockData';
import { KPICard } from '../components/shared/KPICard';
import { PlannedPlaceholder } from '../components/shared/PlannedPlaceholder';
import { Sidebar } from '../components/shared/Sidebar';
import {
  createReportingClient,
  type BranchRevenue,
  type ReportSummary,
} from '../../features/reporting/infrastructure/reportingClient';
import { satangFromWire } from '../../features/payments/domain/money';

/**
 * CEO dashboard.
 *
 * `totalOrders` is the ONE local dynamic figure — counted by the shell from
 * the order rows it holds (group ก: `COUNT(*)` semantics over the same
 * `local_orders` states everywhere else renders).
 *
 * REVENUE IS LIVE WHEN IT CAN BE. `totalRevenue`/`summary` arrive through an
 * OPTIONAL loader the shell provides (group ข: `GET /reports/summary` →
 * `revenue_total_satang`). When the loader is absent the card renders WITHOUT
 * a mock amount (`revenue_total_satang` is omitted), and when the loader fails
 * the KPIs fall back to the reserved slots — the old hard-coded "฿2.84M" is
 * gone on both paths, because a number no system computed is the exact spec
 * drift this refactor exists to delete.
 *
 * Everything without a contract entity stays a reserved slot (group ค), per
 * docs/lanes/lane3-contract-requests.md.
 */

const MISSING_REVENUE: ReportSummary = {
  asOf: '',
  revenueTotalSatang: '',
  vatSatang: '',
  orderCount: 0,
  voidedCount: 0,
};

export function CEOView({
  totalOrders,
  reportingBaseUrl,
  reportingBranchId,
}: {
  totalOrders: number;
  /** LAN base URL of the Go service (`http://127.0.0.1:8080`), or omitted for demo mode. */
  reportingBaseUrl?: string;
  /** Branch to report on (`WAL_ASRI_BRANCH_ID`), required when `reportingBaseUrl` is set. */
  reportingBranchId?: string;
}) {
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);

  useEffect(() => {
    if (reportingBaseUrl === undefined || reportingBranchId === undefined) {
      return;
    }
    let cancelled = false;
    const client = createReportingClient(
      async (url) => {
        const response = await fetch(url);
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, body };
      },
      reportingBaseUrl,
    );
    client
      .summary(reportingBranchId, '2026-10-01', '2026-10-31')
      .then((loaded) => {
        if (!cancelled) {
          setSummary(loaded);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSummaryFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reportingBaseUrl, reportingBranchId]);

  const live = summary ?? MISSING_REVENUE;

  // VAT-inclusive revenue, formatted through the domain Money — never a float
  // parse, never a bare-number render. Absent while unfetched/unwired, which
  // is exactly when the KPI must NOT invent one.
  const revenueLabel =
    live.revenueTotalSatang === ''
      ? undefined
      : `฿${satangFromWire('revenue_total_satang', live.revenueTotalSatang).toString()}`;

  const [branches, setBranches] = useState<readonly BranchRevenue[] | null>(null);

  useEffect(() => {
    if (reportingBaseUrl === undefined) {
      return;
    }
    let cancelled = false;
    const client = createReportingClient(
      async (url) => {
        const response = await fetch(url);
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, body };
      },
      reportingBaseUrl,
    );
    client
      .revenueByBranch('2026-10-01', '2026-10-31')
      .then((loaded) => {
        if (!cancelled) {
          setBranches(loaded);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBranches([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reportingBaseUrl]);

  function RevenueByBranchCard() {
    if (branches === null || branches.length === 0) {
      return <PlannedPlaceholder title="Branch Ranking" />;
    }
    return (
      <div className="eco-card">
        <b>🏪 Branch Ranking</b>
        {branches.map((b, rank) => (
          <div key={b.branchId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0', borderBottom: '1px solid var(--e-border)' }}>
            <span>#{rank + 1} {b.name}</span>
            <span>฿{satangFromWire('revenue_satang', b.revenueSatang).toString()} · {b.orderCount} orders</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div>
      <h2 style={{ margin: '0 0 2px' }}>Good morning, Sarun ☀️</h2>
      <p style={{ color: 'var(--e-mut)', fontSize: 14, margin: '0 0 6px' }}>Tuesday · All branches · Live overview</p>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div className="eco-kpi-grid">
            {revenueLabel === undefined ? (
              <PlannedPlaceholder title="Total Revenue" />
            ) : (
              <KPICard title="Total Revenue" value={revenueLabel} icon="💰" />
            )}
            <PlannedPlaceholder title="Net Profit" />
            <KPICard title="Total Orders" value={String(totalOrders)} icon="🧾" />
            <PlannedPlaceholder title="New Customers" />
          </div>
          <PlannedPlaceholder title="Revenue vs Expenses" />
          <PlannedPlaceholder title="Predictive Analytics" />
        </div>
        <Sidebar items={[
          { key: 'dash', icon: '📈', label: 'แดชบอร์ด' }, { key: 'br', icon: '🏪', label: 'สาขา' },
          { key: 'ai', icon: '🤖', label: 'สรุป AI' }, { key: 'risk', icon: '⚠️', label: 'ความเสี่ยง' },
        ]} activeKey="dash" onSelect={() => {}} />
      </div>
      <div className="eco-ogrid" style={{ marginTop: 12 }}>
        {summary === null || summaryFailed ? (
          <PlannedPlaceholder title="Branch Ranking" />
        ) : (
          <RevenueByBranchCard />
        )}
        <PlannedPlaceholder title="AI Executive Summary" />
        <PlannedPlaceholder title="Risk & Alerts" />
        <div className="eco-card">
          <b>🕒 Recent Activity</b>
          <div className="eco-feed">{ECO_ACTIVITY.map((a) => <div key={a.t}><time>{a.t}</time>{a.text}</div>)}</div>
        </div>
      </div>
    </div>
  );
}
