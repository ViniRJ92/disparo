/**
 * Executa tarefas assíncronas uma de cada vez, na ordem de chegada.
 * Cada linha tem o seu próprio executor: comandos concorrentes na MESMA linha
 * (ex.: "pausar" durante "reconectar") não se atropelam, e linhas diferentes
 * continuam totalmente independentes.
 */
export class SerialExecutor {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
