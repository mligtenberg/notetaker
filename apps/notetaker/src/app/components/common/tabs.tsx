import styles from '../../app.module.css';
import { useNavigate } from 'react-router-dom';

export interface TabItem {
  label: string;
  path: string;
  prefix?: React.ReactNode;
}

interface TabsProps {
  items: TabItem[];
  activePath: string;
  onTabChange?: () => void;
}

export function Tabs({ items, activePath, onTabChange }: TabsProps) {
  const navigate = useNavigate();

  return (
    <nav className={styles.tabs} aria-label="Tab navigation">
      {items.map((item) => (
        <button
          key={item.path}
          type="button"
          data-active={activePath === item.path}
          onClick={() => {
            navigate(item.path);
            onTabChange?.();
          }}
        >
          {item.prefix && <span className={styles.tabPrefix}>{item.prefix}</span>}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
