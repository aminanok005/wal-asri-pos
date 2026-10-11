import { useState } from 'react';
import type { EcoOrder } from '../data/mockData';
import { OrderLineBar } from '../components/shared/OrderLineBar';
import { StatusBadge } from '../components/shared/StatusBadge';

const SLOTS: readonly { t: string; label: string; color: string }[] = [
  { t: '8 AM', label: '☕ Morning prep', color: 'rgba(59,130,246,.18)' },
  { t: '9 AM', label: '🍳 Cooking · Order #1043', color: 'rgba(249,115,22,.18)' },
  { t: '10 AM', label: '🍳 Cooking · Order #1044', color: 'rgba(249,115,22,.18)' },
  { t: '11 AM', label: '☕ Break', color: 'rgba(22,163,74,.15)' },
  { t: '12 PM', label: '🍳 Lunch rush', color: 'rgba(249,115,22,.18)' },
  { t: '1 PM', label: '🎓 Latte-art training', color: 'rgba(139,92,246,.16)' },
  { t: '2 PM', label: '🍳 Cooking · Order #1041', color: 'rgba(249,115,22,.18)' },
];

export function StaffView({ orders, onDone }: { orders: readonly EcoOrder[]; onDone: (o: EcoOrder) => string }) {
  const [inNow, setInNow] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const current = orders.find((o) => o.status === 'cooking' || o.status === 'new') ?? orders[0];
  if (!inNow) {
    return (
      <div className="eco-phone"><div className="eco-card eco-clockin" role="dialog" aria-label="Clock in">
        <div className="eco-avatar">👨‍🍳</div>
        <h2 style={{ margin: '0 0 4px' }}>Welcome, Kai Chen!</h2>
        <div className="eco-clocktime">08:02</div>
        <div style={{ color: 'var(--e-mut)', fontSize: 13 }}>Tuesday · Morning shift 08:00 – 16:00</div>
        <p><span className="eco-dot" style={{ background: 'var(--e-red)' }} />Clock Out</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="eco-pill" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setInNow(true)}>Later</button>
          <button type="button" className="eco-go" style={{ flex: 2 }} onClick={() => setInNow(true)}>Clock In Now</button>
        </div>
      </div></div>
    );
  }
  return (
    <div className="eco-phone">
      <p style={{ color: 'var(--e-mut)', fontSize: 13 }}>สวัสดี Kai 👋 · กะเช้า · <span className="eco-dot" style={{ background: 'var(--e-primary)' }} />Clocked in</p>
      <OrderLineBar orders={orders} role="staff" onAction={(o) => setToast(onDone(o))} />
      {current && (
        <div className="eco-card eco-task" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <b>Order #{current.num} · {current.table}</b><StatusBadge status={current.status} />
          </div>
          <ul style={{ paddingLeft: 18, fontSize: 13 }}>
            {current.items.map((i) => <li key={i.name}>{i.name} × {i.qty}</li>)}
          </ul>
          <button type="button" className="eco-go" onClick={() => setToast(onDone(current))}>It&apos;s Done ✓</button>
        </div>
      )}
      <div className="eco-card" style={{ marginTop: 10 }}>
        <b>✨ AI Coach</b>
        <p style={{ fontSize: 13, color: 'var(--e-mut)' }}>Practice latte-art pour to advance to Level 4 — ฿500/mo raise on level-up.</p>
        <div className="eco-bar" role="progressbar" aria-valuenow={72} aria-valuemin={0} aria-valuemax={100} aria-label="Barista level progress"><i style={{ width: '72%' }} /></div>
        <small style={{ color: 'var(--e-mut)' }}>Barista Level 3 → 4 · 72%</small>
      </div>
      <div className="eco-card" style={{ marginTop: 10 }}>
        <b>Today&apos;s timeline</b>
        <div className="eco-timeline">
          {SLOTS.map((s) => (
            <div key={s.t} className="eco-slot"><span className="tm">{s.t}</span><span className="ln" /><span className="pillblock" style={{ background: s.color }}>{s.label}</span></div>
          ))}
        </div>
      </div>
      {toast && <div className="eco-toast" role="status">{toast}</div>}
    </div>
  );
}
