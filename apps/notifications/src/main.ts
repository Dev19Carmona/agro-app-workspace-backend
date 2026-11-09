import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applySecurity } from '../../../libs/common/src/security/apply-security.js';
import { setupSwagger } from '../../../libs/common/src/swagger/setup-swagger.js';
import { NotificationsModule } from './notifications.module.js';

async function bootstrap() {
  const app =
    await NestFactory.create<NestExpressApplication>(NotificationsModule);
  // API interna: sin CORS (el único cliente es `api`, de servidor a servidor).
  applySecurity(app, { corsOrigins: [] });
  setupSwagger(app, {
    title: 'Notifications API',
    description:
      'Documentación y pruebas del servicio Notifications (Mini-Croper). Servicio independiente del monolito api.',
    tags: [
      { name: 'health', description: 'Estado del servicio y de MongoDB' },
      {
        name: 'internal',
        description:
          'API interna de avisos (solo api, con X-Service-Token; no se publica)',
      },
    ],
  });
  await app.listen(process.env.PORT ?? 3005);
}
await bootstrap();
