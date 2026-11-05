// Módulo PURO (sin imports): lo usan la web y las pruebas en Node.
/** Tipo principal del proyecto (espejo de PROJECT_TYPES en src/projects/profile.ts, migración 0033). */
export const PROJECT_TYPES = [
  { value: 'landing', label: 'Landing / sitio de marketing', hint: 'Páginas informativas o de campaña, sin cuentas de usuario ni lógica de negocio propia.' },
  { value: 'ecommerce', label: 'E-commerce / tienda', hint: 'Catálogo, carrito y pagos.' },
  { value: 'app_web', label: 'App web con backend', hint: 'Plataforma o SaaS con usuarios, base de datos y lógica de negocio propia.' },
  { value: 'app_movil', label: 'App móvil', hint: 'iOS/Android (nativa, React Native, Flutter), normalmente con su backend.' },
  { value: 'api_backend', label: 'API / backend / integraciones', hint: 'Servicio sin interfaz propia: APIs, workers, integraciones, automatizaciones.' },
  { value: 'ia', label: 'Producto con IA', hint: 'El núcleo es IA: agentes, LLMs, clasificación o generación.' },
  { value: 'otro', label: 'Otro', hint: 'No encaja en los anteriores.' },
] as const;
export const PROJECT_TYPE_LABEL: Record<string, string> = Object.fromEntries(PROJECT_TYPES.map((t) => [t.value, t.label]));
