import { NestFactory } from '@nestjs/core';
import { setupSwagger } from '../../../libs/common/src/swagger/setup-swagger.js';
import { ApiModule } from './api.module.js';

async function bootstrap() {
  const app = await NestFactory.create(ApiModule);
  setupSwagger(app, {
    title: 'Mini-Croper API',
    description:
      'Documentación y pruebas de la API de Mini-Croper (monolito modular: auth, catalog, order, payments).',
  });
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
