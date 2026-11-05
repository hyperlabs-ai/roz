// `toast` de sonner con sonido: éxito → `action`, error → `error` (ver lib/sound.ts). Es la misma
// API; solo se envuelven `success` y `error`. Importa SIEMPRE de aquí, no de 'sonner' directo, o
// ese aviso quedará mudo.
import { toast as sonner } from 'sonner';
import { playSound } from './sound';

type Toast = typeof sonner;

const success: Toast['success'] = (message, data) => {
  void playSound('action');
  return sonner.success(message, data);
};

const error: Toast['error'] = (message, data) => {
  void playSound('error');
  return sonner.error(message, data);
};

export const toast: Toast = Object.assign(
  (...args: Parameters<Toast>) => sonner(...args),
  sonner,
  { success, error },
);
