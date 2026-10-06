import { useEffect, useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { CommandPalette } from './CommandPalette';
import { Logo } from './Logo';

/** Authenticated app frame: sidebar (drawer on small screens), page outlet, command palette. */
export default function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex min-h-screen bg-background">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 md:block">
        <Sidebar onOpenPalette={() => setPaletteOpen(true)} />
      </aside>

      {navOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button aria-label="Close menu" className="absolute inset-0 bg-foreground/40" onClick={() => setNavOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[260px] max-w-[85vw]">
            <Sidebar
              onOpenPalette={() => {
                setNavOpen(false);
                setPaletteOpen(true);
              }}
              onNavigate={() => setNavOpen(false)}
              onClose={() => setNavOpen(false)}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-card px-4 py-2.5 md:hidden">
          <button onClick={() => setNavOpen(true)} aria-label="Open menu" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
            <Menu className="size-5" />
          </button>
          <Link to="/" className="flex items-center gap-2 font-bold tracking-tight">
            <Logo className="size-5" /> RAGForge
          </Link>
        </div>
        <main id="main" className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
