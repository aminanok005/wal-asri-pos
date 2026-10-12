/**
 * One KPI tile. `delta` is OPTIONAL: a metric whose trend has no contract
 * data source (a rate of change needs two periods, and no period-over-period
 * entity exists yet) renders the tile without a trend chip rather than
 * inventing a percentage — see docs/lanes/lane3-contract-requests.md (ค).
 */
export function KPICard({
  title,
  value,
  delta,
  up,
  icon,
}: {
  title: string;
  value: string;
  delta?: string;
  up?: boolean;
  icon: string;
}) {
  return (
    <div className="eco-card eco-kpi">
      <div className="eco-kpi-top">
        <span className="eco-kpi-ico" aria-hidden="true">{icon}</span>
        {delta !== undefined && (
          <span className={`eco-delta${up ? ' up' : ' down'}`}>{up ? '▲' : '▼'} {delta}</span>
        )}
      </div>
      <div className="eco-kpi-val">{value}</div>
      <div className="eco-kpi-title">{title}</div>
    </div>
  );
}
