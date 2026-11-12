/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '2rem', screens: { '2xl': '1400px' } },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        // Paleta semántica para charts/estados.
        success: { DEFAULT: 'hsl(var(--success))', foreground: 'hsl(var(--success-foreground))' },
        warning: { DEFAULT: 'hsl(var(--warning))', foreground: 'hsl(var(--warning-foreground))' },
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
        },
        // Dorado de logro (hyper points), theme-aware.
        hyper: 'hsl(var(--hyper))',
        // ── Identidad roz v2 (ver src/DESIGN.md). Se fusionan con la escala de Tailwind (orange-500
        // sigue existiendo), pero en componentes se usan SOLO estas: `bg-orange`, `bg-orange-soft`…
        faint: 'hsl(var(--faint))',
        panel: 'hsl(var(--panel))',
        sidebar: 'hsl(var(--sidebar))',
        'toggle-off': 'hsl(var(--toggle-off))',
        scrim: 'hsl(var(--scrim))',
        ink: { DEFAULT: 'hsl(var(--ink))', foreground: 'hsl(var(--ink-foreground))' },
        orange: { DEFAULT: 'hsl(var(--orange))', soft: 'hsl(var(--orange-soft))', ink: 'hsl(var(--orange-ink))' },
        salmon: 'hsl(var(--salmon))',
        purple: { DEFAULT: 'hsl(var(--purple))', deep: 'hsl(var(--purple-deep))' },
        lavender: 'hsl(var(--lavender))',
        yellow: { DEFAULT: 'hsl(var(--yellow))', soft: 'hsl(var(--yellow-soft))', ink: 'hsl(var(--yellow-ink))' },
        green: { DEFAULT: 'hsl(var(--green))', soft: 'hsl(var(--green-soft))' },
        red: { DEFAULT: 'hsl(var(--red))', soft: 'hsl(var(--red-soft))' },
        blue: { DEFAULT: 'hsl(var(--blue))', soft: 'hsl(var(--blue-soft))', ink: 'hsl(var(--blue-ink))' },
        // Sidebar del chat (gris cálido en claro, tinta en oscuro).
        'chat-sidebar': {
          DEFAULT: 'hsl(var(--chat-sidebar))',
          foreground: 'hsl(var(--chat-sidebar-foreground))',
          muted: 'hsl(var(--chat-sidebar-muted))',
          hover: 'hsl(var(--chat-sidebar-hover))',
          border: 'hsl(var(--chat-sidebar-border))',
        },
        // Bloque de terminal (oscuro en ambos modos).
        terminal: {
          DEFAULT: 'hsl(var(--terminal))',
          foreground: 'hsl(var(--terminal-foreground))',
          muted: 'hsl(var(--terminal-muted))',
        },
      },
      // lg = tarjeta (10px), xl/2xl = panel gris (14px), btn = botón Stape (4px).
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 4px)',
        sm: 'calc(var(--radius) - 6px)',
        xl: '14px',
        '2xl': '16px',
        btn: '4px',
      },
      fontFamily: {
        // Inter Tight = todo el texto, etiquetas incluidas (`.label-caps`); JetBrains Mono SOLO para código, IDs, hashes y rutas.
        // Se cargan desde Google Fonts en index.html.
        sans: ['"Inter Tight"', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['"Inter Tight"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', '"Cascadia Code"', 'Consolas', 'monospace'],
      },
      boxShadow: {
        // Sombras por token (frías y sutiles en light, casi nulas en dark → elevación por borde).
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
      transitionTimingFunction: {
        // "spring suave": overshoot mínimo, sensación fluida. Curva base del sistema de movimiento.
        // Lee el token en vez de repetir el literal: `--ease-smooth-out` (styles.css) es el MISMO
        // cubic-bezier(.22,1,.36,1), así que las recetas de transitions.dev y las ~40 clases
        // `ease-spring` ya repartidas por la app comparten un único valor.
        spring: 'var(--ease-smooth-out)',
      },
      transitionDuration: {
        // Duraciones por token, para poder escribir `duration-fast` en el JSX igual que en el CSS.
        stagger: 'var(--duration-stagger)',
        micro: 'var(--duration-micro)',
        quick: 'var(--duration-quick)',
        fast: 'var(--duration-fast)',
        medium: 'var(--duration-medium)',
        slow: 'var(--duration-slow)',
        'very-slow': 'var(--duration-very-slow)',
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
      },
      animation: { 'accordion-down': 'accordion-down 0.2s ease-out', 'accordion-up': 'accordion-up 0.2s ease-out' },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
