export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        card: 'var(--card-bg)',
        'card-border': 'var(--card-border)',
        'app-bg': 'var(--body-bg)',
        'app-text': 'var(--body-text)',
      },
      borderRadius: { card: 'var(--card-radius)' },
      boxShadow: { card: 'var(--card-shadow)' },
    }
  },
  plugins: []
}
