import {
  notificationsQuerySchema,
  objectIdSchema,
} from '../dto/notifications.dto.js';

const ID = '64b7f0c2a1b2c3d4e5f60700';

describe('notificationsQuerySchema', () => {
  it('usa limit 20 por defecto y cursor opcional', () => {
    expect(notificationsQuerySchema.parse({})).toEqual({ limit: 20 });
  });

  it('acepta limit de 1 a 50 (como texto) y un cursor ObjectId', () => {
    expect(notificationsQuerySchema.parse({ limit: '50', cursor: ID })).toEqual(
      { limit: 50, cursor: ID },
    );
    expect(notificationsQuerySchema.parse({ limit: '1' }).limit).toBe(1);
  });

  it.each(['0', '51', '-3', 'abc', '2.5'])('rechaza limit %s', (limit) => {
    expect(notificationsQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('rechaza un cursor que no es ObjectId', () => {
    expect(notificationsQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(
      false,
    );
    expect(
      notificationsQuerySchema.safeParse({ cursor: { $ne: null } }).success,
    ).toBe(false);
  });

  it('rechaza userId, storeId y cualquier propiedad de más', () => {
    for (const extra of [{ userId: ID }, { storeId: ID }, { page: 1 }]) {
      expect(notificationsQuerySchema.safeParse(extra).success).toBe(false);
    }
  });
});

describe('objectIdSchema', () => {
  it('acepta 24 hex y rechaza el resto', () => {
    expect(objectIdSchema.safeParse(ID).success).toBe(true);
    expect(objectIdSchema.safeParse('123').success).toBe(false);
  });
});
