import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['apps/**/*.e2e-spec.ts'],
    // Las suites comparten MongoDB, el outbox del puente y las colas de RabbitMQ: en paralelo
    // el publicador de una suite publicaría los eventos de otra.
    fileParallelism: false,
    // bcrypt con costo 12 y MongoDB real: las pruebas tardan más que las unitarias.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
