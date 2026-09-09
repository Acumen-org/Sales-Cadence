import type { Config } from 'tailwindcss';

/**
 * Cadence: warm paper, deep ink and a restrained evergreen accent.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#edf7f3',
          100: '#d8eee5',
          200: '#b3ddcc',
          300: '#82c4ac',
          400: '#50a68b',
          500: '#2f8a70',
          600: '#24735e',
          700: '#205c4d',
          800: '#1d4a3f',
          900: '#193e35',
          950: '#102b26',
        },
        canvas: '#f5f6f4',
        ink: {
          900: '#192b29',
          800: '#2b3c39',
          700: '#40514d',
          600: '#576661',
          500: '#65736e',
          400: '#73817a',
          300: '#a4afa8',
          200: '#d5ddd7',
        },
        line: '#e3e8e2',
      },
      borderRadius: {
        xl: '12px',
        '2xl': '16px',
      },
      boxShadow: {
        surface: '0 2px 3px -2px rgba(25, 43, 41, 0.06)',
        pop: '0 20px 60px -12px rgba(25, 43, 41, 0.22)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
