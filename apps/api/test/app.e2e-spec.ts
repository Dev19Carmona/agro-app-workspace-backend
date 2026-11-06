import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { ApiModule } from './../src/api.module.js';

describe('ApiModule (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it.each(['auth', 'catalog', 'orders', 'payments'])(
    '/%s (GET)',
    (route) => {
      return request(app.getHttpServer())
        .get(`/${route}`)
        .expect(200)
        .expect('Hello World!');
    },
  );

  afterEach(async () => {
    await app.close();
  });
});
