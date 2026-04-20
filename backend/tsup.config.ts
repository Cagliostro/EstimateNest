import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/handlers/*.ts', 'src/local-server.ts'],
  outDir: 'dist',
  format: 'cjs',
  target: 'node20',
  bundle: true,
  splitting: false,
  minify: false,
  sourcemap: true,
  clean: true,
  dts: false,
  external: ['aws-sdk'],
  noExternal: ['@estimatenest/shared'],
  outExtension: () => ({ js: '.js' }),
});
