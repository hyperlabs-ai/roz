// ¿Está encendida la asignación automática? Depende de CONFIGURACIÓN, nunca de fallos en caliente:
// sin llave de TypeSafe (o con ROZ_AUTO_ASSIGN=false) la función está apagada y todo sigue como
// antes. Con llave, un fallo de Jev deja la tarea sin asignar y visible — no cae en silencio al
// router viejo. Va en su propio módulo para que el dashboard lo consulte sin importar el orquestador.
import { config } from '../config.js';
import { typesafeEnabled } from '../adapters/typesafe.js';

export function autoAssignEnabled(): boolean {
  return config.autoAssign.enabled && typesafeEnabled();
}
