import { NestFactory } from '@nestjs/core';
import { AuthModule } from './auth.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AuthModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
