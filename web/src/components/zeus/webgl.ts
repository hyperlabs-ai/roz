// Detección de WebGL, aparte de la maqueta para no arrastrar three.js al bundle del Mapa.

/** ¿Hay WebGL? Sin él, el Mapa cae al isométrico. */
export function supportsWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
