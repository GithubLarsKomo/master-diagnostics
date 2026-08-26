import Link from 'next/link';

export function WorkspaceNav() {
  return (
    <nav className="workspace-nav" aria-label="Hauptnavigation">
      <Link href="/">Übersicht</Link>
      <Link href="/athletes">Athleten</Link>
      <Link href="/tests">Tests</Link>
    </nav>
  );
}
