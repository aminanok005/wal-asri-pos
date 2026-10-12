import { useMemo, useState } from 'react';
import { ECO_CATEGORIES, ECO_MENU } from '../data/mockData';
import type { EcoMenuItem, EcoOrder, MenuCategory } from '../data/mockData';
import { OrderLineBar } from '../components/shared/OrderLineBar';
import { Sidebar } from '../components/shared/Sidebar';
import {
  addItem,
  calculateOrderTotals,
  createCart,
} from '../../features/sales/domain/cart';
import type { Cart, UuidV7 } from '../../features/sales/domain/cart';
import type { ProductVariant } from '../../features/sales/domain/cart';
import { DEFAULT_VAT_RATE_BP } from '../../features/sales/domain/tax';
import { nextCartLineId } from '../../features/sales/domain/lineId';
import { Money } from '../../features/payments/domain/money';

/**
 * The demo menu is NOT a contract catalogue — but the basket it builds IS the
 * real sales-domain `Cart`, so the VAT maths below is the production one
 * (VAT-inclusive, 7%, rounded once per order) rather than a demo approximation.
 * Only the fields the cart domain reads are provided below (`id` for merge
 * identity, `sku`, `name_th`, `is_active` for the sellable check); totals
 * never look inside `variant`, which is exactly why this adapter is honest.
 */
function demoVariant(m: EcoMenuItem, n: number): ProductVariant {
  const stamp = (base: number): UuidV7 =>
    `018f3c2a-0000-7000-8000-${String(base).padStart(12, '0')}` as UuidV7;
  return {
    id: stamp(100 + n),
    product_id: stamp(200 + n),
    sku: m.id,
    name_th: m.name,
    name_en: null,
    is_active: true,
    version: 1,
    updated_at: '2026-10-02T09:15:00Z',
  };
}

/** Baht display for a `Money` value — formatting only, never arithmetic. */
function baht(m: Money): string {
  return `฿${m.toString()}`;
}

export function POSView({ orders, onPlaceOrder, onViewOrder }: {
  orders: readonly EcoOrder[];
  onPlaceOrder: (items: { name: string; qty: number; price: number }[]) => EcoOrder;
  onViewOrder: (o: EcoOrder) => void;
}) {
  const [cat, setCat] = useState<MenuCategory | 'All'>('All');
  const [q, setQ] = useState('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [pay, setPay] = useState<'Cash' | 'QR'>('Cash');
  const [mode, setMode] = useState('Dine In');
  const [lastNum, setLastNum] = useState<number | null>(null);
  const shown = ECO_MENU.filter((m) => (cat === 'All' || m.category === cat) && (!q || m.name.toLowerCase().includes(q.toLowerCase())));
  const lines = Object.entries(cart).filter(([, n]) => n > 0)
    .map(([id, qty]) => ({ item: ECO_MENU.find((m) => m.id === id) as EcoMenuItem, qty }));

  // THE REAL TOTALS. The old demo math (`tax = sub * 0.1`) was a forward 10%
  // surcharge on a VAT-inclusive price — double-charging every mock sale. The
  // basket below is rebuilt as a domain `Cart` so `calculateOrderTotals`
  // extracts the 7% VAT from the inclusive gross instead of adding it on top.
  // Menu prices are demo baht numbers: satang conversion happens HERE at the
  // boundary (`Math.round(price * 100)`), on entry, once — the rule the crate
  // enforces for every real amount.
  const domainCart: Cart = useMemo(() => {
    let c = createCart();
    for (const l of lines) {
      const n = ECO_MENU.indexOf(l.item);
      c = addItem(
        c,
        demoVariant(l.item, n),
        BigInt(l.qty),
        Money.fromSatang(BigInt(Math.round(l.item.price * 100))),
        nextCartLineId(),
      );
    }
    return c;
  }, [lines]);
  const totals = useMemo(() => calculateOrderTotals(domainCart, DEFAULT_VAT_RATE_BP), [domainCart]);

  const place = () => {
    const o = onPlaceOrder(lines.map((l) => ({ name: l.item.name, qty: l.qty, price: l.item.price })));
    setCart({}); setLastNum(o.num);
  };
  return (
    <div>
      <OrderLineBar orders={orders} role="pos" onAction={onViewOrder} />
      <div className="eco-layout-pos">
        <Sidebar items={[
          { key: 'home', icon: '🏠', label: 'หน้าแรก' }, { key: 'menu', icon: '📋', label: 'เมนู' },
          { key: 'order', icon: '🧾', label: 'ออเดอร์' }, { key: 'promo', icon: '🎁', label: 'โปรโมชัน' },
          { key: 'chart', icon: '📊', label: 'รายงาน' }, { key: 'set', icon: '⚙️', label: 'ตั้งค่า' },
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
                    <span role="img" aria-label={`อาหาร ${m.name}`}>{m.emoji}</span>
                  </div>
                  <div className="eco-dishbody">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                      <b>{m.name}</b><span className="pr">{ecoBaht(m.price)}</span>
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span className={`eco-veg${m.veg ? ' v' : ' n'}`}>{m.veg ? 'VEG' : 'NON-VEG'}</span>
                    </div>
                    {n === 0
                      ? <button type="button" className="eco-addbtn" aria-label={`เพิ่ม ${m.name} ลงตะกร้า (Add to Dish)`} onClick={() => setCart({ ...cart, [m.id]: 1 })}>Add to Dish</button>
                      : <div className="eco-stepper"><button type="button" aria-label={`ลด ${m.name} หนึ่งชิ้น (Remove)`} onClick={() => setCart({ ...cart, [m.id]: n - 1 })}>−</button>{n}<button type="button" aria-label={`เพิ่ม ${m.name} หนึ่งชิ้น (Add)`} onClick={() => setCart({ ...cart, [m.id]: n + 1 })}>+</button></div>}
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
              <div style={{ flex: 1 }}>{item.name}<br /><span style={{ color: 'var(--e-mut)', fontSize: 14 }}>{ecoBaht(item.price)} × {qty}</span></div>
              <b style={{ fontFamily: 'JetBrains Mono,monospace' }}>{ecoBaht(item.price * qty)}</b>
            </div>
          ))}
          <div className="eco-totals">
            <div><span>Subtotal (incl. VAT)</span><span>{baht(totals.subtotal)}</span></div>
            <div><span>VAT 7%</span><span>{baht(totals.tax)}</span></div>
            <div><span>Net</span><span>{baht(totals.net)}</span></div>
            <div className="gt"><span>Total</span><span>{baht(totals.total)}</span></div>
          </div>
          <div className="eco-payrow" role="radiogroup" aria-label="Payment method">
            {(['Cash', 'QR'] as const).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={p === pay}
                aria-label={p === 'Cash' ? 'ชำระด้วยเงินสด' : 'ชำระด้วยคิวอาร์พร้อมเพย์'}
                className={p === pay ? 'on' : ''} onClick={() => setPay(p)}>{p === 'Cash' ? '💵 Cash' : '📱 QR'}</button>
            ))}
          </div>
          <button type="button" className="eco-go" disabled={lines.length === 0} onClick={place}>
            Place Order{lines.length > 0 ? ` · ${baht(totals.total)}` : ''}
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

function ecoBaht(v: number): string {
  return `฿${v.toFixed(2)}`;
}
