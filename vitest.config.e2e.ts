import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['apps/**/*.e2e-spec.ts'],
    // bcrypt con costo 12 y MongoDB real: las pruebas tardan más que las unitarias.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
