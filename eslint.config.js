import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  // Base JS recommended
  js.configs.recommended,

  // TypeScript recommended
  ...tseslint.configs.recommended,

  // Global settings
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
  },

  // React hooks plugin — only enable the two pre-compiler rules.
  // The v7 "recommended" preset also enables React Compiler lint rules
  // (immutability, set-state-in-effect, etc.) that produce false positives
  // on valid code when the React Compiler is not in use.
  {
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Project-specific rules
  {
    rules: {
      // Unused vars — errors except for underscore-prefixed (common TS pattern)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // no-explicit-any as warn — Cesium APIs legitimately require any
      '@typescript-eslint/no-explicit-any': 'warn',

      // Console — warn on debug logs, allow operational output
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],

      // Prefer const
      'prefer-const': 'error',

      // no-var is covered by recommended but make it explicit
      'no-var': 'error',
    },
  },

  // Test files — relax some rules
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Renderer seam (docs/architecture/VELO-V2-BLUEPRINT.md §P1.2): the ride
  // domain and world data stay renderer-agnostic. Engines live under
  // src/renderers/* and are reached only through lib/world/renderer.ts.
  // src/test/architecture.test.ts checks the transitive closure too.
  {
    files: ['src/lib/ride/**/*.{ts,tsx}', 'src/lib/world/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['cesium', 'cesium/*'],
              message: 'lib/ride and lib/world are renderer-agnostic: no Cesium. Put engine code in src/renderers/cesium.',
            },
            {
              group: ['three', 'three/*', '@react-three/*', 'postprocessing'],
              message: 'lib/ride and lib/world are renderer-agnostic: no three.js. Put engine code in src/renderers/three.',
            },
            {
              group: ['@/renderers/*', '**/renderers/*', '@/lib/cesium*', '**/cesiumUtils', '**/cesiumHDR'],
              message: 'lib/ride and lib/world must not depend on a renderer; renderers depend on them.',
            },
          ],
        },
      ],
    },
  },

  // Ignore build output, configs, and generated files
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/**',
      'scripts/**',
      'postcss.config.js',
      'tailwind.config.ts',
      'vite.config.ts',
      'vitest.config.ts',
    ],
  },
);
