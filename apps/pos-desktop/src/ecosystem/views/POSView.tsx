import { useState } from 'react';
import { ECO_CATEGORIES, ECO_MENU, ecoBaht } from '../data/mockData';
import type { EcoMenuItem, EcoOrder, MenuCategory } from '../data/mockData';
import { OrderLineBar } from '../components/shared/OrderLineBar';
import { Sidebar } from '../components/shared/Sidebar';

export function POSView({ orders, onPlaceOrder, onViewOrder }: {
  orders: readonly EcoOrder[];
  onPlaceOrder: (items: { name: string; qty: number; price: number }[]) => EcoOrder;
  onViewOrder: (o: EcoOrder) => void;
}) {
  const [cat, setCat] = useState<MenuCategory | 'All'>('All');
  const [q, setQ] = useState('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [pay, setPay] = useState('Cash');
  const [mode, setMode] = useState('Dine In');
  const [lastNum, setLastNum] = useState<number | null>(null);
  const shown = ECO_MENU.filter((m) => (cat === 'All' || m.category === cat) && (!q || m.name.toLowerCase().includes(q.toLowerCase())));
  const lines = Object.entries(cart).filter(([, n]) => n > 0)
    .map(([id, qty]) => ({ item: ECO_MENU.find((m) => m.id === id) as EcoMenuItem, qty }));
  const sub = lines.reduce((a, l) => a + l.item.price * l.qty, 0);
  const tax = sub * 0.1;
  const place = () => {
    const o = onPlaceOrder(lines.map((l) => ({ name: l.item.name, qty: l.qty, price: l.item.price })));
    setCart({}); setLastNum(o.num);
  };
  return (
    <div>
      <OrderLineBar orders={orders} role="pos" onAction={onViewOrder} />
      <div className="eco-layout-pos">
        <Sidebar items={[
          { key: 'home', icon: '🏠', label: 'Home' }, { key: 'menu', icon: '📋', label: 'Menu' },
          { key: 'order', icon: '🧾', label: 'Orders' }, { key: 'promo', icon: '🎁', label: 'Promo' },
          { key: 'chart', icon: '📊', label: 'Reports' }, { key: 'set', icon: '⚙️', label: 'Settings' },
        ]} activeKey="menu" onSelect={() => {}} />
        <div>
          <h3 style={{ margin: '2px 0 0' }}>Let&apos;s make it a great day! 🌞</h3>
          <label className="eco-search">🔍<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search menu…" aria-label="Search menu" /></label>
          <div className="eco-orderline-tabs" role="tablist" aria-label="Categories">
            {ECO_CATEGORIES.map((c) => (
              <button key={c} type="button" role="tab" aria-selected={c === cat}
                className={`eco-pill${c === cat ? ' on' : ''}`} onClick={() => setCat(c)}>{c}</button>
            ))}
          </div>
          <div className="eco-grid">
            {shown.map((m) => {
              const n = cart[m.id] ?? 0;
              return (
                <div key={m.id} className={`eco-dish${n > 0 ? ' incart' : ''}`}>
                  <div className="eco-dishart" style={{ background: `linear-gradient(135deg,${m.grad[0]},${m.grad[1]})` }}>
                    <span role="img" aria-label={m.name}>{m.emoji}</span>
                  </div>
                  <div className="eco-dishbody">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                      <b>{m.name}</b><span className="pr">{ecoBaht(m.price)}</span>
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span className={`eco-veg${m.veg ? ' v' : ' n'}`}>{m.veg ? 'VEG' : 'NON-VEG'}</span>
                      <span style={{ color: 'var(--e-mut)', fontSize: 11 }}>🔥{m.kcal} · ⏱{m.mins}m</span>
                    </div>
                    {n === 0
                      ? <button type="button" className="eco-addbtn" onClick={() => setCart({ ...cart, [m.id]: 1 })}>Add to Dish</button>
                      : <div className="eco-stepper"><button type="button" aria-label={`Remove ${m.name}`} onClick={() => setCart({ ...cart, [m.id]: n - 1 })}>−</button>{n}<button type="button" aria-label={`Add ${m.name}`} onClick={() => setCart({ ...cart, [m.id]: n + 1 })}>+</button></div>}
                  </div>
                </div>
              );
            })}
          </div>
          {shown.length === 0 && <div className="eco-empty">No dishes match. Try another search.</div>}
        </div>
        <aside className="eco-card" aria-label="Current order">
          <h3 style={{ margin: '0 0 8px' }}>Table 4 · William ⭐</h3>
          <div className="eco-orderline-tabs">
            {['Dine In', 'Take Away', 'Delivery'].map((m) => (
              <button key={m} type="button" className={`eco-pill${m === mode ? ' on' : ''}`} onClick={() => setMode(m)}>{m}</button>
            ))}
          </div>
          {lines.length === 0 && <div className="eco-empty">Cart is empty — tap “Add to Dish”.</div>}
          {lines.map(({ item, qty }) => (
            <div key={item.id} className="eco-cartline">
              <span className="eco-thumb" style={{ background: `linear-gradient(135deg,${item.grad[0]},${item.grad[1]})` }}>{item.emoji}</span>
              <div style={{ flex: 1 }}>{item.name}<br /><span style={{ color: 'var(--e-mut)', fontSize: 12 }}>{ecoBaht(item.price)} × {qty}</span></div>
              <b style={{ fontFamily: 'JetBrains Mono,monospace' }}>{ecoBaht(item.price * qty)}</b>
            </div>
          ))}
          <div className="eco-totals">
            <div><span>Subtotal</span><span>{ecoBaht(sub)}</span></div>
            <div><span>Tax 10%</span><span>{ecoBaht(tax)}</span></div>
            <div className="gt"><span>Total</span><span>{ecoBaht(sub + tax)}</span></div>
          </div>
          <div className="eco-payrow" role="radiogroup" aria-label="Payment method">
            {['Cash', 'Card', 'QR'].map((p) => (
              <button key={p} type="button" role="radio" aria-checked={p === pay}
                className={p === pay ? 'on' : ''} onClick={() => setPay(p)}>{p === 'Cash' ? '💵 Cash' : p === 'Card' ? '💳 Card' : '📱 QR'}</button>
            ))}
          </div>
          <button type="button" className="eco-go" disabled={lines.length === 0} onClick={place}>
            Place Order{lines.length > 0 ? ` · ${ecoBaht(sub + tax)}` : ''}
          </button>
        </aside>
      </div>
      {lastNum !== null && (
        <div className="eco-modalwrap" role="dialog" aria-modal="true" aria-label="Order confirmed">
          <div className="eco-modal">
            <div style={{ fontSize: 44 }}>✅</div>
            <h2>Order #{lastNum} confirmed!</h2>
            <p style={{ color: 'var(--e-mut)' }}>Sent to kitchen · {mode} · {pay}</p>
            <button type="button" className="eco-go" onClick={() => setLastNum(null)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
