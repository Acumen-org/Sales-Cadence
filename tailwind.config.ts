import type { Config } from 'tailwindcss';

/**
 * Outreach-like palette: lavender canvas, indigo primary, soft indigo pills, green "active" dots.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f1f1fc',
          100: '#e4e4f8',
          200: '#cdcdf2',
          300: '#a9a9e8',
          400: '#8384dc',
          500: '#6b6ad3',
          600: '#5b5fd6',
          700: '#4c4dbd',
          800: '#3f4099',
          900: '#35367b',
          950: '#20204a',
        },
        canvas: '#f3f4fa',
        ink: {
          900: '#1f2333',
          800: '#2b3044',
          700: '#3b4054',
          600: '#535a70',
          500: '#6b7186',
          400: '#8b90a3',
          300: '#b6bac8',
          200: '#d7dae4',
        },
        line: '#e6e7ef',
      },
      borderRadius: {
        xl: '14px',
        '2xl': '18px',
      },
      boxShadow: {
        surface: '0 1px 2px rgba(31, 35, 51, 0.04), 0 4px 16px rgba(31, 35, 51, 0.04)',
        pop: '0 8px 24px rgba(31, 35, 51, 0.12)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
