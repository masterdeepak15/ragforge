import { Link, NavLink, useNavigate } from 'react-router-dom';
import { LogOut, Monitor, Moon, Search, Sun, X } from 'lucide-react';
import { NAV_ITEMS } from './nav';
import { Logo } from './Logo';
import { cn } from '../../lib/cn';
import { useAuth } from '../../lib/auth';
import { useKnowledgeBases } from '../../lib/queries';
import { useTheme, type Theme } from '../../lib/theme';
import { Skeleton } from '../ui/skeleton';

const THEMES: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light theme', icon: Sun },
  { value: 'dark', label: 'Dark theme', icon: Moon },
  { value: 'system', label: 'System theme', icon: Monitor },
];

const MAX_LISTED_KBS = 8;

export function Sidebar({ onOpenPalette, onNavigate, onClose }: { onOpenPalette: () => void; onNavigate?: () => void; onClose?: () => void }) {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const { data: kbs, isLoading } = useKnowledgeBases();

  return (
    <div className="flex h-full flex-col gap-1 border-r border-border bg-card px-3 py-4">
      <div className="flex items-center justify-between px-2 pb-3">
        <Link to="/" onClick={onNavigate} className="flex items-center gap-2 text-base font-bold tracking-tight">
          <Logo className="size-[22px]" /> RAGForge
        </Link>
        {onClose && (
          <button onClick={onClose} aria-label="Close menu" className="rounded-md p-1 text-muted-foreground hover:bg-muted md:hidden">
            <X className="size-4" />
          </button>
        )}
      </div>

      <button
        onClick={onOpenPalette}
        aria-label="Search or jump to"
        className="mb-2 flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:text-foreground"
      >
        <Search className="size-4" aria-hidden />
        <span className="flex-1">Search…</span>
        <kbd className="rounded border border-border px-1.5 text-[11px]">Ctrl K</kbd>
      </button>

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )
            }
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">Knowledge bases</p>
        <nav aria-label="Your knowledge bases" className="flex flex-col gap-0.5">
          {isLoading && (
            <div className="space-y-1.5 px-2.5 py-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
            </div>
          )}
          {kbs?.slice(0, MAX_LISTED_KBS).map((kb) => (
            <NavLink
              key={kb.id}
              to={`/knowledge-bases/${kb.id}`}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn('truncate rounded-md px-2.5 py-1.5 text-sm', isActive ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground')
              }
            >
              {kb.name}
            </NavLink>
          ))}
          {kbs && kbs.length > MAX_LISTED_KBS && (
            <Link to="/knowledge-bases" onClick={onNavigate} className="px-2.5 py-1.5 text-sm text-primary hover:underline">
              View all {kbs.length}
            </Link>
          )}
        </nav>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 px-1" role="group" aria-label="Theme">
        <div className="flex rounded-md border border-border p-0.5">
          {THEMES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              onClick={() => setTheme(value)}
              aria-label={label}
              aria-pressed={theme === value}
              className={cn('rounded p-1.5 text-muted-foreground', theme === value ? 'bg-muted text-foreground' : 'hover:text-foreground')}
            >
              <Icon className="size-3.5" aria-hidden />
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2.5 border-t border-border px-1 pt-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold" aria-hidden>
          {user?.username?.charAt(0).toUpperCase() ?? '?'}
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-medium">{user?.username}</p>
          <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
        </div>
        <button
          onClick={() => {
            logout();
            navigate('/login');
          }}
          aria-label="Sign out"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <LogOut className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
