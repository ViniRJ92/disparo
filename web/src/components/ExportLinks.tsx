import { exportUrl } from '../api/client.ts';
import type { ExportFilters, ExportKind } from '../api/types.ts';

const LABEL: Record<ExportKind, string> = {
  sent: 'Baixar enviados CSV',
  failed: 'Baixar falhas CSV',
  pending: 'Baixar pendentes CSV',
  history: 'Baixar histórico CSV',
};

/** Links de download de CSV (o servidor gera o arquivo com os filtros informados). */
export function ExportLinks({ kinds, filters, labels }: { kinds: ExportKind[]; filters: ExportFilters; labels?: Partial<Record<ExportKind, string>> }) {
  return (
    <>
      {kinds.map((kind) => (
        <a key={kind} className="button-link sm" href={exportUrl(kind, filters)} download>
          {labels?.[kind] ?? LABEL[kind]}
        </a>
      ))}
    </>
  );
}
