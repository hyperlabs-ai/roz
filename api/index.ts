// Vercel serverless function entry point.
// Todas las rutas se reescriben aquí vía vercel.json. Hono es compatible con el
// formato de función de Vercel: exportamos el app y Vercel usa app.fetch.
import 'dotenv/config';
import app from '../src/app.js';

// Con `builds` en vercel.json, el `functions.maxDuration` se ignora; se declara aquí.
// El drain del outbox puede tardar (reconcile llama a Claude) → 120s.
export const config = { maxDuration: 120 };

export default app;
