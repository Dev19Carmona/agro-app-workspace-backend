// Las apps validan el entorno al importar su módulo (ConfigModule), así que el token
// de servicio debe existir antes. Solo se fija un valor de prueba si el entorno no trae uno.
process.env.INTERNAL_SERVICE_TOKEN ??=
  'e2e-internal-service-token-0123456789abcdef';
