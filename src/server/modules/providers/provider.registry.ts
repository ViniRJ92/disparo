import { DomainError } from '../../shared/errors.ts';
import type { ProviderContext, ProviderFactory, WhatsAppProvider } from './provider.types.ts';

/** Registro de provedores disponíveis, por nome (ex.: "mock", "cloud_api"). */
export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  register(kind: string, factory: ProviderFactory): this {
    this.factories.set(kind, factory);
    return this;
  }

  has(kind: string): boolean {
    return this.factories.has(kind);
  }

  kinds(): string[] {
    return [...this.factories.keys()];
  }

  create(kind: string, context: ProviderContext): WhatsAppProvider {
    const factory = this.factories.get(kind);
    if (!factory) throw new DomainError('VALIDATION', `Provedor desconhecido: ${kind}`);
    return factory(context);
  }
}
