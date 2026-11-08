/** Error de clave duplicada de Mongo (índice único, código 11000). */
export const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 11000;
