import { defineConfig } from 'tsup';
import { dependencies } from './package.json';

export default defineConfig({
  entry: ['src/index.ts'],
  splitting: false,
  sourcemap: false,
  format: ['cjs'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  clean: true,
  minify: true,
  noExternal: [...Object.keys(dependencies)],
});
