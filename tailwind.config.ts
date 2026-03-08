import type { Config } from 'tailwindcss'

// =============================================================================
// DESIGN SYSTEM — Single source of truth for all visual tokens.
// Change anything here and it propagates everywhere.
// =============================================================================

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',

  theme: {
    fontFamily: {
      sans: [
        '-apple-system',
        'BlinkMacSystemFont',
        '"Segoe UI"',
        'Roboto',
        'Helvetica',
        'Arial',
        'sans-serif',
      ],
      mono: [
        'ui-monospace',
        'SFMono-Regular',
        '"SF Mono"',
        'Menlo',
        'Consolas',
        'monospace',
      ],
    },

    fontSize: {
      xs: ['0.6875rem', { lineHeight: '1rem' }],      // 11px
      sm: ['0.75rem', { lineHeight: '1.125rem' }],     // 12px
      base: ['0.8125rem', { lineHeight: '1.25rem' }],  // 13px
      lg: ['0.875rem', { lineHeight: '1.375rem' }],    // 14px
      xl: ['1rem', { lineHeight: '1.5rem' }],           // 16px
      '2xl': ['1.25rem', { lineHeight: '1.75rem' }],    // 20px
    },

    extend: {
      colors: {
        surface: {
          0: 'var(--surface-0)',
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
        },
        border: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
          inverse: 'var(--text-inverse)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          muted: 'var(--accent-muted)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          muted: 'var(--destructive-muted)',
        },
        success: {
          DEFAULT: 'var(--success)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
        },
      },

      spacing: {
        '0.5': '0.125rem',  // 2px
        '1.5': '0.375rem',  // 6px
        '2.5': '0.625rem',  // 10px
      },

      borderRadius: {
        none: '0px',
        sm: '2px',
        DEFAULT: '4px',
        md: '6px',
      },

      transitionDuration: {
        fast: '80ms',
        DEFAULT: '100ms',
        slow: '200ms',
      },

      animation: {
        'fade-in': 'fadeIn 150ms ease-out',
        'slide-up': 'slideUp 150ms ease-out',
        'slide-down': 'slideDown 150ms ease-out',
      },

      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          from: { opacity: '0', transform: 'translateY(-4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },

  plugins: [],
} satisfies Config
