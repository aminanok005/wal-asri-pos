import { useState } from 'react';
import type { EcoOrder } from '../data/mockData';
import { OrderLineBar } from '../components/shared/OrderLineBar';
import { PlannedPlaceholder } from '../components/shared/PlannedPlaceholder';
import { StatusBadge } from '../components/shared/StatusBadge';

export function StaffView({ orders, onDone }: { orders: readonly EcoOrder[]; onDone: (o: EcoOrder) => string }) {
  const [inNow, setInNow] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const current = orders.find((o) => o.status === 'in_preparation' || o.status === 'submitted') ?? orders[0];
  if (!inNow) {
    return (
      <div className="eco-phone"><div className="eco-card eco-clockin" role="dialog" aria-label="Clock in">
        <div className="eco-avatar">👨‍🍳</div>
        <h2 style={{ margin: '0 0 4px' }}>Clock in</h2>
        <PlannedPlaceholder title="Shift & Attendance" />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" className="eco-pill" style={{ flex: 1, justifyContent: 'center' }} aria-label="เข้ากะทีหลัง (Later)" onClick={() => setInNow(true)}>Later</button>
          <button type="button" className="eco-go" style={{ flex: 2 }} aria-label="เริ่มกะตอนนี้ (Clock In Now)" onClick={() => setInNow(true)}>Clock In Now</button>
        </div>
      </div></div>
    );
  }
  return (
    <div className="eco-phone">
      <p style={{ color: 'var(--e-mut)', fontSize: 14 }}><span className="eco-dot" style={{ background: 'var(--e-primary)' }} />Clocked in</p>
      <OrderLineBar orders={orders} role="staff" onAction={(o) => setToast(onDone(o))} />
      {current && (
        <div className="eco-card eco-task" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <b>Order #{current.num} · {current.table}</b><StatusBadge status={current.status} />
          </div>
          <ul style={{ paddingLeft: 18, fontSize: 14 }}>
            {current.items.map((i) => <li key={i.name}>{i.name} × {i.qty}</li>)}
          </ul>
          <button type="button" className="eco-go" onClick={() => setToast(onDone(current))}>It&apos;s Done ✓</button>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <PlannedPlaceholder title="AI Coach" />
      </div>
      <div style={{ marginTop: 10 }}>
        <PlannedPlaceholder title="Today's Timeline" />
      </div>
      {toast && <div className="eco-toast" role="status">{toast}</div>}
    </div>
  );
}
