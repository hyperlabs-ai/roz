// Configuración de Vercel del FRONT de roz (este directorio, web/, es el Root Directory del proyecto).
//
// Vercel solo sirve el estático del SPA. Todo lo que es /api se reescribe hacia zeus (el back, en
// Railway), así que el navegador ve un solo origen: no hay CORS, la cookie del OAuth de Discord sigue
// funcionando y el front no necesita saber dónde vive el back.
//
// La única variable que este proyecto necesita además de las públicas de Supabase es
// ZEUS_API_ORIGIN (https://zeus.galaaxy.tech). Ningún secreto vive en Vercel.
import { routes, type VercelConfig } from '@vercel/config/v1';

const zeus = (process.env.ZEUS_API_ORIGIN ?? '').trim().replace(/\/+$/, '');
if (!/^https?:\/\//.test(zeus)) {
  throw new Error('Falta ZEUS_API_ORIGIN (origen de zeus, con https://) en las variables del proyecto de Vercel.');
}

export const config: VercelConfig = {
  framework: 'vite',
  buildCommand: 'npm run vercel-build',
  outputDirectory: 'dist',
  rewrites: [
    routes.rewrite('/api/(.*)', `${zeus}/api/$1`),
    // Las URLs que ya están configuradas en otros sistemas (webhooks de GitHub y Linear, el MCP de los
    // devs, las apps cliente, los runners) siguen funcionando contra el dominio de roz sin tocar nada.
    // Cuando cada una se repunte directo a zeus (zeus.galaaxy.tech) su línea se puede borrar.
    routes.rewrite('/webhooks/(.*)', `${zeus}/webhooks/$1`),
    routes.rewrite('/mcp', `${zeus}/mcp`),
    routes.rewrite('/v1/intake(.*)', `${zeus}/v1/intake$1`),
    routes.rewrite('/v1/runner/(.*)', `${zeus}/v1/runner/$1`),
    routes.rewrite('/v1/zeus/(.*)', `${zeus}/v1/zeus/$1`),
    routes.rewrite('/health', `${zeus}/health`),
    // Fallback del SPA: lo que no es un archivo del build lo resuelve el router del cliente.
    routes.rewrite('/(.*)', '/index.html'),
  ],
  headers: [
    routes.cacheControl('/assets/(.*)', { public: true, maxAge: '1year', immutable: true }),
    // El service worker y el manifest no se cachean: el navegador debe poder detectar una versión
    // nueva de la PWA en cada visita. El SW controla todo el origen, no solo su carpeta.
    routes.header('/sw.js', [
      { key: 'Cache-Control', value: 'no-cache' },
      { key: 'Service-Worker-Allowed', value: '/' },
    ]),
    routes.header('/manifest.webmanifest', [{ key: 'Cache-Control', value: 'no-cache' }]),
  ],
};
