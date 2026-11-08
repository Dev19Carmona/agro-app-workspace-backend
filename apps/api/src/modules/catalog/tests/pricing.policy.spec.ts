import {
  disponible,
  esApta,
  precioVigente,
} from '../policies/pricing.policy.js';

describe('pricing.policy', () => {
  describe('precioVigente', () => {
    it('usa el precio de oferta si existe', () => {
      expect(precioVigente({ precio: 100, precioOferta: 80 })).toBe(80);
    });

    it('usa el precio base si no hay oferta', () => {
      expect(precioVigente({ precio: 100 })).toBe(100);
      expect(precioVigente({ precio: 100, precioOferta: null })).toBe(100);
    });
  });

  describe('disponible', () => {
    it('resta lo reservado del stock', () => {
      expect(disponible({ stock: 10, stockReservado: 4 })).toBe(6);
    });

    it('nunca es negativo', () => {
      expect(disponible({ stock: 3, stockReservado: 5 })).toBe(0);
    });

    it('es 0 cuando stock iguala lo reservado', () => {
      expect(disponible({ stock: 5, stockReservado: 5 })).toBe(0);
    });
  });

  describe('esApta', () => {
    const variant = { activo: true };
    const product = { activo: true, requiresQuote: false };
    const store = { activa: true };

    it('es apta cuando todo está activo y no requiere cotización', () => {
      expect(esApta(variant, product, store)).toBe(true);
    });

    it('no es apta si requiresQuote', () => {
      expect(esApta(variant, { ...product, requiresQuote: true }, store)).toBe(
        false,
      );
    });

    it('no es apta si variante, producto o tienda están inactivos', () => {
      expect(esApta({ activo: false }, product, store)).toBe(false);
      expect(esApta(variant, { ...product, activo: false }, store)).toBe(false);
      expect(esApta(variant, product, { activa: false })).toBe(false);
    });
  });
});
