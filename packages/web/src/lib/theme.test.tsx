import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from './theme';
import { mockMatchMedia } from '../test/setup';

function Probe() {
  const { theme, resolved, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="state">{`${theme}/${resolved}`}</span>
      <button onClick={() => setTheme('dark')}>dark</button>
      <button onClick={() => setTheme('light')}>light</button>
      <button onClick={() => setTheme('system')}>system</button>
    </div>
  );
}
const state = () => screen.getByTestId('state').textContent;
const isDark = () => document.documentElement.classList.contains('dark');

describe('ThemeProvider', () => {
  it('defaults to following the system preference', () => {
    mockMatchMedia(true);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(state()).toBe('system/dark');
    expect(isDark()).toBe(true);
  });

  it('applies and persists an explicit choice', async () => {
    mockMatchMedia(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    await userEvent.click(screen.getByText('dark'));
    expect(state()).toBe('dark/dark');
    expect(isDark()).toBe(true);
    expect(localStorage.getItem('ragforge_theme')).toBe('dark');
    await userEvent.click(screen.getByText('light'));
    expect(isDark()).toBe(false);
    expect(localStorage.getItem('ragforge_theme')).toBe('light');
  });

  it('restores the stored choice on load', () => {
    mockMatchMedia(false);
    localStorage.setItem('ragforge_theme', 'dark');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(state()).toBe('dark/dark');
  });

  it('ignores a corrupt stored value', () => {
    mockMatchMedia(false);
    localStorage.setItem('ragforge_theme', 'neon');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(state()).toBe('system/light');
  });

  it('follows OS changes only while set to system', async () => {
    const setOsDark = mockMatchMedia(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    act(() => setOsDark(true));
    expect(state()).toBe('system/dark');
    await userEvent.click(screen.getByText('light'));
    act(() => setOsDark(false));
    act(() => setOsDark(true));
    expect(state()).toBe('light/light');
  });

  it('still works when localStorage throws', async () => {
    mockMatchMedia(false);
    const spy = Object.getPrototypeOf(localStorage);
    const get = spy.getItem;
    const set = spy.setItem;
    spy.getItem = () => { throw new Error('blocked'); };
    spy.setItem = () => { throw new Error('blocked'); };
    try {
      render(<ThemeProvider><Probe /></ThemeProvider>);
      await userEvent.click(screen.getByText('dark'));
      expect(isDark()).toBe(true);
    } finally {
      spy.getItem = get;
      spy.setItem = set;
    }
  });
});
