import {
  actorBodySchema,
  actorQuerySchema,
  listQuerySchema,
  objectIdSchema,
} from './internal-notifications.dto.js';

const USER = '64b7f0c2a1b2c3d4e5f60718';
const STORE = '64b7f0c2a1b2c3d4e5f60719';

describe('listQuerySchema', () => {
  it('aplica limit 20 por defecto y storeId/cursor opcionales', () => {
    expect(listQuerySchema.parse({ userId: USER })).toEqual({
      userId: USER,
      limit: 20,
    });
  });

  it('convierte limit de texto a número', () => {
    expect(listQuerySchema.parse({ userId: USER, limit: '50' }).limit).toBe(50);
  });

  it.each(['0', '51', '-1', 'abc', '1.5'])('rechaza limit %s', (limit) => {
    expect(listQuerySchema.safeParse({ userId: USER, limit }).success).toBe(
      false,
    );
  });

  it('rechaza userId, storeId o cursor que no son ObjectId', () => {
    expect(listQuerySchema.safeParse({ userId: 'x' }).success).toBe(false);
    expect(
      listQuerySchema.safeParse({ userId: USER, storeId: 'x' }).success,
    ).toBe(false);
    expect(
      listQuerySchema.safeParse({ userId: USER, cursor: '123' }).success,
    ).toBe(false);
  });

  it('rechaza propiedades de más y operadores de Mongo', () => {
    expect(listQuerySchema.safeParse({ userId: USER, otro: 1 }).success).toBe(
      false,
    );
    expect(listQuerySchema.safeParse({ userId: { $ne: null } }).success).toBe(
      false,
    );
  });

  it('exige userId', () => {
    expect(listQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('actorQuerySchema y actorBodySchema', () => {
  it.each([actorQuerySchema, actorBodySchema])(
    'aceptan userId y storeId opcional',
    (schema) => {
      expect(schema.parse({ userId: USER, storeId: STORE })).toEqual({
        userId: USER,
        storeId: STORE,
      });
      expect(schema.parse({ userId: USER })).toEqual({ userId: USER });
    },
  );

  it.each([actorQuerySchema, actorBodySchema])(
    'rechazan propiedades de más e ids inválidos',
    (schema) => {
      expect(schema.safeParse({ userId: USER, limit: 5 }).success).toBe(false);
      expect(schema.safeParse({ userId: 'no-es-id' }).success).toBe(false);
    },
  );
});

describe('objectIdSchema', () => {
  it('acepta 24 hex y rechaza el resto', () => {
    expect(objectIdSchema.safeParse(USER).success).toBe(true);
    expect(objectIdSchema.safeParse(`${USER}0`).success).toBe(false);
    expect(objectIdSchema.safeParse('zzzzzzzzzzzzzzzzzzzzzzzz').success).toBe(
      false,
    );
  });
});
