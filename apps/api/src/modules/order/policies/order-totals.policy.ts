/** Cálculo puro de subtotales y total (enteros en COP, sin decimales). */

export type PricedLine = {
  storeId: string;
  precioUnitario: number;
  cantidad: number;
};

export type StoreSubtotal = { storeId: string; subtotal: number };

export function lineSubtotal(
  line: Pick<PricedLine, 'precioUnitario' | 'cantidad'>,
): number {
  return line.precioUnitario * line.cantidad;
}

/** Un subtotal por tienda, en el orden en que aparece cada tienda. */
export function subtotalsByStore(lines: PricedLine[]): StoreSubtotal[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(
      line.storeId,
      (totals.get(line.storeId) ?? 0) + lineSubtotal(line),
    );
  }
  return [...totals].map(([storeId, subtotal]) => ({ storeId, subtotal }));
}

/** Total del pedido: suma de los subtotales de sus `SubOrder`. */
export function orderTotal(
  subtotals: Pick<StoreSubtotal, 'subtotal'>[],
): number {
  return subtotals.reduce((sum, s) => sum + s.subtotal, 0);
}
