import type { Logger } from 'pino';

/** Usuario autenticado del dashboard (mismo auth que OpsHyper: Supabase + user_profiles.role). */
export interface DashboardUser {
  id: string;
  email: string;
  name: string | null;
  role: string | null; // superadmin | admin | null
  // Su registro en roz.dev. El acceso al dashboard lo EXIGE (ver requireDashboardAuth), así que
  // dentro de una ruta autenticada siempre viene; es lo que ancla "mis tareas" a una persona.
  devId: string;
  devName: string;
  devActive: boolean;
}

export type RozContext = {
  Variables: {
    logger: Logger;
    requestId: string;
    user?: DashboardUser;
  };
};
