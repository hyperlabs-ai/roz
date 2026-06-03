// Vercel serverless function entry point.
// Todas las rutas se reescriben aquí vía vercel.json. Hono es compatible con el
// formato de función de Vercel: exportamos el app y Vercel usa app.fetch.
import 'dotenv/config';
import app from '../src/app.js';

export default app;
