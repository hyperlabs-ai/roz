import type { Logger } from 'pino';

/** Usuario autenticado del dashboard (mismo auth que OpsHyper: Supabase + user_profiles.role). */
export interface DashboardUser {
  id: string;
  email: string;
  name: string | null;
  role: string | null; // superadmin | admin | null
}

export type RozContext = {
  Variables: {
    logger: Logger;
    requestId: string;
    user?: DashboardUser;
  };
};
