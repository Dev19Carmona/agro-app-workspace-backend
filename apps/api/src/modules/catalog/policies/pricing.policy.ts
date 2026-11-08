/**
 * Reglas puras de precio y disponibilidad (sin Nest). Los precios son enteros
 * en COP.
 */

export type PricedVariant = {
  precio: number;
  precioOferta?: number | null;
  stock: number;
  stockReservado: number;
  activo: boolean;
};

export type SellableProduct = { activo: boolean; requiresQuote: boolean };
export type SellableStore = { activa: boolean };

/** Precio de oferta si existe; si no, el precio base. */
export function precioVigente(
  variant: Pick<PricedVariant, 'precio' | 'precioOferta'>,
): number {
  return variant.precioOferta ?? variant.precio;
}

/** Stock libre para vender: nunca negativo. */
export function disponible(
  variant: Pick<PricedVariant, 'stock' | 'stockReservado'>,
): number {
  return Math.max(variant.stock - variant.stockReservado, 0);
}

/** Apta para el checkout: todo activo y sin cotización. */
export function esApta(
  variant: Pick<PricedVariant, 'activo'>,
  product: SellableProduct,
  store: SellableStore,
): boolean {
  return (
    variant.activo && product.activo && store.activa && !product.requiresQuote
  );
}
