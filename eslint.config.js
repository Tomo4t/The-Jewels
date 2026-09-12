import js from '@eslint/js';
import globals from 'globals';

const shared = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'data/**', 'content/**'],
  },
  js.configs.recommended,

  // Browser code: ES modules bundled by Vite.
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: { ...shared, 'no-console': ['warn', { allow: ['warn', 'error'] }] },
  },

  // Classic scripts served straight from public/ (no bundler, no modules).
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2019,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: { ...shared },
  },

  // Server code and build config.
  {
    files: ['server/**/*.js', '*.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { ...shared },
  },
];
