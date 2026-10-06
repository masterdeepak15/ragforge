import { Database, FlaskConical, LayoutDashboard, MessageSquare, Plug, Settings, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Only highlight on an exact path match (the home route). */
  end?: boolean;
}

/** Main navigation, shared by the sidebar and the command palette. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/knowledge-bases', label: 'Knowledge bases', icon: Database },
  { to: '/connect', label: 'Connect', icon: Plug },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/playground', label: 'Playground', icon: FlaskConical },
];
