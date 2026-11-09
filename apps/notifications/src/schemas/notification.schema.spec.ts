import { model, Types } from 'mongoose';
import { NotificationSchema } from './notification.schema.js';

type Indice = [Record<string, number>, Record<string, unknown>];
const indices = NotificationSchema.indexes() as Indice[];
const NotificationModel = model('NotificationSpec', NotificationSchema);

describe('notifications (schema)', () => {
  it('usa la colección notifications', () => {
    expect(NotificationSchema.get('collection')).toBe('notifications');
  });

  it('tiene el índice único de idempotencia', () => {
    expect(indices).toContainEqual([
      { eventId: 1, destinatarioTipo: 1, destinatarioId: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });

  it('tiene el índice por destinatario y fecha', () => {
    expect(indices.map(([campos]) => campos)).toContainEqual({
      destinatarioTipo: 1,
      destinatarioId: 1,
      createdAt: -1,
    });
  });

  it('tiene el índice del listado por cursor', () => {
    expect(indices.map(([campos]) => campos)).toContainEqual({
      destinatarioTipo: 1,
      destinatarioId: 1,
      _id: -1,
    });
  });

  it('tiene el índice de no leídos', () => {
    expect(indices.map(([campos]) => campos)).toContainEqual({
      destinatarioTipo: 1,
      destinatarioId: 1,
      readAt: 1,
    });
  });

  it('readAt es opcional y un aviso nuevo nace sin leer', () => {
    expect(NotificationSchema.path('readAt').instance).toBe('Date');
    expect(NotificationSchema.path('readAt').isRequired).toBeFalsy();
    expect(new NotificationModel({}).readAt).toBeUndefined();
  });

  it('destinatarioId es un ObjectId, no Mixed', () => {
    expect(NotificationSchema.path('destinatarioId').instance).toBe('ObjectId');
    const doc = new NotificationModel({
      destinatarioId: '64b7f0c2a1b2c3d4e5f60718',
    });
    expect(doc.destinatarioId).toBeInstanceOf(Types.ObjectId);
  });
});
