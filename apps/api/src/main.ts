import { NestFactory } from '@nestjs/core';
import { setupSwagger } from '../../../libs/common/src/swagger/setup-swagger.js';
import { ApiModule } from './api.module.js';

async function bootstrap() {
  const app = await NestFactory.create(ApiModule);
  setupSwagger(app, {
    title: 'Mini-Croper API',
    description:
      'Documentación y pruebas de la API de Mini-Croper (monolito modular: auth, catalog, orders, payments).',
    tags: [
      { name: 'auth', description: 'Registro, login, JWT y roles' },
      { name: 'catalog', description: 'Tiendas, productos, variantes, stock y ofertas' },
      { name: 'orders', description: 'Carrito, checkout, pedidos y sub-pedidos' },
      { name: 'payments', description: 'Pasarela simulada y registro de pagos' },
    ],
  });
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
