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
  envs: Array<{ name: string; dekVersion: number; hasGrant: boolean }>;
}

export interface VaultSecret {
  name: string;
  ciphertext: string;
  dekVersion: number;
  version: number;
  updatedAt: string;
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
}
