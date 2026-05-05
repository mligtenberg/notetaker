import type { ReactNode } from 'react';
import styles from '../app.module.css';

interface PageProps {
  title?: ReactNode;
  headerActions?: ReactNode;
  headerClassName?: string;
  toolbar?: ReactNode;
  children: ReactNode;
}

export function Page({
  title,
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
            <h2>{title}</h2>
          </div>
          {headerActions}
        </div>
      ) : null}

      {toolbar}

      {children}
    </section>
  );
}
