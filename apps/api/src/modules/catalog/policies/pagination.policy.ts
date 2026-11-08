/** Página de resultados, con la misma forma que `GET /auth/users`. */
export type Page<T> = {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export const toPage = <T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): Page<T> => ({
  data,
  page,
  limit,
  total,
  totalPages: Math.ceil(total / limit),
});
