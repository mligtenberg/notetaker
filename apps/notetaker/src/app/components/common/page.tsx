import type { ReactNode } from 'react';
import styles from '../../app.module.css';
import {Card} from "./card";

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
    <Card>
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
    </Card>
  );
}
