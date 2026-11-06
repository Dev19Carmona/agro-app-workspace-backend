import { NestFactory } from '@nestjs/core';
import { OrderModule } from './order.module.js';

async function bootstrap() {
  const app = await NestFactory.create(OrderModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
