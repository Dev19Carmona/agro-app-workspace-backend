// E2E del consumidor de `notifications` contra MongoDB y RabbitMQ reales:
// aviso por evento, idempotencia, DLQ por mensaje inválido y DLQ tras 3 entregas.
//
// - Necesita MONGODB_URI y RABBITMQ_URI (entorno o `.env`): `docker compose up -d --wait`.
// - Usa la cola real `notifications.events`: no la corras con otra instancia de
//   `notifications` consumiéndola, y vacía ambas colas al empezar.
// - Los avisos de prueba cuelgan de userIds aleatorios y se borran al terminar.
import { randomUUID } from 'node:crypto';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { type Connection, Types } from 'mongoose';
import { RabbitMqConnection } from '../../../libs/common/src/messaging/rabbitmq-connection.js';
import {
  EVENTS_EXCHANGE,
  NOTIFICATIONS_DLQ,
  NOTIFICATIONS_QUEUE,
} from '../../../libs/common/src/messaging/topology.js';
import { NotificationsModule } from '../src/notifications.module.js';
import { NotificationsService } from '../src/services/notifications.service.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 10_000,
): Promise<T> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > limit) throw new Error('Tiempo de espera agotado');
    await wait(100);
  }
}

describe('notifications consumer (e2e)', () => {
  let app: INestApplication;
  let conn: Connection;
  let service: NotificationsService;
  let rabbit: RabbitMqConnection;
  const userIds: Types.ObjectId[] = [];

  const wire = (extra: Record<string, unknown> = {}) => {
    const userId = new Types.ObjectId();
    userIds.push(userId);
    return {
      eventId: randomUUID(),
      type: 'provider.approved',
      occurredAt: new Date().toISOString(),
      correlationId: userId.toString(),
      payload: {
        userId: userId.toString(),
        reviewedBy: new Types.ObjectId().toString(),
      },
      ...extra,
    };
  };

  const publish = (body: string | object, routingKey = 'provider.approved') =>
    rabbit
      .getChannel()
      .publish(
        EVENTS_EXCHANGE,
        routingKey,
        Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
        { persistent: true, contentType: 'application/json' },
      );

  const notificationsOf = (eventId: string) =>
    conn.collection('notifications').find({ eventId }).toArray();

  const fromDlq = () =>
    until(async () => {
      const msg = await rabbit
        .getChannel()
        .get(NOTIFICATIONS_DLQ, { noAck: true });
      return msg || undefined;
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NotificationsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    conn = app.get<Connection>(getConnectionToken());
    service = app.get(NotificationsService);

    rabbit = new RabbitMqConnection(process.env.RABBITMQ_URI!);
    await rabbit.start();
    await until(() => rabbit.isConnected());
  });

  beforeEach(async () => {
    const ch = rabbit.getChannel();
    await ch.purgeQueue(NOTIFICATIONS_QUEUE);
    await ch.purgeQueue(NOTIFICATIONS_DLQ);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await conn
      .collection('notifications')
      .deleteMany({ destinatarioId: { $in: userIds } });
    await rabbit.close();
    await app.close();
  });

  it('un provider.approved publicado deja un Notification', async () => {
    const event = wire();
    publish(event);

    const [doc] = await until(async () => {
      const docs = await notificationsOf(event.eventId);
      return docs.length ? docs : undefined;
    });

    expect(doc).toMatchObject({
      eventType: 'provider.approved',
      correlationId: event.correlationId,
      destinatarioTipo: 'USER',
      plantilla: 'PROVIDER_APPROVED',
      canal: 'SIMULATED',
    });
    expect(doc.destinatarioId.toString()).toBe(event.payload.userId);
    expect(doc.sentAt).toBeInstanceOf(Date);
  });

  it('el mismo eventId dos veces deja un solo Notification', async () => {
    const event = wire();
    publish(event);
    publish(event);
    const handle = vi.spyOn(service, 'handle');

    await until(() => handle.mock.calls.length >= 2);
    await wait(500);

    expect(await notificationsOf(event.eventId)).toHaveLength(1);
  });

  it('un JSON inválido llega a la DLQ sin reintentos', async () => {
    const handle = vi.spyOn(service, 'handle');
    publish('{esto no es json');

    const dead = await fromDlq();

    expect(dead.content.toString()).toBe('{esto no es json');
    await wait(500);
    expect(handle).not.toHaveBeenCalled();
  });

  it('un sobre inválido llega a la DLQ sin reintentos', async () => {
    const handle = vi.spyOn(service, 'handle');
    publish({ ...wire(), eventId: 'no-es-uuid' });

    await fromDlq();

    expect(handle).not.toHaveBeenCalled();
  });

  it('un procesamiento que falla siempre llega a la DLQ tras exactamente 3 entregas', async () => {
    const handle = vi
      .spyOn(service, 'handle')
      .mockRejectedValue(new Error('falla forzada'));
    const event = wire();
    publish(event);

    const dead = await fromDlq();

    expect(JSON.parse(dead.content.toString()).eventId).toBe(event.eventId);
    await wait(1_000); // si el límite estuviera mal calibrado habría una 4.ª entrega
    expect(handle).toHaveBeenCalledTimes(3);
    expect(await notificationsOf(event.eventId)).toHaveLength(0);
  });
});
