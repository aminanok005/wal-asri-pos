export function ThemeToggle({ dark, onToggle }: { dark: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="eco-iconbtn" onClick={onToggle} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
      {dark ? '☀️' : '🌙'}
    </button>
  );
}
