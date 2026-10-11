import { useState } from 'react';
import { ECO_ACTIVITY, ECO_BRANCHES, ECO_MONTHLY } from '../data/mockData';
import { KPICard } from '../components/shared/KPICard';
import { Sidebar } from '../components/shared/Sidebar';

export function CEOView() {
  const [range, setRange] = useState<'1W' | '1M' | '1Y'>('1M');
  const max = Math.max(...ECO_MONTHLY.map((m) => m.revenue));
  const forecast = range === '1W' ? [262, 271, 284, 296, 305, 312, 320] : range === '1M' ? ECO_MONTHLY.map((m) => m.revenue) : ECO_MONTHLY.map((m) => m.revenue * 12);
  const fmax = Math.max(...forecast);
  const labels = range === '1W' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : range === '1M' ? ECO_MONTHLY.map((m) => m.m) : ['Q1', 'Q2', 'Q3', 'Q4'];
  const fvals = range === '1M' ? forecast : range === '1W' ? forecast : [576, 700, 758, 851];
  return (
    <div>
      <h2 style={{ margin: '0 0 2px' }}>Good morning, Sarun ☀️</h2>
      <p style={{ color: 'var(--e-mut)', fontSize: 13, margin: '0 0 6px' }}>Tuesday · All branches · Live overview</p>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div className="eco-kpi-grid">
            <KPICard title="Total Revenue" value="฿2.84M" delta="8.3%" up icon="💰" />
            <KPICard title="Net Profit" value="฿680K" delta="5.1%" up icon="📈" />
            <KPICard title="Total Orders" value="4,821" delta="12%" up icon="🧾" />
            <KPICard title="New Customers" value="847" delta="3.2%" up icon="👥" />
          </div>
          <div className="eco-card">
            <b>Revenue vs Expenses (K ฿)</b>
            <div className="eco-chart" role="img" aria-label="Monthly revenue versus expenses bar chart">
              {ECO_MONTHLY.map((m) => (
                <div key={m.m} className="col">
                  <div className="rv" style={{ height: `${(m.revenue / max) * 100}%` }} title={`Revenue ${m.revenue}K`} />
                  <div className="ex" style={{ height: `${(m.expense / max) * 70}%` }} title={`Expense ${m.expense}K`} />
                </div>
              ))}
            </div>
            <div className="eco-chartlbl">{ECO_MONTHLY.map((m) => <span key={m.m}>{m.m}</span>)}</div>
            <small style={{ color: 'var(--e-mut)' }}>🟩 Revenue · ⬜ Expenses</small>
          </div>
          <div className="eco-card" style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <b>🔮 Predictive Analytics</b>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['1W', '1M', '1Y'] as const).map((r) => (
                  <button key={r} type="button" className={`eco-pill${r === range ? ' on' : ''}`} onClick={() => setRange(r)}>{r}</button>
                ))}
              </div>
            </div>
            <div className="eco-chart" role="img" aria-label={`Forecast chart range ${range}`}>
              {fvals.map((v, i) => (
                <div key={i} className="col"><div className="rv" style={{ height: `${(v / fmax) * 95}%`, opacity: i >= fvals.length - 2 ? 0.45 : 1 }} title={`${labels[i]}: ${v}`} /></div>
              ))}
            </div>
            <div className="eco-chartlbl">{labels.map((l) => <span key={l}>{l}</span>)}</div>
            <small style={{ color: 'var(--e-mut)' }}>Faded bars = AI forecast (dashed trend in full recharts build)</small>
          </div>
        </div>
        <Sidebar items={[
          { key: 'dash', icon: '📈', label: 'Dashboard' }, { key: 'br', icon: '🏪', label: 'Branches' },
          { key: 'ai', icon: '🤖', label: 'AI Summary' }, { key: 'risk', icon: '⚠️', label: 'Risks' },
        ]} activeKey="dash" onSelect={() => {}} />
      </div>
      <div className="eco-ogrid" style={{ marginTop: 12 }}>
        <div className="eco-card">
          <b>🏪 Branch Ranking</b>
          {ECO_BRANCHES.map((b) => (
            <div key={b.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--e-border)' }}>
              <span>#{b.rank} {b.name}</span><span>{b.revenue} · {b.orders} orders · ⚡{b.score}</span>
            </div>
          ))}
        </div>
        <div className="eco-card">
          <b>🤖 AI Executive Summary</b>
          <p style={{ fontSize: 13, color: 'var(--e-mut)' }}>Revenue +8% driven by Pad Thai and Iced Coffee. Ekkamai underperformed −12% — suggest weekend promo and one extra barista on Sat/Sun.</p>
        </div>
        <div className="eco-card">
          <b>⚠️ Risk & Alerts</b>
          <div className="eco-card eco-alert red" style={{ fontSize: 12 }}>Staff turnover risk: 2 chefs on probation.</div>
          <div className="eco-card eco-alert orange" style={{ fontSize: 12 }}>Holiday stock gap: dairy +15% buffer needed.</div>
        </div>
        <div className="eco-card">
          <b>🕒 Recent Activity</b>
          <div className="eco-feed">{ECO_ACTIVITY.map((a) => <div key={a.t}><time>{a.t}</time>{a.text}</div>)}</div>
        </div>
      </div>
    </div>
  );
}
