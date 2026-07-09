import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './markdown';

function html(content: string): string {
  return renderToStaticMarkup(<Markdown content={content} />);
}

describe('Markdown', () => {
  it('renders headings, bold, italic and inline code', () => {
    expect(html('# Title')).toContain('<h1>Title</h1>');
    expect(html('**bold**')).toContain('<strong>bold</strong>');
    expect(html('*em*')).toContain('<em>em</em>');
    expect(html('`code`')).toContain('<code>code</code>');
  });

  it('renders unordered and ordered lists', () => {
    const ul = html('- a\n- b');
    expect(ul).toContain('<ul>');
    expect(ul).toContain('<li>a</li>');
    expect(ul).toContain('<li>b</li>');

    const ol = html('1. first\n2. second');
    expect(ol).toContain('<ol>');
    expect(ol).toContain('<li>first</li>');
  });

  it('renders fenced code blocks verbatim', () => {
    const out = html('```\nconst x = 1;\n```');
    expect(out).toContain('<pre');
    expect(out).toContain('const x = 1;');
  });

  it('renders safe links and strips dangerous schemes', () => {
    const safe = html('[site](https://example.com)');
    expect(safe).toContain('href="https://example.com"');

    const dangerous = html('[x](javascript:alert(1))');
    expect(dangerous).not.toContain('href="javascript');
    expect(dangerous).not.toContain('<a ');
  });

  it('escapes HTML in content (no raw injection)', () => {
    const out = html('a <script>alert(1)</script> b');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('renders a blockquote', () => {
    expect(html('> quoted')).toContain('<blockquote>');
  });
});
