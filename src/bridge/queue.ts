// Carril serial: todas las ESCRITURAS del puente (eventos del gateway y lotes del backfill) pasan por
// aquí, una a la vez y en orden de llegada. Así una lectura-modificación-escritura (reacciones,
// miembros de un hilo, fusión de reacciones del backfill) nunca se cruza con otra.
// Las lecturas a Discord del backfill van FUERA del carril, para no frenar los eventos en vivo.

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next.finally(() => {
      this.pending -= 1;
    });
  }

  get size(): number {
    return this.pending;
  }

  /** Resuelve cuando todo lo encolado hasta ahora terminó. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
