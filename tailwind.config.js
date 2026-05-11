/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/views/**/*.ejs',
    './public/**/*.html',
  ],
  theme: {
    extend: {
      colors: {
        purple: {
          950: '#3D0046',
          900: '#5A0064',
          800: '#6B1A75',
          700: '#7D3386',
          600: '#8E4D97',
          500: '#A066A8',
          400: '#B280B9',
          300: '#C499CA',
          200: '#D6B3DB',
          100: '#E8CCEC',
          50:  '#F5E6F7',
        },
        neon: {
          lime:      '#E8FF00',
          'lime-dark': '#C8DB00',
          'lime-glow': 'rgba(232, 255, 0, 0.3)',
        },
        surface: {
          card:     '#6B1A75',
          elevated: '#7D3386',
          overlay:  'rgba(61, 0, 70, 0.8)',
        },
        text: {
          primary:   '#FFFFFF',
          secondary: '#D6B3DB',
          muted:     '#B280B9',
          accent:    '#E8FF00',
        },
        state: {
          success: '#22C55E',
          warning: '#F59E0B',
          danger:  '#EF4444',
          info:    '#3B82F6',
        },
      },

      fontFamily: {
        display: ['"Brush Up"', 'cursive'],
        body:    ['Poppins', 'system-ui', 'sans-serif'],
        label:   ['Poppins', 'system-ui', 'sans-serif'],
      },

      fontSize: {
        'xs':   ['0.75rem',  { lineHeight: '1rem' }],
        'sm':   ['0.875rem', { lineHeight: '1.25rem' }],
        'base': ['1rem',     { lineHeight: '1.5rem' }],
        'lg':   ['1.125rem', { lineHeight: '1.75rem' }],
        'xl':   ['1.25rem',  { lineHeight: '1.75rem' }],
        '2xl':  ['1.5rem',   { lineHeight: '2rem' }],
        '3xl':  ['1.875rem', { lineHeight: '2.25rem' }],
        '4xl':  ['2.25rem',  { lineHeight: '2.5rem' }],
        '5xl':  ['3rem',     { lineHeight: '1.1' }],
        '6xl':  ['3.75rem',  { lineHeight: '1.1' }],
      },

      borderRadius: {
        'xs':  '4px',
        'sm':  '6px',
        'md':  '8px',
        'lg':  '12px',
        'xl':  '16px',
        '2xl': '20px',
        '3xl': '24px',
      },

      boxShadow: {
        'card':     '0 4px 24px rgba(0, 0, 0, 0.3)',
        'card-lg':  '0 8px 40px rgba(0, 0, 0, 0.4)',
        'neon-sm':  '0 0 10px rgba(232, 255, 0, 0.2)',
        'neon':     '0 0 20px rgba(232, 255, 0, 0.3)',
        'neon-lg':  '0 0 40px rgba(232, 255, 0, 0.4)',
        'inner':    'inset 0 2px 4px rgba(0, 0, 0, 0.2)',
      },

      spacing: {
        '18': '4.5rem',
        '22': '5.5rem',
        '30': '7.5rem',
      },

      animation: {
        'fade-in':     'fadeIn 0.4s ease-out',
        'slide-up':    'slideUp 0.4s ease-out',
        'scale-in':    'scaleIn 0.2s ease-out',
        'glow-pulse':  'glowPulse 2s ease-in-out infinite',
      },

      keyframes: {
        fadeIn: {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%':   { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%':   { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        glowPulse: {
          '0%, 100%': { boxShadow: '0 0 10px rgba(232, 255, 0, 0.2)' },
          '50%':      { boxShadow: '0 0 30px rgba(232, 255, 0, 0.5)' },
        },
      },

      transitionDuration: {
        '250': '250ms',
        '350': '350ms',
      },
    },
  },
  plugins: [],
};
