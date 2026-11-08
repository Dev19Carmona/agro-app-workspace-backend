import {
  type INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PaymentsWebhookController } from '../controllers/payments-webhook.controller.js';
import { WebhookService } from '../services/webhook.service.js';

const body = {
  eventId: '3f2b8c1e-6a4d-4f0a-9b7e-1c2d3e4f5a6b',
  paymentId: 'a1'.repeat(12),
  resultado: 'APPROVED',
};

describe('PaymentsWebhookController', () => {
  const webhook = { verifySignature: vi.fn(), resolve: vi.fn() };
  let app: INestApplication;
  const post = () =>
    request(app.getHttpServer())
      .post('/payments/webhook')
      .set('X-Signature', 'f'.repeat(64))
      .set('X-Timestamp', '1800000000');

  beforeEach(async () => {
    vi.resetAllMocks();
    webhook.resolve.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentsWebhookController],
      providers: [{ provide: WebhookService, useValue: webhook }],
    }).compile();
    // Como en `main.ts`: el cuerpo crudo hace falta para la firma.
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('200 con { status: "OK" } y pasa cuerpo crudo y headers a la verificación', async () => {
    const crudo = JSON.stringify(body);

    const res = await post().set('Content-Type', 'application/json').send(crudo);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'OK' });
    const [raw, timestamp, signature] = webhook.verifySignature.mock.calls[0]!;
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect((raw as Buffer).toString('utf8')).toBe(crudo);
    expect(timestamp).toBe('1800000000');
    expect(signature).toBe('f'.repeat(64));
    expect(webhook.resolve).toHaveBeenCalledWith(body);
  });

  it('firma inválida: 401 y no resuelve nada', async () => {
    webhook.verifySignature.mockImplementation(() => {
      throw new UnauthorizedException('Firma inválida');
    });

    const res = await post().send(body);

    expect(res.status).toBe(401);
    expect(webhook.resolve).not.toHaveBeenCalled();
  });

  it('la firma se verifica antes que el cuerpo: cuerpo inválido sin firma válida da 401, no 400', async () => {
    webhook.verifySignature.mockImplementation(() => {
      throw new UnauthorizedException('Firma inválida');
    });

    const res = await post().send({ basura: true });

    expect(res.status).toBe(401);
  });

  it.each([
    ['propiedad de más', { ...body, monto: 1 }],
    ['resultado PROCESSING', { ...body, resultado: 'PROCESSING' }],
    ['eventId que no es uuid', { ...body, eventId: 'x' }],
    ['paymentId {"$ne": null}', { ...body, paymentId: { $ne: null } }],
    ['cuerpo vacío', {}],
  ])('firma válida y %s: 400', async (_n, cuerpo) => {
    const res = await post().send(cuerpo);

    expect(res.status).toBe(400);
    expect(webhook.verifySignature).toHaveBeenCalledTimes(1);
    expect(webhook.resolve).not.toHaveBeenCalled();
  });
});
