// Tipos del API del CLI (/v1/zeus). Espejo a mano de docs/zeus-contracts.md §4 y de
// src/types/zeus.ts del backend: si cambian allá, cambian aquí.

export interface WhoAmI {
  dev: { id: string; name: string; email: string | null };
  zeusAdmin: boolean;
}

export interface VaultKey {
  id: string;
  devId: string;
  devName: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** No está en el contrato; si el back lo manda, `env grant --to <correo>` lo aprovecha. */
  devEmail?: string | null;
}

export interface VaultProject {
  key: string;
  name: string;
  /** needsRotation: alguien perdió el acceso y la llave del entorno debe cambiar (lo manda zeus ≥ 0.3). */
  envs: Array<{ name: string; dekVersion: number; hasGrant: boolean; needsRotation?: boolean }>;
}

export interface VaultSecret {
  name: string;
  ciphertext: string;
  dekVersion: number;
  version: number;
  updatedAt: string;
  /** Quién la cambió por última vez (zeus ≥ 0.3). */
  updatedByName?: string | null;
}

export interface VaultGrant {
  keyId: string;
  devName: string;
  keyName: string;
  fingerprint: string;
}

export interface VaultEnv {
  envId: string;
  dekVersion: number;
  wrappedDek: string;
  secrets: VaultSecret[];
  grants: VaultGrant[];
  /** zeus ≥ 0.3. */
  needsRotation?: boolean;
}

export interface WrappedGrant {
  keyId: string;
  wrappedDek: string;
}

export interface CipherEntry {
  name: string;
  ciphertext: string;
}

export interface CreateEnvBody {
  projectKey: string;
  env: string;
  keyId: string;
  wrappedDek: string;
}

export interface PutSecretsBody {
  keyId: string;
  dekVersion: number;
  set: CipherEntry[];
  delete: string[];
}

export interface GrantBody {
  keyId: string;
  grants: WrappedGrant[];
}

export interface RotateBody {
  keyId: string;
  /** La NUEVA versión (vigente + 1). */
  dekVersion: number;
  grants: WrappedGrant[];
  secrets: CipherEntry[];
  /** Versiones anteriores re-cifradas con la DEK nueva; todas las legibles con la vigente. */
  revisions: Array<{ name: string; version: number; ciphertext: string }>;
}

export interface VaultRevision {
  name: string;
  version: number;
  /** null = en esa versión la variable se borró. */
  ciphertext: string | null;
  dekVersion: number;
  setAt: string;
  setByName: string | null;
  replacedAt: string | null;
  replacedByName: string | null;
  current: boolean;
}

export interface KeyRotateBody {
  oldKeyId: string;
  newKeyId: string;
  grants: Array<{ projectKey: string; env: string; dekVersion: number; wrappedDek: string }>;
  compromised: boolean;
}

/** Un acceso aprobado en la web que falta cifrar (`zeus env grant --pending`). */
export interface GrantIntent {
  id: string;
  projectKey: string;
  env: string;
  dekVersion: number;
  toDevId: string;
  toDevName: string;
  approvedByName: string | null;
  createdAt: string;
  /** Equipos vigentes del destinatario que aún no tienen la llave del entorno. */
  keys: Array<{ keyId: string; name: string; fingerprint: string; publicKey: string }>;
}

export interface InboxBrief {
  id: string;
  kind: 'message' | 'task' | 'plan' | 'env_change';
  from: string;
  to: string;
  subject: string | null;
  status: string | null;
  at: string;
}

export interface InboxSummary {
  unread: number;
  open: InboxBrief[];
  waiting: InboxBrief[];
  envChanges: InboxBrief[];
  toResolve: number;
}

// ---------------------------------------------------------------- conectar el equipo (zeus setup)

export interface DeviceStartBody {
  /** Nombre del equipo (hostname): es lo que la persona ve al aprobar. */
  clientName: string;
  platform: string;
  version: string;
}

export interface DeviceStart {
  /** Secreto: solo lo conoce este CLI; con él se cobra el token al aprobarse. */
  deviceCode: string;
  /** Código corto que la persona compara entre la terminal y la web. */
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type DevicePoll =
  | { status: 'pending' | 'slow_down'; interval: number }
  | { status: 'denied' | 'expired' | 'delivered' }
  | { status: 'approved'; token: string; dev: { id: string; name: string; email: string | null } };
