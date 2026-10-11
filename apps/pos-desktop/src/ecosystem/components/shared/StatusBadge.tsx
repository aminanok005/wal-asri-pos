import type { OrderStatus } from '../../data/mockData';

/**
 * Badge for one rung of the `local_orders.status` ladder (all eight states).
 * Colour families reuse the existing eco-badge palette; the labels are the
 * contract's own status names so a badge on screen reads the same as the row
 * in the database.
 */
const MAP: Record<OrderStatus, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'eco-badge--draft' },
  submitted: { label: 'Submitted', cls: 'eco-badge--new' },
  in_preparation: { label: 'In Preparation', cls: 'eco-badge--cooking' },
  ready: { label: 'Ready', cls: 'eco-badge--ready' },
  served: { label: 'Served', cls: 'eco-badge--served' },
  completed: { label: 'Completed', cls: 'eco-badge--completed' },
  void_requested: { label: 'Void Requested', cls: 'eco-badge--void_requested' },
  voided: { label: 'Voided', cls: 'eco-badge--voided' },
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const m = MAP[status];
  return <span className={`eco-badge ${m.cls}`}>{m.label}</span>;
}
