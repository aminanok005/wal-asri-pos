export function KPICard({ title, value, delta, up, icon }: { title: string; value: string; delta: string; up: boolean; icon: string }) {
  return (
    <div className="eco-card eco-kpi">
      <div className="eco-kpi-top"><span className="eco-kpi-ico" aria-hidden="true">{icon}</span>
        <span className={`eco-delta${up ? ' up' : ' down'}`}>{up ? '▲' : '▼'} {delta}</span></div>
      <div className="eco-kpi-val">{value}</div>
      <div className="eco-kpi-title">{title}</div>
    </div>
  );
}
