import type { WireEvent } from '../../../../libs/common/src/messaging/domain-event.schema.js';
import {
  formatCop,
  InvalidEventPayloadError,
  requireMonto,
  requireObjectId,
  requireObjectIdList,
} from './payload.js';

const ID_A = '64b7f0c2a1b2c3d4e5f60718';
const ID_B = '64b7f0c2a1b2c3d4e5f60719';

const event = (payload: Record<string, unknown>): WireEvent => ({
  eventId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  type: 'order.confirmed',
  occurredAt: '2026-11-09T10:00:00.000Z',
  correlationId: ID_A,
  payload,
});

describe('requireObjectId', () => {
  it('devuelve un ObjectId válido', () => {
    expect(requireObjectId(event({ id: ID_A }), 'id')).toBe(ID_A);
  });

  it.each([undefined, 5, 'corto', 'z'.repeat(24), `${ID_A}0`])(
    'lanza con %s',
    (id) => {
      expect(() => requireObjectId(event({ id }), 'id')).toThrow(
        InvalidEventPayloadError,
      );
    },
  );
});

describe('requireObjectIdList', () => {
  it('acepta una lista de ids válidos y distintos', () => {
    expect(requireObjectIdList(event({ ids: [ID_A, ID_B] }), 'ids')).toEqual([
      ID_A,
      ID_B,
    ]);
  });

  it.each([
    [undefined],
    ['no-lista'],
    [[]],
    [[ID_A, 'malo']],
    [[ID_A, ID_A]],
    [[ID_A, 5]],
  ])('lanza con %j', (ids) => {
    expect(() => requireObjectIdList(event({ ids }), 'ids')).toThrow(
      InvalidEventPayloadError,
    );
  });
});

describe('requireMonto', () => {
  it.each([0, 5000])('acepta %s', (monto) => {
    expect(requireMonto(event({ monto }), 'monto')).toBe(monto);
  });

  it.each([-1, 10.5, '5000', undefined, Number.NaN])(
    'lanza con %s',
    (monto) => {
      expect(() => requireMonto(event({ monto }), 'monto')).toThrow(
        InvalidEventPayloadError,
      );
    },
  );
});

describe('formatCop', () => {
  it('formatea con puntos de miles y sin decimales', () => {
    expect(formatCop(1250000)).toBe('$1.250.000');
    expect(formatCop(0)).toBe('$0');
    expect(formatCop(900)).toBe('$900');
  });
});
