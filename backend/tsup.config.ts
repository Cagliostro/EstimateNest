import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/**/*.ts'],
  outDir: 'dist',
  format: 'esm',
  target: 'node20',
  bundle: true,
  minify: false,
  sourcemap: true,
  clean: true,
  dts: false,
  external: ['aws-sdk'],
  noExternal: ['@estimatenest/shared'],
});
