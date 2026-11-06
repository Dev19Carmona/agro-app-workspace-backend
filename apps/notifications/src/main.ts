import { NestFactory } from '@nestjs/core';
import { NotificationsModule } from './notifications.module.js';

async function bootstrap() {
  const app = await NestFactory.create(NotificationsModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
