import { cloneElement, createContext, useContext, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';

/**
 * A plain stand-in for components/ui/dropdown-menu in page tests. jsdom blocks for tens of seconds while
 * Radix positions a real menu, so page tests check what the page puts in the menu and what the items do;
 * the real menu is checked in a browser.
 */
const Ctx = createContext<{ open: boolean; setOpen: (v: boolean) => void }>({ open: false, setOpen: () => {} });

export function DropdownMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Ctx.Provider value={{ open, setOpen }}>{children}</Ctx.Provider>;
}

export function DropdownMenuTrigger({ children }: { children: ReactElement; asChild?: boolean }) {
  const { open, setOpen } = useContext(Ctx);
  return cloneElement(children, { onClick: () => setOpen(!open), 'aria-haspopup': 'menu', 'aria-expanded': open } as object);
}

export function DropdownMenuContent({ children }: { children: ReactNode }) {
  return useContext(Ctx).open ? <div role="menu">{children}</div> : null;
}

export function DropdownMenuItem({ children, onSelect, asChild }: { children: ReactNode; onSelect?: () => void; asChild?: boolean; destructive?: boolean }) {
  const { setOpen } = useContext(Ctx);
  const pick = (e: MouseEvent) => {
    onSelect?.();
    setOpen(false);
    void e;
  };
  if (asChild) return cloneElement(children as ReactElement, { role: 'menuitem', onClick: pick } as object);
  return (
    <div role="menuitem" tabIndex={-1} onClick={pick}>
      {children}
    </div>
  );
}

export const DropdownMenuSeparator = () => <hr />;
