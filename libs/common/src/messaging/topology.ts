export const EVENTS_EXCHANGE = 'mini-croper.events';
export const DEAD_LETTER_EXCHANGE = 'mini-croper.events.dlx';
export const NOTIFICATIONS_QUEUE = 'notifications.events';
export const NOTIFICATIONS_DLQ = 'notifications.events.dlq';

/** Una entrega inicial y dos reentregas: 3 intentos antes de la DLQ. */
export const NOTIFICATIONS_DELIVERY_LIMIT = 2;

/** Routing keys a las que se enlaza la cola de notificaciones. El SPEC 10 añade las demás. */
export const NOTIFIABLE_EVENTS: readonly string[] = [
  'user.registered',
  'provider.approved',
  'provider.rejected',
  'payment.approved',
  'payment.declined',
  'order.confirmed',
  'order.cancelled',
];

/** Parte del canal de `amqplib` que usa `declareTopology` (permite simularlo en los specs). */
export interface TopologyChannel {
  assertExchange(
    exchange: string,
    type: string,
    options?: { durable?: boolean },
  ): Promise<unknown>;
  assertQueue(
    queue: string,
    options?: { durable?: boolean; arguments?: Record<string, unknown> },
  ): Promise<unknown>;
  bindQueue(
    queue: string,
    exchange: string,
    routingKey: string,
  ): Promise<unknown>;
}

/** Idempotente: la llaman `api` y `notifications` al conectar. */
export async function declareTopology(channel: TopologyChannel): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', {
    durable: true,
  });

  await channel.assertQueue(NOTIFICATIONS_DLQ, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(NOTIFICATIONS_DLQ, DEAD_LETTER_EXCHANGE, '');

  await channel.assertQueue(NOTIFICATIONS_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': NOTIFICATIONS_DELIVERY_LIMIT,
      'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
    },
  });
  for (const type of NOTIFIABLE_EVENTS) {
    await channel.bindQueue(NOTIFICATIONS_QUEUE, EVENTS_EXCHANGE, type);
  }
}
