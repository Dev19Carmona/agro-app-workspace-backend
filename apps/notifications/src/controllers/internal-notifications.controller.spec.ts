import {
  type INestApplication,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ServiceTokenGuard } from '../guards/service-token.guard.js';
import { NotificationsQueryService } from '../services/notifications-query.service.js';
import { InternalNotificationsController } from './internal-notifications.controller.js';

const TOKEN = 's'.repeat(32);
const USER = '64b7f0c2a1b2c3d4e5f60718';
const STORE = '64b7f0c2a1b2c3d4e5f60719';
const ID = '64b7f0c2a1b2c3d4e5f60700';

describe('InternalNotificationsController (HTTP con guard y pipe reales)', () => {
  const list = vi.fn();
  const unreadCount = vi.fn();
  const markRead = vi.fn();
  const markAllRead = vi.fn();
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [InternalNotificationsController],
      providers: [
        ServiceTokenGuard,
        { provide: ConfigService, useValue: { get: () => TOKEN } },
        {
          provide: NotificationsQueryService,
          useValue: { list, unreadCount, markRead, markAllRead },
        },
        { provide: APP_PIPE, useClass: StandardSchemaValidationPipe },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    ['get', '/internal/notifications'],
    ['get', '/internal/notifications/unread-count'],
    ['post', '/internal/notifications/read-all'],
    ['patch', `/internal/notifications/${ID}/read`],
  ] as const)('%s %s responde 401 sin token', async (method, url) => {
    await http()[method](url).send({ userId: USER }).expect(401);
  });

  it('GET lista con el actor separado de la paginación', async () => {
    list.mockResolvedValue({ data: [], nextCursor: null });

    await http()
      .get('/internal/notifications')
      .set('X-Service-Token', TOKEN)
      .query({ userId: USER, storeId: STORE, limit: '5', cursor: ID })
      .expect(200, { data: [], nextCursor: null });

    expect(list).toHaveBeenCalledWith(
      { userId: USER, storeId: STORE },
      { limit: 5, cursor: ID },
    );
  });

  it('GET usa limit 20 por defecto', async () => {
    list.mockResolvedValue({ data: [], nextCursor: null });

    await http()
      .get('/internal/notifications')
      .set('X-Service-Token', TOKEN)
      .query({ userId: USER })
      .expect(200);

    expect(list).toHaveBeenCalledWith(
      { userId: USER },
      { limit: 20, cursor: undefined },
    );
  });

  it.each([{ limit: '0' }, { limit: '51' }, { cursor: 'x' }, { extra: '1' }])(
    'GET responde 400 con %j',
    async (extra) => {
      await http()
        .get('/internal/notifications')
        .set('X-Service-Token', TOKEN)
        .query({ userId: USER, ...extra })
        .expect(400);
      expect(list).not.toHaveBeenCalled();
    },
  );

  it('GET unread-count delega con el actor (no lo captura :id)', async () => {
    unreadCount.mockResolvedValue({ count: 3 });

    await http()
      .get('/internal/notifications/unread-count')
      .set('X-Service-Token', TOKEN)
      .query({ userId: USER })
      .expect(200, { count: 3 });

    expect(unreadCount).toHaveBeenCalledWith({ userId: USER });
  });

  it('POST read-all responde 200 con { updated }', async () => {
    markAllRead.mockResolvedValue({ updated: 2 });

    await http()
      .post('/internal/notifications/read-all')
      .set('X-Service-Token', TOKEN)
      .send({ userId: USER, storeId: STORE })
      .expect(200, { updated: 2 });

    expect(markAllRead).toHaveBeenCalledWith({ userId: USER, storeId: STORE });
  });

  it('POST read-all rechaza propiedades de más (400)', async () => {
    await http()
      .post('/internal/notifications/read-all')
      .set('X-Service-Token', TOKEN)
      .send({ userId: USER, admin: true })
      .expect(400);
  });

  it('PATCH :id/read delega con el actor y el id', async () => {
    markRead.mockResolvedValue({ id: ID });

    await http()
      .patch(`/internal/notifications/${ID}/read`)
      .set('X-Service-Token', TOKEN)
      .send({ userId: USER })
      .expect(200, { id: ID });

    expect(markRead).toHaveBeenCalledWith({ userId: USER }, ID);
  });

  it('PATCH con un id que no es ObjectId responde 400', async () => {
    await http()
      .patch('/internal/notifications/no-es-id/read')
      .set('X-Service-Token', TOKEN)
      .send({ userId: USER })
      .expect(400);
  });
});
