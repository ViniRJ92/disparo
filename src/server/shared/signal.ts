/**
 * Espera que termina por tempo OU por um aviso (notify). Um aviso dado quando
 * ninguém está esperando não se perde: a próxima espera retorna na hora.
 */
export class WakeSignal {
  private waiter: (() => void) | null = null;
  private pending = false;

  wait(timeoutMs: number): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(done, Math.max(0, timeoutMs));
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.waiter === done) self.waiter = null;
        resolve();
      }
      this.waiter = done;
    });
  }

  notify(): void {
    if (this.waiter) this.waiter();
    else this.pending = true;
  }
}
