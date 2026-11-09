import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  StandardSchemaValidationPipe,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { RolesGuard } from '../../../../../../libs/common/src/security/roles.guard.js';
import { NotificationsController } from '../controllers/notifications.controller.js';
import { NotificationInboxService } from '../services/notification-inbox.service.js';

const ID = '64b7f0c2a1b2c3d4e5f60700';

/** Sustituye a `JwtAuthGuard`: el rol sale del header `x-test-rol`; sin él, 401. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const rol = req.headers['x-test-rol'];
    if (!rol) throw new UnauthorizedException();
    req.user = { id: 'u1', rol, sessionId: 's1' };
    return true;
  }
}

describe('NotificationsController (HTTP con pipe, throttler y roles reales)', () => {
  const list = vi.fn();
  const unreadCount = vi.fn();
  const markRead = vi.fn();
  const markAllRead = vi.fn();
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [NotificationsController],
      providers: [
        {
          provide: NotificationInboxService,
          useValue: { list, unreadCount, markRead, markAllRead },
        },
        { provide: APP_PIPE, useClass: StandardSchemaValidationPipe },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const rutas = [
    ['get', '/notifications'],
    ['get', '/notifications/unread-count'],
    ['post', '/notifications/read-all'],
    ['patch', `/notifications/${ID}/read`],
  ] as const;

  it.each(rutas)('%s %s responde 401 sin token', async (method, url) => {
    await http()[method](url).expect(401);
  });

  it.each(rutas)('%s %s responde 403 al ADMIN', async (method, url) => {
    await http()[method](url).set('x-test-rol', 'ADMIN').expect(403);
    expect(list).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
  });

  it.each(['PRODUCTOR', 'PROVEEDOR'])('GET lista para %s', async (rol) => {
    list.mockResolvedValue({ data: [], nextCursor: null });

    await http()
      .get('/notifications')
      .set('x-test-rol', rol)
      .expect(200, { data: [], nextCursor: null });

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1', rol }),
      { limit: 20 },
    );
  });

  it('GET pasa limit y cursor validados', async () => {
    list.mockResolvedValue({ data: [], nextCursor: null });

    await http()
      .get('/notifications')
      .query({ limit: '5', cursor: ID })
      .set('x-test-rol', 'PRODUCTOR')
      .expect(200);

    expect(list).toHaveBeenCalledWith(expect.anything(), {
      limit: 5,
      cursor: ID,
    });
  });

  it.each([
    { limit: '0' },
    { limit: '51' },
    { cursor: 'abc' },
    { userId: ID },
    { storeId: ID },
  ])('GET responde 400 con %j', async (query) => {
    await http()
      .get('/notifications')
      .query(query)
      .set('x-test-rol', 'PROVEEDOR')
      .expect(400);
    expect(list).not.toHaveBeenCalled();
  });

  it('GET unread-count no lo captura :id', async () => {
    unreadCount.mockResolvedValue({ count: 2 });

    await http()
      .get('/notifications/unread-count')
      .set('x-test-rol', 'PRODUCTOR')
      .expect(200, { count: 2 });
  });

  it('POST read-all responde 200 con { updated }', async () => {
    markAllRead.mockResolvedValue({ updated: 3 });

    await http()
      .post('/notifications/read-all')
      .set('x-test-rol', 'PRODUCTOR')
      .expect(200, { updated: 3 });
  });

  it('PATCH :id/read delega con el id', async () => {
    markRead.mockResolvedValue({ id: ID });

    await http()
      .patch(`/notifications/${ID}/read`)
      .set('x-test-rol', 'PRODUCTOR')
      .expect(200, { id: ID });

    expect(markRead).toHaveBeenCalledWith(expect.anything(), ID);
  });

  it('PATCH con un id que no es ObjectId responde 400', async () => {
    await http()
      .patch('/notifications/no-es-id/read')
      .set('x-test-rol', 'PRODUCTOR')
      .expect(400);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('limita las lecturas a 60/min por IP', async () => {
    list.mockResolvedValue({ data: [], nextCursor: null });
    for (let i = 0; i < 60; i++) {
      await http()
        .get('/notifications')
        .set('x-test-rol', 'PRODUCTOR')
        .expect(200);
    }
    await http()
      .get('/notifications')
      .set('x-test-rol', 'PRODUCTOR')
      .expect(429);
  });

  it('limita las escrituras a 30/min por IP', async () => {
    markAllRead.mockResolvedValue({ updated: 0 });
    for (let i = 0; i < 30; i++) {
      await http()
        .post('/notifications/read-all')
        .set('x-test-rol', 'PRODUCTOR')
        .expect(200);
    }
    await http()
      .post('/notifications/read-all')
      .set('x-test-rol', 'PRODUCTOR')
      .expect(429);
  });
});
