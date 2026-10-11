import { useState } from 'react';
import { ECO_MENU, ECO_STAFF, ecoBaht } from '../data/mockData';
import type { EcoOrder, OrderStatus } from '../data/mockData';
import { OrderLineBar } from '../components/shared/OrderLineBar';
import { Sidebar } from '../components/shared/Sidebar';
import { StatusBadge } from '../components/shared/StatusBadge';

type Tab = 'Orders' | 'Menu' | 'Insights' | 'Staff';
type SF = 'All' | OrderStatus;

export function ManagerView({ orders, onViewOrder }: { orders: readonly EcoOrder[]; onViewOrder: (o: EcoOrder) => void }) {
  const [tab, setTab] = useState<Tab>('Orders');
  const [sf, setSf] = useState<SF>('All');
  const [sel, setSel] = useState<EcoOrder | null>(null);
  const [q, setQ] = useState('');
  const count = (s: OrderStatus) => orders.filter((o) => o.status === s).length;
  const pills: readonly { k: SF; label: string }[] = [
    { k: 'All', label: `All (${orders.length})` }, { k: 'new', label: `New (${count('new')})` },
    { k: 'cooking', label: `Cooking (${count('cooking')})` }, { k: 'ready', label: `Ready (${count('ready')})` },
    { k: 'completed', label: `Completed (${count('completed')})` }, { k: 'cancelled', label: `Cancelled (${count('cancelled')})` },
  ];
  const shown = orders.filter((o) => (sf === 'All' || o.status === sf) && (!q || o.customer.toLowerCase().includes(q.toLowerCase()) || String(o.num).includes(q)));
  return (
    <div>
      <OrderLineBar orders={orders} role="manager" onAction={onViewOrder} />
      <div className="eco-mgr">
        <Sidebar items={[
          { key: 'home', icon: '🏠', label: 'Home' }, { key: 'order', icon: '🧾', label: 'Orders' },
          { key: 'chart', icon: '📊', label: 'Reports' }, { key: 'staff', icon: '👥', label: 'Staff' }, { key: 'set', icon: '⚙️', label: 'Settings' },
        ]} activeKey="order" onSelect={() => {}} />
        <div>
          <div className="eco-mgrtabs" role="tablist" aria-label="Manager sections">
            {(['Orders', 'Menu', 'Insights', 'Staff'] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={t === tab}
                className={`eco-pill${t === tab ? ' on' : ''}`} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>
          {tab === 'Orders' && (
            <div className={sel ? 'eco-split' : undefined}>
              <div>
                <label className="eco-search">🔍<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer / order #…" aria-label="Search orders" /></label>
                <div className="eco-orderline-tabs">{pills.map((p) => (
                  <button key={p.k} type="button" className={`eco-pill${sf === p.k ? ' on' : ''}`} onClick={() => setSf(p.k)}>{p.label}</button>
                ))}</div>
                <div className="eco-ogrid">
                  {shown.map((o) => (
                    <button key={o.id} type="button" className="eco-card" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => setSel(o)}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{o.customer}</b><StatusBadge status={o.status} /></div>
                      <div style={{ color: 'var(--e-mut)', fontSize: 12 }}>#{o.num} · {o.timeAgo} · {o.type} {o.table}</div>
                      <ul style={{ paddingLeft: 18, fontSize: 13, margin: '6px 0' }}>
                        {o.items.map((i) => <li key={i.name}>{i.name} × {i.qty} — {ecoBaht(i.price * i.qty)}</li>)}
                      </ul>
                      <span style={{ color: 'var(--e-primary-d)', fontWeight: 700, fontSize: 12 }}>See more →</span>
                    </button>
                  ))}
                </div>
                {shown.length === 0 && <div className="eco-empty">No orders match this filter.</div>}
              </div>
              {sel && (
                <aside className="eco-card" aria-label={`Order ${sel.num} details`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <b>Order #{sel.num}</b>
                    <button type="button" className="eco-iconbtn" aria-label="Close details" onClick={() => setSel(null)}>✕</button>
                  </div>
                  <p style={{ fontSize: 13, color: 'var(--e-mut)' }}>{sel.customer} · {sel.type} · {sel.table} · {sel.timeAgo}</p>
                  <StatusBadge status={sel.status} />
                  <hr style={{ border: 0, borderTop: '1px solid var(--e-border)', margin: '10px 0' }} />
                  {sel.items.map((i) => <div key={i.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>{i.name} × {i.qty}</span><span>{ecoBaht(i.price * i.qty)}</span></div>)}
                  <div className="eco-totals">
                    <div><span>Subtotal</span><span>{ecoBaht(sel.total)}</span></div>
                    <div><span>Tax 10%</span><span>{ecoBaht(sel.total * 0.1)}</span></div>
                    <div className="gt"><span>Total · PAID ✅</span><span>{ecoBaht(sel.total * 1.1)}</span></div>
                  </div>
                </aside>
              )}
            </div>
          )}
          {tab === 'Menu' && (
            <div className="eco-ogrid">
              <div className="eco-card" style={{ borderStyle: 'dashed', textAlign: 'center', color: 'var(--e-mut)' }}>＋<br />Add New Dish</div>
              {ECO_MENU.map((m) => (
                <div key={m.id} className="eco-dish">
                  <div className="eco-dishart" style={{ background: `linear-gradient(135deg,${m.grad[0]},${m.grad[1]})` }}>{m.emoji}</div>
                  <div className="eco-dishbody"><div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{m.name}</b><span className="pr">{ecoBaht(m.price)}</span></div>
                    <small style={{ color: 'var(--e-mut)' }}>{m.category} · ⋯</small></div>
                </div>
              ))}
            </div>
          )}
          {tab === 'Insights' && (
            <div>
              <div className="eco-card eco-alert red">🚨 Order #042 delayed 18 min — reassign a chef.</div>
              <div className="eco-card eco-alert green">📈 Pad Thai trending +23% this week — feature it on the banner.</div>
              <div className="eco-card eco-alert orange">⚠️ Inventory: chicken breast 2 kg left — reorder today.</div>
            </div>
          )}
          {tab === 'Staff' && (
            <div className="eco-ogrid">
              {ECO_STAFF.map((s) => (
                <div key={s.id} className="eco-card">
                  <b>{s.name}</b> <span style={{ color: 'var(--e-mut)', fontSize: 12 }}>{s.role} · Lv.{s.level} · {s.shift}</span>
                  <div className="eco-bar" style={{ marginTop: 8 }} role="progressbar" aria-valuenow={s.skillPct} aria-valuemin={0} aria-valuemax={100} aria-label={`${s.name} skill`}><i style={{ width: `${s.skillPct}%` }} /></div>
                  <small style={{ color: 'var(--e-mut)' }}>{s.skillPct}% to next level</small>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
