import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// SPA del dashboard. En dev, /api se proxea al server Hono (puerto 3000). En build, sale a
// web/dist (servido estático por Vercel; /api/* lo enruta la función Hono — ver vercel.json).
//
// El front necesita la URL y el anon key de Supabase. Para NO duplicar variables en Vercel,
// reusamos las que ya existen sin prefijo (SUPABASE_URL / SUPABASE_ANON_KEY) y las inyectamos
// como import.meta.env.VITE_* vía `define`. Solo se exponen esas dos (ambas públicas por
// diseño); el service_role nunca toca el bundle. Fallback a VITE_* para dev local.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || '';
  const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || '';

  return {
    plugins: [react()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(supabaseAnonKey),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            charts: ['recharts'],
            supabase: ['@supabase/supabase-js'],
          },
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: 'http://localhost:3000', changeOrigin: true },
      },
    },
  };
});
