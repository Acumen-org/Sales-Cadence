import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff',
          100: '#d9e5ff',
          200: '#bcd1ff',
          300: '#8eb3ff',
          400: '#5a89ff',
          500: '#345fff',
          600: '#1f3ff5',
          700: '#172ee1',
          800: '#1927b6',
          900: '#1b278f',
          950: '#141957',
        },
      },
    },
  },
  plugins: [],
};

export default config;
