import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { WireEvent } from '../../../../../../libs/common/src/messaging/domain-event.schema.js';
import { RabbitMqConnection } from '../../../../../../libs/common/src/messaging/rabbitmq-connection.js';
import {
  declareTopology,
  EVENTS_EXCHANGE,
} from '../../../../../../libs/common/src/messaging/topology.js';
import type { EventPublisher } from './event-publisher.js';

/** Publica en el exchange `mini-croper.events` con la routing key igual al `type`. */
@Injectable()
export class RabbitMqEventPublisher
  implements EventPublisher, OnModuleInit, OnModuleDestroy
{
  constructor(private readonly connection: RabbitMqConnection) {}

  async onModuleInit(): Promise<void> {
    this.connection.onConnect((channel) => declareTopology(channel));
    // No lanza con el broker caído: el puente guarda y espera.
    await this.connection.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection.close();
  }

  isConnected(): boolean {
    return this.connection.isConnected();
  }

  async publish(event: WireEvent): Promise<void> {
    const channel = this.connection.getChannel();
    channel.publish(
      EVENTS_EXCHANGE,
      event.type,
      Buffer.from(JSON.stringify(event), 'utf8'),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: event.eventId,
        type: event.type,
        correlationId: event.correlationId,
      },
    );
    await channel.waitForConfirms();
  }
}
