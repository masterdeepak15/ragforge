import { Command } from 'cmdk';
import { Database, LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { NAV_ITEMS } from './nav';
import { useKnowledgeBases } from '../../lib/queries';
import { useTheme } from '../../lib/theme';
import { useAuth } from '../../lib/auth';

const itemClass =
  'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground aria-selected:bg-accent aria-selected:text-accent-foreground [&_svg]:size-4 [&_svg]:text-muted-foreground';
const groupClass = '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground';

/** Ctrl/Cmd+K: jump to any page or knowledge base, switch theme, sign out. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const { setTheme } = useTheme();
  const { logout } = useAuth();
  const { data: kbs } = useKnowledgeBases();

  const run = (action: () => void) => () => {
    onOpenChange(false);
    action();
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      overlayClassName="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-[1px]"
      contentClassName="fixed left-1/2 top-[18vh] z-50 w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
    >
      <Command.Input
        placeholder="Search or jump to…"
        className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="max-h-80 overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">No matches. Try a page or knowledge base name.</Command.Empty>

        <Command.Group heading="Go to" className={groupClass}>
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <Command.Item key={to} value={`go ${label}`} className={itemClass} onSelect={run(() => navigate(to))}>
              <Icon /> {label}
            </Command.Item>
          ))}
        </Command.Group>

        {kbs && kbs.length > 0 && (
          <Command.Group heading="Knowledge bases" className={groupClass}>
            {kbs.map((kb) => (
              <Command.Item key={kb.id} value={`kb ${kb.name}`} className={itemClass} onSelect={run(() => navigate(`/knowledge-bases/${kb.id}`))}>
                <Database /> {kb.name}
              </Command.Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading="Appearance" className={groupClass}>
          <Command.Item value="Light theme" className={itemClass} onSelect={run(() => setTheme('light'))}><Sun /> Light theme</Command.Item>
          <Command.Item value="Dark theme" className={itemClass} onSelect={run(() => setTheme('dark'))}><Moon /> Dark theme</Command.Item>
          <Command.Item value="System theme" className={itemClass} onSelect={run(() => setTheme('system'))}><Monitor /> Match system theme</Command.Item>
        </Command.Group>

        <Command.Group heading="Account" className={groupClass}>
          <Command.Item
            value="Sign out"
            className={itemClass}
            onSelect={run(() => {
              logout();
              navigate('/login');
            })}
          >
            <LogOut /> Sign out
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
