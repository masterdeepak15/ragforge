/** @type {import('tailwindcss').Config} */
// Colours are CSS variables holding "R G B" triplets (see index.css), so Tailwind opacity modifiers work
// and light/dark themes switch by toggling the `dark` class on <html>.
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: token('background'),
        card: token('card'),
        foreground: token('foreground'),
        muted: token('muted'),
        'muted-foreground': token('muted-foreground'),
        border: token('border'),
        primary: token('primary'),
        'primary-foreground': token('primary-foreground'),
        accent: token('accent'),
        'accent-foreground': token('accent-foreground'),
        success: token('success'),
        warning: token('warning'),
        destructive: token('destructive'),
        ring: token('ring'),
        code: token('code'),
        'code-foreground': token('code-foreground'),
      },
      fontFamily: {
        sans: ['"Schibsted Grotesk"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'Consolas', 'monospace'],
      },
      borderRadius: { DEFAULT: '0.5rem', lg: '0.625rem' },
    },
  },
  plugins: [],
};
