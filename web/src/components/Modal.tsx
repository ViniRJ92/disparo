import { useEffect } from 'react';
import { X } from 'lucide-react';

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Ícone, subtítulo e selo opcionais no cabeçalho. */
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  badge?: React.ReactNode;
  accent?: boolean;
}

export function Modal({ title, onClose, children, footer, icon, subtitle, badge, accent }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        {accent && <div className="modal-accent" />}
        <header className="modal-header">
          <div className="row" style={{ gap: 14, flexWrap: 'nowrap' }}>
            {icon && <span className="page-icon">{icon}</span>}
            <div>
              <div className="row">
                <h2>{title}</h2>
                {badge}
              </div>
              {subtitle && <p className="panel-subtitle">{subtitle}</p>}
            </div>
          </div>
          <button className="ghost icon" onClick={onClose} aria-label="Fechar"><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}
