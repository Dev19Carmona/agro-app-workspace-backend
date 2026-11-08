import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule } from '@nestjs/mongoose';
import type { ApiEnv } from '../../../libs/common/src/config/env.schema.js';
import { validateApiEnv } from '../../../libs/common/src/config/env.schema.js';
import { HealthModule } from '../../../libs/common/src/health/health.module.js';
import { SecurityModule } from '../../../libs/common/src/security/security.module.js';
import { AuthModule } from './modules/auth/index.js';
import { CatalogModule } from './modules/catalog/index.js';
import { NotificationBridgeModule } from './modules/notification-bridge/index.js';
import { OrderModule } from './modules/order/index.js';
import { PaymentsModule } from './modules/payments/index.js';

/**
 * Monolito modular: núcleo de Mini-Croper (auth, catálogo, pedidos y pagos).
 * Cada dominio es un módulo con fronteras claras para poder extraerlo
 * a un servicio aparte si la carga lo justifica.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateApiEnv }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<ApiEnv, true>) => ({
        uri: config.get('MONGODB_URI', { infer: true }),
        dbName: 'mini-croper',
      }),
    }),
    EventEmitterModule.forRoot(),
    SecurityModule,
    HealthModule,
    AuthModule,
    CatalogModule,
    OrderModule,
    PaymentsModule,
    NotificationBridgeModule,
  ],
})
export class ApiModule {}
