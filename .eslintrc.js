module.exports = {
  extends: 'eslint:recommended',
  rules: {
    strict: ['error', 'global'],
    quotes: ['error', 'single'],
    indent: ['error', 2]
  },
  env: {
    node: true,
    es2018: true,
  },
  parserOptions: {
    sourceType: 'script'
  }
}
