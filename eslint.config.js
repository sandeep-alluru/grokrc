/**
 * Flat ESLint config.
 *
 * Deliberately biased toward *correctness*, not style — Prettier owns
 * formatting, so rules here are the ones that catch real defects. Several bugs
 * shipped in this project (a swallowed promise rejection, an unchecked index)
 * are exactly the class these guard.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'docs/captures/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A rejected promise nobody awaits took down a daemon once already.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // `any` is a deliberate escape hatch in a few protocol boundaries; warn so
      // it stays visible without blocking the build.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': 'off', // this is a CLI; console IS the interface
    },
  },

  {
    // Browser client: plain ESM, no TS project.
    files: ['web/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.serviceworker },
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  {
    // Test and tooling scripts: looser, they are not shipped.
    //
    // Browser globals are included because these drive Playwright — the bodies
    // of `page.evaluate()` are serialised and run inside Chromium, so `document`
    // and friends are legitimately in scope even though the file runs in Node.
    files: ['test/**/*.ts', 'tools/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  }
);
