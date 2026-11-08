import { domainEventSchema } from './domain-event.schema.js';

const valid = {
  eventId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  type: 'provider.approved',
  occurredAt: '2026-11-08T10:00:00.000Z',
  correlationId: '64b7f0c2a1b2c3d4e5f60718',
  payload: { userId: '64b7f0c2a1b2c3d4e5f60718' },
};

describe('domainEventSchema', () => {
  it('acepta un evento válido', () => {
    expect(domainEventSchema.parse(valid)).toEqual(valid);
  });

  it('rechaza propiedades de más', () => {
    expect(domainEventSchema.safeParse({ ...valid, extra: 1 }).success).toBe(
      false,
    );
  });

  it('rechaza un eventId que no es uuid', () => {
    expect(
      domainEventSchema.safeParse({ ...valid, eventId: 'abc' }).success,
    ).toBe(false);
  });

  it('rechaza un type vacío', () => {
    expect(domainEventSchema.safeParse({ ...valid, type: '' }).success).toBe(
      false,
    );
  });

  it.each([null, 'texto', 5, [1]])(
    'rechaza un payload que no es objeto (%j)',
    (payload) => {
      expect(domainEventSchema.safeParse({ ...valid, payload }).success).toBe(
        false,
      );
    },
  );
});
