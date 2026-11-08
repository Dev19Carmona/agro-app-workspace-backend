import {
  DEAD_LETTER_EXCHANGE,
  declareTopology,
  EVENTS_EXCHANGE,
  NOTIFIABLE_EVENTS,
  NOTIFICATIONS_DLQ,
  NOTIFICATIONS_QUEUE,
} from './topology.js';

function fakeChannel() {
  return {
    assertExchange: vi.fn().mockResolvedValue({}),
    assertQueue: vi.fn().mockResolvedValue({}),
    bindQueue: vi.fn().mockResolvedValue({}),
  };
}

describe('declareTopology', () => {
  it('declara el exchange topic y el DLX fanout, ambos durables', async () => {
    const ch = fakeChannel();
    await declareTopology(ch);
    expect(ch.assertExchange).toHaveBeenCalledWith(EVENTS_EXCHANGE, 'topic', {
      durable: true,
    });
    expect(ch.assertExchange).toHaveBeenCalledWith(
      DEAD_LETTER_EXCHANGE,
      'fanout',
      {
        durable: true,
      },
    );
  });

  it('declara la cola quorum con límite de entregas y DLX', async () => {
    const ch = fakeChannel();
    await declareTopology(ch);
    expect(ch.assertQueue).toHaveBeenCalledWith(NOTIFICATIONS_QUEUE, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': 2,
        'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      },
    });
  });

  it('declara la DLQ quorum y la enlaza al DLX', async () => {
    const ch = fakeChannel();
    await declareTopology(ch);
    expect(ch.assertQueue).toHaveBeenCalledWith(NOTIFICATIONS_DLQ, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    expect(ch.bindQueue).toHaveBeenCalledWith(
      NOTIFICATIONS_DLQ,
      DEAD_LETTER_EXCHANGE,
      '',
    );
  });

  it('enlaza la cola una vez por cada evento notificable', async () => {
    const ch = fakeChannel();
    await declareTopology(ch);
    for (const type of NOTIFIABLE_EVENTS) {
      expect(ch.bindQueue).toHaveBeenCalledWith(
        NOTIFICATIONS_QUEUE,
        EVENTS_EXCHANGE,
        type,
      );
    }
    const mainBinds = ch.bindQueue.mock.calls.filter(
      ([q]) => q === NOTIFICATIONS_QUEUE,
    );
    expect(mainBinds).toHaveLength(NOTIFIABLE_EVENTS.length);
  });

  it('es idempotente: dos llamadas repiten las mismas declaraciones', async () => {
    const ch = fakeChannel();
    await declareTopology(ch);
    const first = [...ch.assertQueue.mock.calls];
    await declareTopology(ch);
    expect(ch.assertQueue.mock.calls.slice(first.length)).toEqual(first);
  });
});
