import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { NotificationsModule } from './../src/notifications.module.js';

describe('Notifications (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NotificationsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health responde 200 con MongoDB arriba', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });

  it('GET / ya no existe (se eliminó el hello world)', async () => {
    await request(app.getHttpServer()).get('/').expect(404);
  });
});
