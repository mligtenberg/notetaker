import type { ReactNode } from 'react';
import styles from '../app.module.css';

interface PageProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  headerActions?: ReactNode;
  headerClassName?: string;
  toolbar?: ReactNode;
  children: ReactNode;
}

export function Page({
  title,
  subtitle,
  headerActions,
  headerClassName = styles.listHeader,
  toolbar,
  children,
}: PageProps) {
  return (
    <section className={styles.panel}>
      {title !== undefined ? (
        <div className={headerClassName}>
          <div>
            <h1>{title}</h1>
            {subtitle !== undefined ? (
              <p className={styles.pageSubtitle}>{subtitle}</p>
            ) : null}
          </div>
          {headerActions}
        </div>
      ) : null}

      {toolbar}

      {children}
    </section>
  );
}
