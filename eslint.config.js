import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'dist-demo/**', 'node_modules/**', 'artifacts/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
  // console is here because the performance tests print their measurements: those numbers are the
  // recorded baseline the bounds are set from, so a run that prints nothing is a run that leaves no
  // record to compare against.
  {
    files: ['tests/**/*.mjs'],
    languageOptions: { globals: { structuredClone: 'readonly', console: 'readonly' } },
  },
  {
    files: ['examples/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
