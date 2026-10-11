import type { OrderStatus } from '../../data/mockData';
const MAP: Record<OrderStatus, { label: string; cls: string }> = {
  new: { label: 'New Order', cls: 'eco-badge--new' },
  cooking: { label: 'Cooking', cls: 'eco-badge--cooking' },
  ready: { label: 'Ready', cls: 'eco-badge--ready' },
  completed: { label: 'Completed', cls: 'eco-badge--completed' },
  cancelled: { label: 'Cancelled', cls: 'eco-badge--cancelled' },
};
export function StatusBadge({ status }: { status: OrderStatus }) {
  const m = MAP[status];
  return <span className={`eco-badge ${m.cls}`}>{m.label}</span>;
}
