import type { ReactNode } from 'react';
import styles from '../app.module.css';

interface DialogProps {
  ariaLabel: string;
  label: string;
  title: ReactNode;
  status?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}

export function Dialog({
  ariaLabel,
  label,
  title,
  status,
  children,
  actions,
}: DialogProps) {
  return (
    <div
      className={styles.downloadOverlay}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <section className={styles.downloadDialog}>
        <div className={styles.listHeader}>
          <div>
            <p className={styles.label}>{label}</p>
            <h2>{title}</h2>
          </div>
          {status}
        </div>

        {children}

        {actions}
      </section>
    </div>
  );
}
