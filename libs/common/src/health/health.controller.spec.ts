import { Test } from '@nestjs/testing';
import { HealthCheckService, MongooseHealthIndicator } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  const pingCheck = vi.fn();
  const check = vi.fn();
  let controller: HealthController;

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: { check } },
        { provide: MongooseHealthIndicator, useValue: { pingCheck } },
      ],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('comprueba MongoDB con la clave "mongodb"', async () => {
    const resultado = { status: 'ok', info: { mongodb: { status: 'up' } } };
    pingCheck.mockResolvedValue({ mongodb: { status: 'up' } });
    // Ejecuta los indicadores que recibe el servicio, como haría Terminus.
    check.mockImplementation(async (indicators: (() => Promise<unknown>)[]) => {
      await Promise.all(indicators.map((indicator) => indicator()));
      return resultado;
    });

    await expect(controller.check()).resolves.toEqual(resultado);
    expect(pingCheck).toHaveBeenCalledWith('mongodb');
  });

  it('propaga el error de Terminus cuando MongoDB no responde (503)', async () => {
    const error = new Error('Service Unavailable');
    check.mockRejectedValue(error);

    await expect(controller.check()).rejects.toBe(error);
  });
});
