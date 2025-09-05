/**
 * @filename: lint-staged.config.js
 * @type {import('lint-staged').Configuration}
 */
export default {
  'src/**/*.{ts}': ['pnpm format', 'pnpm check'],
};
