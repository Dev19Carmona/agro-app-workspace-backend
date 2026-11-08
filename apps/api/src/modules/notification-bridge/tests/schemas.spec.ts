import { model } from 'mongoose';
import {
  NotificationOutboxEventSchema,
  NotificationOutboxStatus,
} from '../schemas/notification-outbox.schema.js';

type Indice = [Record<string, number>, Record<string, unknown>];
const indices = NotificationOutboxEventSchema.indexes() as Indice[];

const OutboxModel = model(
  'NotificationOutboxSpec',
  NotificationOutboxEventSchema,
);

describe('notification_outbox', () => {
  it('usa la colección notification_outbox', () => {
    expect(NotificationOutboxEventSchema.get('collection')).toBe(
      'notification_outbox',
    );
  });

  it('tiene índice único por eventId', () => {
    expect(indices).toContainEqual([
      { eventId: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });

  it('tiene índice por status y nextAttemptAt', () => {
    expect(indices.map(([campos]) => campos)).toContainEqual({
      status: 1,
      nextAttemptAt: 1,
    });
  });

  it('aplica los defaults: PENDING, 0 intentos y nextAttemptAt ahora', () => {
    const antes = Date.now();
    const doc = new OutboxModel({
      eventId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      type: 'provider.approved',
      correlationId: 'u1',
      payload: { userId: 'u1' },
      occurredAt: new Date(),
    });
    expect(doc.status).toBe(NotificationOutboxStatus.PENDING);
    expect(doc.attempts).toBe(0);
    expect(doc.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(antes);
    expect(doc.lockedUntil).toBeUndefined();
    expect(doc.publishedAt).toBeUndefined();
  });

  it('rechaza un status desconocido', () => {
    const doc = new OutboxModel({ status: 'OTRO' });
    expect(doc.validateSync()?.errors.status).toBeDefined();
  });
});
