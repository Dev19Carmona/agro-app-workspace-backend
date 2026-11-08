import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import {
  domainEventSchema,
  type WireEvent,
} from '../../../../libs/common/src/messaging/domain-event.schema.js';
import { RabbitMqConnection } from '../../../../libs/common/src/messaging/rabbitmq-connection.js';
import {
  declareTopology,
  NOTIFICATIONS_QUEUE,
} from '../../../../libs/common/src/messaging/topology.js';
import { NotificationsService } from '../services/notifications.service.js';
import { getTemplate } from '../templates/notification-templates.js';

export const CONSUMER_PREFETCH = 10;
/** Intentos totales antes de la DLQ (la entrega inicial y dos reentregas). */
export const MAX_DELIVERIES = 3;

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 11000;

/**
 * Consume `notifications.events` con ack manual: el mensaje se confirma solo después de
 * guardar el aviso. Los logs llevan `eventId` y `type`, nunca el payload.
 */
@Injectable()
export class EventsConsumer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(EventsConsumer.name);

  constructor(
    private readonly connection: RabbitMqConnection,
    private readonly notifications: NotificationsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Se ejecuta en la primera conexión y en cada reconexión (vuelve a suscribirse).
    this.connection.onConnect(async (channel) => {
      await declareTopology(channel);
      await channel.prefetch(CONSUMER_PREFETCH);
      await channel.consume(
        NOTIFICATIONS_QUEUE,
        (msg) => {
          if (msg) void this.handleMessage(channel, msg);
        },
        { noAck: false },
      );
    });
    await this.connection.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }

  async handleMessage(
    channel: ConfirmChannel,
    msg: ConsumeMessage,
  ): Promise<void> {
    const event = this.parse(msg);
    if (!event) {
      // JSON o sobre inválido: reintentar no lo arregla, va directo a la DLQ.
      this.logger.error('Mensaje inválido: se envía a la DLQ');
      this.settle(() => channel.nack(msg, false, false));
      return;
    }

    if (!getTemplate(event.type)) {
      this.logger.warn(`Evento ${event.type} sin plantilla: se confirma`);
      this.settle(() => channel.ack(msg));
      return;
    }

    try {
      await this.notifications.handle(event);
      this.settle(() => channel.ack(msg));
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        this.settle(() => channel.ack(msg)); // ya procesado
        return;
      }
      this.logger.error(
        `Falló el evento ${event.eventId} (${event.type}): ${(error as Error).name}`,
      );
      // `x-delivery-limit` no cuenta los `nack` con requeue (RabbitMQ 4.x), así que el tope
      // se aplica aquí: en el último intento va sin requeue y el DLX lo manda a la DLQ.
      const requeue = this.deliveryCount(msg) < MAX_DELIVERIES;
      this.settle(() => channel.nack(msg, false, requeue));
    }
  }

  /** Entregas hasta ahora, esta incluida: la cola quorum pone `x-acquired-count` desde la 2.ª. */
  private deliveryCount(msg: ConsumeMessage): number {
    const acquired = msg.properties.headers?.['x-acquired-count'];
    return (typeof acquired === 'number' ? acquired : 0) + 1;
  }

  private parse(msg: ConsumeMessage): WireEvent | undefined {
    try {
      const result = domainEventSchema.safeParse(
        JSON.parse(msg.content.toString('utf8')),
      );
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Si el canal se cerró, el broker reentrega el mensaje: ack/nack no deben romper nada. */
  private settle(action: () => void): void {
    try {
      action();
    } catch {
      this.logger.warn('No se pudo confirmar el mensaje: canal cerrado');
    }
  }
}
