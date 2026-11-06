import { NestFactory } from '@nestjs/core';
import { setupSwagger } from '../../../libs/common/src/swagger/setup-swagger.js';
import { NotificationsModule } from './notifications.module.js';

async function bootstrap() {
  const app = await NestFactory.create(NotificationsModule);
  setupSwagger(app, {
    title: 'Notifications API',
    description: 'Documentación y pruebas de la API de Notifications (Mini-Croper).',
  });
  await app.listen(process.env.PORT ?? 3005);
}
await bootstrap();
