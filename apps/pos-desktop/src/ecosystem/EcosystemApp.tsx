/**
 * EcosystemApp — Smart Restaurant POS Ecosystem shell (persona switcher + 4 views).
 * Mounted from AppShell as the opt-in "Smart Restaurant" screen so the existing
 * sales/offline routes and their tests are untouched.
 */
import { useState } from 'react';
import { ECO_INITIAL_ORDERS } from './data/mockData';
import type { EcoOrder } from './data/mockData';
import { ThemeToggle } from './components/shared/ThemeToggle';
import { CEOView } from './views/CEOView';
import { ManagerView } from './views/ManagerView';
import { POSView } from './views/POSView';
import { StaffView } from './views/StaffView';
import './ecosystem.css';

type Persona = 'pos' | 'staff' | 'manager' | 'ceo';
const PERSONAS: readonly { k: Persona; label: string }[] = [
  { k: 'pos', label: '🖥️ POS' }, { k: 'staff', label: '📱 Staff' },
  { k: 'manager', label: '📊 Manager' }, { k: 'ceo', label: '📈 CEO' },
];

export function EcosystemApp() {
  const [persona, setPersona] = useState<Persona>('pos');
  const [dark, setDark] = useState(true);
  const [orders, setOrders] = useState<readonly EcoOrder[]>(ECO_INITIAL_ORDERS);
  const [notice, setNotice] = useState<string | null>(null);

  const complete = (o: EcoOrder): string => {
    setOrders((prev) => prev.map((x) => (x.id === o.id ? { ...x, status: 'completed' as const } : x)));
    const next = orders.find((x) => x.id !== o.id && (x.status === 'new' || x.status === 'cooking'));
    const msg = next ? `Order #${o.num} done! AI assigned #${next.num} to you. 🤖` : `Order #${o.num} done! 🎉`;
    setNotice(msg);
    return msg;
  };
  const place = (items: { name: string; qty: number; price: number }[]): EcoOrder => {
    const num = Math.max(...orders.map((o) => o.num)) + 1;
    const total = items.reduce((a, i) => a + i.qty * i.price, 0);
    const o: EcoOrder = { id: `o${num}`, num, customer: 'Walk-in', table: 'โต๊ะ 4', type: 'Dine-in', status: 'new', items, total, timeAgo: 'just now' };
    setOrders((prev) => [o, ...prev]);
    return o;
  };
  const view = (o: EcoOrder) => setNotice(`Order #${o.num} · ${o.customer} · ${o.type} · ฿${o.total.toFixed(2)}`);

  return (
    <div className={`eco${dark ? ' eco--dark' : ''}`} data-testid="ecosystem">
      <div className="eco-persona" role="tablist" aria-label="Persona switcher">
        {PERSONAS.map((p) => (
          <button key={p.k} type="button" role="tab" aria-selected={p.k === persona}
            className={p.k === persona ? 'on' : ''} onClick={() => setPersona(p.k)}>{p.label}</button>
        ))}
        <span className="sp" />
        <ThemeToggle dark={dark} onToggle={() => setDark((d) => !d)} />
      </div>
      <div className="eco-body">
        {persona === 'pos' && <POSView orders={orders} onPlaceOrder={place} onViewOrder={view} />}
        {persona === 'staff' && <StaffView orders={orders} onDone={complete} />}
        {persona === 'manager' && <ManagerView orders={orders} onViewOrder={view} />}
        {persona === 'ceo' && <CEOView />}
        {notice && persona !== 'staff' && <div className="eco-toast" role="status">{notice}</div>}
      </div>
    </div>
  );
}
