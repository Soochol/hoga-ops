import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '.vite-cache', 'test-results', 'playwright-report']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // The app uses React 18 without React Compiler, including deliberate
      // incremental render caches. Keep compiler migration diagnostics visible
      // while enforcing Rules of Hooks and exhaustive-deps at their preset levels.
      ...Object.fromEntries(Object.keys(reactHooks.configs.flat.recommended.rules)
        .filter(name => !['react-hooks/rules-of-hooks', 'react-hooks/exhaustive-deps'].includes(name))
        .map(name => [name, 'warn'])),
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
])
