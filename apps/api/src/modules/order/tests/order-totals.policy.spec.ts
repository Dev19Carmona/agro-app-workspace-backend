import {
  lineSubtotal,
  orderTotal,
  subtotalsByStore,
} from '../policies/order-totals.policy.js';

describe('order-totals.policy', () => {
  it('calcula el subtotal de una línea', () => {
    expect(lineSubtotal({ precioUnitario: 1500, cantidad: 3 })).toBe(4500);
  });

  it('agrupa subtotales por tienda', () => {
    const result = subtotalsByStore([
      { storeId: 'a', precioUnitario: 100, cantidad: 2 },
      { storeId: 'b', precioUnitario: 50, cantidad: 1 },
      { storeId: 'a', precioUnitario: 10, cantidad: 5 },
    ]);
    expect(result).toEqual([
      { storeId: 'a', subtotal: 250 },
      { storeId: 'b', subtotal: 50 },
    ]);
  });

  it('con una sola tienda devuelve un solo subtotal', () => {
    expect(
      subtotalsByStore([{ storeId: 'a', precioUnitario: 100, cantidad: 1 }]),
    ).toHaveLength(1);
  });

  it('el total es la suma de los subtotales', () => {
    expect(orderTotal([{ subtotal: 250 }, { subtotal: 50 }])).toBe(300);
    expect(orderTotal([])).toBe(0);
  });
});
