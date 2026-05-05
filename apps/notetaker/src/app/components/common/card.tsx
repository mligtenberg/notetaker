import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';
import styles from '../../app.module.css';

type CardProps<T extends ElementType> = {
  as?: T;
  children: ReactNode;
  className?: string;
  interactive?: boolean;
  compact?: boolean;
  row?: boolean;
} & Omit<
  ComponentPropsWithoutRef<T>,
  'as' | 'children' | 'className'
>;

export function Card<T extends ElementType = 'div'>({
  as,
  children,
  className,
  interactive = false,
  compact = false,
  row = false,
  ...props
}: CardProps<T>) {
  const Component = as ?? 'div';
  const classNames = [
    styles.card,
    interactive ? styles.cardInteractive : null,
    compact ? styles.cardCompact : null,
    row ? styles.cardRow : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Component className={classNames} {...props}>
      {children}
    </Component>
  );
}
