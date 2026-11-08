/** Respuesta paginada: `{ data, page, limit, total }`. */
export type Page<T> = { data: T[]; page: number; limit: number; total: number };

export const toPage = <T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): Page<T> => ({ data, page, limit, total });

/** Documentos a saltar para la página `page` (empieza en 1). */
export const skipFor = (page: number, limit: number): number =>
  (page - 1) * limit;
