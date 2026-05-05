import styles from '../../app.module.css';

interface ExportControlsProps {
  json: unknown;
  jsonFileName: string;
  text?: string;
  textFileName?: string;
}

export function ExportControls({
  json,
  jsonFileName,
  text,
  textFileName,
}: ExportControlsProps) {
  return (
    <div className={styles.exportControls} aria-label="Export options">
      <button
        type="button"
        onClick={() =>
          downloadText(
            jsonFileName,
            JSON.stringify(json, null, 2),
            'application/json',
          )
        }
      >
        Export JSON
      </button>
      {text !== undefined && textFileName !== undefined ? (
        <button
          type="button"
          onClick={() => downloadText(textFileName, text, 'text/plain')}
        >
          Export TXT
        </button>
      ) : null}
    </div>
  );
}

function downloadText(fileName: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = fileName.replace(/[\\/:*?"<>|]+/g, '-');
  anchor.click();
  URL.revokeObjectURL(url);
}
