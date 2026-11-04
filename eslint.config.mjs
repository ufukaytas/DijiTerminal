// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const NODE_BUILTINS = ['node:*', 'fs', 'fs/promises', 'path', 'os', 'child_process', 'crypto', 'events', 'url', 'util'];

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'fixtures/**', 'coverage/**', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': ['error', {
        paths: [{ name: 'electron', message: 'Renderer electron kullanamaz; window.diji API\'sini kullanın.' }],
        patterns: [{ group: NODE_BUILTINS, message: 'Renderer Node modülü kullanamaz.' }],
      }],
    },
  },
  {
    // src/shared saf TS: hem main hem renderer kullanır.
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: 'electron', message: 'src/shared içinde electron importu yasak.' }],
        patterns: [{ group: NODE_BUILTINS, message: 'src/shared içinde Node modülü yasak.' }],
      }],
    },
  },
  {
    // Motor saf Node kalmalı ki Electron olmadan test edilebilsin.
    files: ['src/main/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: 'electron', message: 'Motor (src/main/engine) electron import edemez.' }],
      }],
    },
  },
  {
    files: ['**/*.mjs', 'scripts/**/*.mjs', 'hooks/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
