import { Controller, Post, Body } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { applySecurity, parseCorsOrigins } from './apply-security.js';

@Controller('eco')
class EcoController {
  @Post()
  eco(@Body() body: unknown) {
    return body;
  }
}

@Module({ controllers: [EcoController] })
class PruebaModule {}

async function crearApp(corsOrigins: string[]) {
  const app = await NestFactory.create<NestExpressApplication>(PruebaModule, {
    logger: false,
  });
  applySecurity(app, { corsOrigins });
  await app.init();
  return app;
}

describe('parseCorsOrigins', () => {
  it('devuelve lista vacía si no hay valor', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins(' , ')).toEqual([]);
  });

  it('separa por comas y recorta espacios', () => {
    expect(parseCorsOrigins('http://a.com, http://b.com ,')).toEqual([
      'http://a.com',
      'http://b.com',
    ]);
  });
});

describe('applySecurity', () => {
  let app: NestExpressApplication;

  afterEach(async () => {
    await app.close();
  });

  it('añade cabeceras de helmet y no expone X-Powered-By', async () => {
    app = await crearApp([]);
    const res = await request(app.getHttpServer()).post('/eco').send({});
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sin CORS_ORIGINS no devuelve Access-Control-Allow-Origin', async () => {
    app = await crearApp([]);
    const res = await request(app.getHttpServer())
      .post('/eco')
      .set('Origin', 'http://evil.com')
      .send({});
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('permite un origen de la lista blanca', async () => {
    app = await crearApp(['http://app.com']);
    const res = await request(app.getHttpServer())
      .post('/eco')
      .set('Origin', 'http://app.com')
      .send({});
    expect(res.headers['access-control-allow-origin']).toBe('http://app.com');
  });

  it('no devuelve Access-Control-Allow-Origin a un origen fuera de la lista', async () => {
    app = await crearApp(['http://app.com']);
    const res = await request(app.getHttpServer())
      .post('/eco')
      .set('Origin', 'http://evil.com')
      .send({});
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('responde 413 a un body que supera el límite', async () => {
    app = await crearApp([]);
    const res = await request(app.getHttpServer())
      .post('/eco')
      .send({ datos: 'x'.repeat(200 * 1024) });
    expect(res.status).toBe(413);
  });

  it('acepta un body dentro del límite', async () => {
    app = await crearApp([]);
    const res = await request(app.getHttpServer())
      .post('/eco')
      .send({ ok: true });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });
});
