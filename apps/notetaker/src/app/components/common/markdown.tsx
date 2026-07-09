import { Fragment, type ReactNode } from 'react';
import styles from '../../app.module.css';

interface MarkdownProps {
  content: string;
  className?: string;
}

/**
 * A small, dependency-free markdown renderer for model-authored artifacts and
 * chat replies. It builds React elements (so all text is escaped by default)
 * and supports the common subset: headings, bold/italic, inline and fenced
 * code, ordered/unordered lists, blockquotes, links and horizontal rules.
 * Not a full CommonMark implementation (no tables or nested lists).
 */
export function Markdown({ content, className }: MarkdownProps) {
  const classes = [styles.markdown, className].filter(Boolean).join(' ');
  return <div className={classes}>{parseBlocks(content)}</div>;
}

function parseBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];

    // Fenced code block.
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1; // consume closing fence
      blocks.push(
        <pre key={key++} className={styles.markdownCode}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Blank line.
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level}` as 'h1';
      blocks.push(<Tag key={key++}>{renderInline(heading[2])}</Tag>);
      index += 1;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key++} />);
      index += 1;
      continue;
    }

    // Blockquote.
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={key++}>{renderInline(quote.join(' '))}</blockquote>,
      );
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={key++}>
          {items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph: gather consecutive plain lines.
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim().length > 0 &&
      !isBlockStart(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={key++}>{renderInline(paragraph.join(' '))}</p>);
  }

  return blocks;
}

function isBlockStart(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line)
  );
}

// Ordered so that code (raw) wins over emphasis, and bold (**) over italic (*).
const INLINE_PATTERN =
  /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/;

function renderInline(text: string, depth = 0): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    const match = depth < 4 ? INLINE_PATTERN.exec(rest) : null;
    if (match === null || match.index === undefined) {
      nodes.push(<Fragment key={key++}>{rest}</Fragment>);
      break;
    }

    if (match.index > 0) {
      nodes.push(<Fragment key={key++}>{rest.slice(0, match.index)}</Fragment>);
    }

    const [token] = match;
    if (token.startsWith('`')) {
      nodes.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(
        <strong key={key++}>{renderInline(token.slice(2, -2), depth + 1)}</strong>,
      );
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = link ? sanitizeHref(link[2]) : null;
      if (link && href !== null) {
        nodes.push(
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer">
            {renderInline(link[1], depth + 1)}
          </a>,
        );
      } else {
        nodes.push(<Fragment key={key++}>{token}</Fragment>);
      }
    } else {
      nodes.push(
        <em key={key++}>{renderInline(token.slice(1, -1), depth + 1)}</em>,
      );
    }

    rest = rest.slice(match.index + token.length);
  }

  return nodes;
}

/** Allow safe URL schemes only; drop javascript:, data:, etc. */
function sanitizeHref(href: string): string | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (scheme === null) {
    return href; // relative, anchor, or protocol-relative path
  }
  const allowed = ['http', 'https', 'mailto'];
  return allowed.includes(scheme[1].toLowerCase()) ? href : null;
}
