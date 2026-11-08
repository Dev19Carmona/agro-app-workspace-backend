import { z } from 'zod';

/** Sobre que viaja por RabbitMQ (el `DomainEvent` de las reglas de negocio). */
export const domainEventSchema = z.strictObject({
  /** uuid v4; estable ante reenvíos. */
  eventId: z.uuid(),
  /** Routing key, p. ej. `provider.approved`. */
  type: z.string().min(1),
  /** ISO 8601. */
  occurredAt: z.iso.datetime(),
  /** Id del pedido o, en eventos de auth, el userId. */
  correlationId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export type WireEvent = z.infer<typeof domainEventSchema>;
