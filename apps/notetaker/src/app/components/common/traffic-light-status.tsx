import styles from '../../app.module.css';

interface TrafficLightStatusProps {
  status: 'completed' | 'pending';
}

export function TrafficLightStatus({ status }: TrafficLightStatusProps) {
  return (
    <span
      className={styles.trafficLight}
      data-status={status}
      aria-label={status === 'completed' ? 'Completed' : 'Pending'}
    />
  );
}
