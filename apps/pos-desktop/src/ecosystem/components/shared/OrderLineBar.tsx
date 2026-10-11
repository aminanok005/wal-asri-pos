import { useRef, useState } from 'react';
import type { EcoOrder, OrderType } from '../../data/mockData';
import { StatusBadge } from './StatusBadge';

export type OrderLineRole = 'pos' | 'staff' | 'manager';
const ACTION_LABEL: Record<OrderLineRole, string> = { pos: 'View', staff: "It's Done ✓", manager: 'See All' };
type TypeFilter = 'All' | OrderType;

export function OrderLineBar({ orders, role, onAction }: {
  orders: readonly EcoOrder[];
  role: OrderLineRole;
  onAction: (o: EcoOrder) => void;
}) {
  const [filter, setFilter] = useState<TypeFilter>('All');
  const scroller = useRef<HTMLDivElement>(null);
  const counts: Record<TypeFilter, number> = {
    All: orders.length,
    'Dine-in': orders.filter((o) => o.type === 'Dine-in').length,
    'Take Away': orders.filter((o) => o.type === 'Take Away').length,
    Delivery: orders.filter((o) => o.type === 'Delivery').length,
  };
  const shown = filter === 'All' ? orders : orders.filter((o) => o.type === filter);
  const scrollBy = (dx: number) => scroller.current?.scrollBy({ left: dx, behavior: 'smooth' });
  const filters: readonly TypeFilter[] = ['All', 'Dine-in', 'Take Away', 'Delivery'];
  return (
    <section className="eco-orderline" aria-label="Order line">
      <div className="eco-orderline-tabs" role="tablist" aria-label="Filter by order type">
        {filters.map((f) => (
          <button key={f} type="button" role="tab" aria-selected={f === filter}
            className={`eco-pill${f === filter ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {f}{f !== 'All' && <span className="eco-count">{counts[f]}</span>}
          </button>
        ))}
      </div>
      <div className="eco-orderline-row">
        <button type="button" className="eco-nav-arrow" aria-label="Scroll orders left" onClick={() => scrollBy(-320)}>‹</button>
        <div className="eco-orderline-scroll" ref={scroller}>
          {shown.map((o) => {
            const qty = o.items.reduce((a, i) => a + i.qty, 0);
            return (
              <article key={o.id} className="eco-ocard">
                <div className="eco-ocard-top"><b>#{o.num}</b><span className="eco-omode">{o.type} · {o.table}</span></div>
                <div className="eco-ocard-mid"><span className="eco-qty">{qty} items</span><span className="eco-time">{o.timeAgo}</span></div>
                <div className="eco-ocard-bot"><StatusBadge status={o.status} />
                  <button type="button" className="eco-mini-btn" onClick={() => onAction(o)}>{ACTION_LABEL[role]}</button></div>
              </article>
            );
          })}
          {shown.length === 0 && <div className="eco-empty">No orders in this filter.</div>}
        </div>
        <button type="button" className="eco-nav-arrow" aria-label="Scroll orders right" onClick={() => scrollBy(320)}>›</button>
      </div>
    </section>
  );
}
