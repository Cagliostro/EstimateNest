/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Primary accent color: deep teal (from design spec)
        primary: {
          50: '#f0fdfa',
          100: '#ccfbf1',
          200: '#99f6e4',
          300: '#5eead4',
          400: '#2dd4bf',
          500: '#14b8a6', // Base teal
          600: '#0d9488', // Deep teal
          700: '#0f766e',
          800: '#115e59',
          900: '#134e4a',
        },
        // Neutral surfaces
        neutral: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
        },
      },
      spacing: {
        // 8px rhythm (design spec)
        'rhythm-1': '0.5rem',  // 8px
        'rhythm-2': '1rem',    // 16px
        'rhythm-3': '1.5rem',  // 24px
        'rhythm-4': '2rem',    // 32px
        'rhythm-5': '2.5rem',  // 40px
        'rhythm-6': '3rem',    // 48px
      },
      borderRadius: {
        'xl': '0.75rem',
        '2xl': '1rem',
      },
      fontFamily: {
        // Clean, product-like typography (Linear, Notion style)
        'sans': ['Inter', 'system-ui', 'sans-serif'],
        'mono': ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
  darkMode: 'media', // Use prefers-color-scheme
}