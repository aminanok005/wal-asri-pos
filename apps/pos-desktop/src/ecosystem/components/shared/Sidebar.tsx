export interface EcoNavItem { readonly key: string; readonly icon: string; readonly label: string; }
export function Sidebar({ items, activeKey, onSelect }: { items: readonly EcoNavItem[]; activeKey: string; onSelect: (k: string) => void }) {
  return (
    <nav className="eco-side" aria-label="Section navigation">
      {items.map((it) => (
        <button key={it.key} type="button" title={it.label} aria-label={it.label}
          className={`eco-sidebtn${it.key === activeKey ? ' on' : ''}`} onClick={() => onSelect(it.key)}>
          <span aria-hidden="true">{it.icon}</span>
        </button>
      ))}
    </nav>
  );
}
