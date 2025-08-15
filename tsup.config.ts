import { defineConfig } from 'tsup';
import { dependencies } from './package.json';

export default defineConfig({
  entry: ['src/index.ts'],
  splitting: false,
  sourcemap: false,
  clean: true,
  noExternal: [...Object.keys(dependencies)],
});
