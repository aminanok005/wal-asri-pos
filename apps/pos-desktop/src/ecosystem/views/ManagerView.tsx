import { useState } from 'react';
import { ECO_MENU, ORDER_STATUSES, ecoBaht } from '../data/mockData';
import type { EcoOrder, OrderStatus } from '../data/mockData';
import { OrderLineBar } from '../components/shared/OrderLineBar';
import { PlannedPlaceholder } from '../components/shared/PlannedPlaceholder';
import { Sidebar } from '../components/shared/Sidebar';
import { StatusBadge } from '../components/shared/StatusBadge';

type Tab = 'Orders' | 'Menu' | 'Insights' | 'Staff';
type SF = 'All' | OrderStatus;

/**
 * Filter pill labels in the contract's own spelling: `Draft`, `Submitted`,
 * `In Preparation`, `Ready`, `Served`, `Completed`, `Void Requested`, `Voided`
 * — the eight rungs of `local_orders.status`, lowercased value mapped to a
 * sentence-case label. Both the count AND the filter run over the rows the
 * app holds, so a badge can never disagree with the list it opens.
 */
const STATUS_LABEL: Record<OrderStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  in_preparation: 'In Preparation',
  ready: 'Ready',
  served: 'Served',
  completed: 'Completed',
  void_requested: 'Void Requested',
  voided: 'Voided',
};

export function ManagerView({ orders, onViewOrder }: { orders: readonly EcoOrder[]; onViewOrder: (o: EcoOrder) => void }) {
  const [tab, setTab] = useState<Tab>('Orders');
  const [sf, setSf] = useState<SF>('All');
  const [sel, setSel] = useState<EcoOrder | null>(null);
  const [q, setQ] = useState('');
  const count = (s: OrderStatus) => orders.filter((o) => o.status === s).length;
  const pills: readonly { k: SF; label: string }[] = [
    { k: 'All', label: `All (${orders.length})` },
    ...ORDER_STATUSES.map((s) => ({ k: s as SF, label: `${STATUS_LABEL[s]} (${count(s)})` })),
  ];
  const shown = orders.filter((o) => (sf === 'All' || o.status === sf) && (!q || o.customer.toLowerCase().includes(q.toLowerCase()) || String(o.num).includes(q)));
  return (
    <div>
      <OrderLineBar orders={orders} role="manager" onAction={onViewOrder} />
      <div className="eco-mgr">
        <Sidebar items={[
          { key: 'home', icon: '🏠', label: 'หน้าแรก' }, { key: 'order', icon: '🧾', label: 'ออเดอร์' },
          { key: 'chart', icon: '📊', label: 'รายงาน' }, { key: 'staff', icon: '👥', label: 'พนักงาน' }, { key: 'set', icon: '⚙️', label: 'ตั้งค่า' },
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
                      <div style={{ color: 'var(--e-mut)', fontSize: 14 }}>#{o.num} · {o.timeAgo} · {o.type} {o.table}</div>
                      <ul style={{ paddingLeft: 18, fontSize: 14, margin: '6px 0' }}>
                        {o.items.map((i) => <li key={i.name}>{i.name} × {i.qty} — {ecoBaht(i.price * i.qty)}</li>)}
                      </ul>
                      <span style={{ color: 'var(--e-primary-d)', fontWeight: 700, fontSize: 14 }}>See more →</span>
                    </button>
                  ))}
                </div>
                {shown.length === 0 && <div className="eco-empty">No orders match this filter.</div>}
              </div>
              {sel && (
                <aside className="eco-card" aria-label={`Order ${sel.num} details`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <b>Order #{sel.num}</b>
                    <button type="button" className="eco-iconbtn" aria-label="ปิดหน้ารายละเอียด" onClick={() => setSel(null)}>✕</button>
                  </div>
                  <p style={{ fontSize: 14, color: 'var(--e-mut)' }}>{sel.customer} · {sel.type} · {sel.table} · {sel.timeAgo}</p>
                  <StatusBadge status={sel.status} />
                  <hr style={{ border: 0, borderTop: '1px solid var(--e-border)', margin: '10px 0' }} />
                  {sel.items.map((i) => <div key={i.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}><span>{i.name} × {i.qty}</span><span>{ecoBaht(i.price * i.qty)}</span></div>)}
                  <div className="eco-totals">
                    <div><span>Subtotal (incl. VAT)</span><span>{ecoBaht(sel.total)}</span></div>
                    <div className="gt"><span>Total · PAID ✅</span><span>{ecoBaht(sel.total)}</span></div>
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
            <PlannedPlaceholder title="Operational Insights" />
          )}
          {tab === 'Staff' && (
            <PlannedPlaceholder title="Staff Performance" />
          )}
        </div>
      </div>
    </div>
  );
}
