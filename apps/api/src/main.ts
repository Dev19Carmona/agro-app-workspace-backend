import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ApiEnv } from '../../../libs/common/src/config/env.schema.js';
import {
  applySecurity,
  parseCorsOrigins,
} from '../../../libs/common/src/security/apply-security.js';
import { setupSwagger } from '../../../libs/common/src/swagger/setup-swagger.js';
import { ApiModule } from './api.module.js';

async function bootstrap() {
  // `rawBody` conserva el cuerpo sin parsear para verificar la firma del webhook de pagos.
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
    rawBody: true,
  });
  const config = app.get<ConfigService<ApiEnv, true>>(ConfigService);
  applySecurity(app, {
    corsOrigins: parseCorsOrigins(config.get('CORS_ORIGINS', { infer: true })),
  });
  setupSwagger(app, {
    title: 'Mini-Croper API',
    description:
      'Documentación y pruebas de la API de Mini-Croper (monolito modular: auth, catalog, orders, payments).',
    tags: [
      { name: 'health', description: 'Estado del servicio y de MongoDB' },
      { name: 'auth', description: 'Registro, login, JWT y roles' },
      {
        name: 'catalog',
        description: 'Tiendas, productos, variantes, stock y ofertas',
      },
      {
        name: 'orders',
        description: 'Carrito, checkout, pedidos y sub-pedidos',
      },
      {
        name: 'payments',
        description: 'Pasarela simulada y registro de pagos',
      },
    ],
  });
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
