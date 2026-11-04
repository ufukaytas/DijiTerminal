// Başlıklı panel kabuğu (00/03): 11 px büyük harf başlık, sağda meta, kendi içinde kayan gövde.
import type { ReactNode } from 'react';

export interface PanelProps {
  title: string;
  meta?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Başlığın altında, gövdenin üstünde sabit kalan alan (log filtreleri). */
  toolbar?: ReactNode;
  children?: ReactNode;
  'aria-label'?: string;
}

export function Panel({ title, meta, className, bodyClassName, toolbar, children, ...rest }: PanelProps) {
  return (
    <section className={['panel', className].filter(Boolean).join(' ')} aria-label={rest['aria-label'] ?? title}>
      <div className="panel-h">
        <h2>{title}</h2>
        {meta !== undefined && meta !== null && <span className="panel-meta">{meta}</span>}
      </div>
      {toolbar}
      <div className={['panel-b', bodyClassName].filter(Boolean).join(' ')}>{children}</div>
    </section>
  );
}
