import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';

/**
 * `GET /health` compartido por `api` y `notifications`.
 * Requiere que la app registre `MongooseModule.forRoot*` (usa su conexión).
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
})
export class HealthModule {}
