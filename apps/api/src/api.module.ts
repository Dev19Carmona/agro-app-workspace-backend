import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { OrderModule } from './modules/order/order.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';

/**
 * Monolito modular: núcleo de Mini-Croper (auth, catálogo, pedidos y pagos).
 * Cada dominio es un módulo con fronteras claras para poder extraerlo
 * a un servicio aparte si la carga lo justifica.
 */
@Module({
  imports: [AuthModule, CatalogModule, OrderModule, PaymentsModule],
})
export class ApiModule {}
