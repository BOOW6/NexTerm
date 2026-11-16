/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-color-scheme="dark"]'],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        'background-alt': 'hsl(var(--background-alt))',
        foreground: 'hsl(var(--foreground))',
        surface: {
          DEFAULT: 'hsl(var(--surface))',
          elevated: 'hsl(var(--surface-elevated))',
          header: 'hsl(var(--surface-header))',
          hover: 'hsl(var(--surface-hover))',
          active: 'hsl(var(--surface-active))'
        },
        border: {
          DEFAULT: 'hsl(var(--border))',
          muted: 'hsl(var(--border-muted))',
          strong: 'hsl(var(--border-strong))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          strong: 'hsl(var(--accent-strong))',
          soft: 'hsl(var(--accent-soft))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        link: {
          DEFAULT: 'hsl(var(--link))',
          hover: 'hsl(var(--link-hover))'
        },
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        error: 'hsl(var(--error))',
        'focus-ring': 'hsl(var(--focus-ring))',
        'table-header': 'hsl(var(--table-header))',
        'row-hover': 'hsl(var(--row-hover))',
        'row-selected': 'hsl(var(--row-selected))',
        header: {
          DEFAULT: 'hsl(var(--header-foreground))',
          muted: 'hsl(var(--header-muted))'
        }
      },
      borderRadius: {
        DEFAULT: 'var(--radius-sm)',
        lg: 'var(--radius-lg)',
        md: 'var(--radius-md)',
        sm: 'var(--radius-sm)'
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        popup: 'var(--shadow-popup)',
        inset: 'var(--shadow-inset)',
        pressed: 'var(--shadow-button-pressed)'
      },
      backgroundImage: {
        'header-gradient': 'var(--gradient-header)',
        'panel-title': 'var(--gradient-panel-title)',
        button: 'var(--gradient-button)',
        'button-hover': 'var(--gradient-button-hover)',
        'button-primary': 'var(--gradient-button-primary)'
      },
      fontFamily: {
        sans: ['var(--font-ui)'],
        mono: ['var(--font-mono)']
      },
      // Typography and spacing are layout, not theme: every value below points
      // at layout-tokens.css, which no theme may override. Components should
      // use the named utilities (`text-meta`, `font-emphasis`, `gap-md`)
      // instead of arbitrary values like `text-[11px]` so density changes stay
      // in one place.
      fontSize: {
        micro: ['var(--text-micro)', { lineHeight: 'var(--leading-tight)' }],
        tiny: ['var(--text-tiny)', { lineHeight: 'var(--leading-tight)' }],
        meta: ['var(--text-meta)', { lineHeight: 'var(--leading-normal)' }],
        body: ['var(--text-body)', { lineHeight: 'var(--leading-normal)' }],
        'body-lg': ['var(--text-body-lg)', { lineHeight: 'var(--leading-normal)' }]
      },
      fontWeight: {
        normal: 'var(--font-weight-normal)',
        medium: 'var(--font-weight-medium)',
        emphasis: 'var(--font-weight-emphasis)'
      },
      letterSpacing: {
        tight: 'var(--tracking-tight)',
        wide: 'var(--tracking-wide)'
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        'zoom-in': {
          from: { opacity: '0', transform: 'translateY(2px) scale(0.99)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' }
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        }
      },
      animation: {
        'fade-in': 'fade-in 100ms ease-out',
        'zoom-in': 'zoom-in 120ms ease-out',
        'slide-in': 'slide-in 120ms ease-out'
      }
    }
  },
  plugins: []
};
