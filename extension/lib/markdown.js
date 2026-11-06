/*
 * DeepSeek Chat Exporter - HTML to Markdown converter for the DOM fallback.
 *
 * DeepSeek's API already returns Markdown. This converter is only used when
 * the web API is unavailable, so it focuses on the elements the chat UI uses:
 * headings, paragraphs, lists, tables, code blocks, KaTeX and links.
 */
(function initMarkdown(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DSExporterMarkdown = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function markdownFactory() {
  'use strict';

  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'div', 'footer', 'header', 'main', 'nav',
    'section', 'figure', 'figcaption', 'form', 'fieldset', 'dl', 'dt', 'dd',
  ]);
  const IGNORED_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'video',
    'audio', 'iframe', 'object', 'embed', 'button', 'input', 'textarea',
    'select', 'option',
  ]);

  function htmlToMarkdown(root) {
    if (!root) return '';
    const state = {
      chunks: [],
      listDepth: 0,
      inTable: false,
    };

    const output = convertChildren(root, state);
    return restoreChunks(normalizeProse(output), state.chunks);
  }

  function protect(state, value) {
    const token = `\u0001DSMD${state.chunks.length}\u0002`;
    state.chunks.push(value);
    return token;
  }

  function restoreChunks(value, chunks) {
    let output = value;
    chunks.forEach((chunk, index) => {
      output = output.replace(`\u0001DSMD${index}\u0002`, chunk);
    });
    return output.trim();
  }

  function normalizeProse(value) {
    return String(value || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/([^\n])[ \t]{2,}/g, '$1 ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizeInline(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function convertChildren(node, state) {
    let output = '';
    for (const child of Array.from(node.childNodes || [])) {
      output += convertNode(child, state);
    }
    return output;
  }

  function convertNode(node, state) {
    if (node.nodeType === 3) {
      return node.nodeValue ? node.nodeValue.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ') : '';
    }
    if (node.nodeType !== 1) return '';

    const element = node;
    const tag = element.tagName.toLowerCase();

    if (isKatex(element)) return convertKatex(element, state);
    if (isIgnored(element, tag)) return '';

    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n\n---\n\n';
    if (tag === 'pre') return convertCodeBlock(element, state);
    if (tag === 'code') return convertInlineCode(element, state);
    if (tag === 'img') return convertImage(element);
    if (tag === 'a') return convertLink(element, state);
    if (tag === 'ul' || tag === 'ol') return convertList(element, tag === 'ol', state);
    if (tag === 'li') return convertChildren(element, state);
    if (tag === 'table') return convertTable(element, state);
    if (tag === 'blockquote') return convertBlockquote(element, state);
    if (tag === 'details') return convertDetails(element, state);
    if (/^h[1-6]$/.test(tag)) return convertHeading(element, state, Number(tag.slice(1)));
    if (tag === 'p') {
      const content = normalizeInline(convertChildren(element, state));
      return content ? `\n\n${content}\n\n` : '';
    }
    if (tag === 'strong' || tag === 'b') {
      const content = normalizeInline(convertChildren(element, state));
      return content ? `**${content}**` : '';
    }
    if (tag === 'em' || tag === 'i') {
      const content = normalizeInline(convertChildren(element, state));
      return content ? `*${content}*` : '';
    }
    if (tag === 'del' || tag === 's' || tag === 'strike') {
      const content = normalizeInline(convertChildren(element, state));
      return content ? `~~${content}~~` : '';
    }
    if (tag === 'u') {
      const content = normalizeInline(convertChildren(element, state));
      return content ? `<u>${content}</u>` : '';
    }
    if (tag === 'kbd') {
      const content = normalizeInline(convertChildren(element, state));
      return content ? `<kbd>${content}</kbd>` : '';
    }
    if (tag === 'sup' || tag === 'sub') {
      const content = normalizeInline(convertChildren(element, state));
      return content ? `<${tag}>${content}</${tag}>` : '';
    }
    if (tag === 'summary') {
      const content = normalizeInline(convertChildren(element, state));
      return content ? `**${content}**` : '';
    }
    if (tag === 'input') {
      return element.type === 'checkbox' ? '' : '';
    }
    if (BLOCK_TAGS.has(tag)) {
      return `\n${convertChildren(element, state)}\n`;
    }

    return convertChildren(element, state);
  }

  function isIgnored(element, tag) {
    if (IGNORED_TAGS.has(tag) && tag !== 'input') return true;
    if (element.getAttribute('aria-hidden') === 'true') return true;
    if (element.matches('button, [role="button"], .ds-icon-button')) return true;
    if (element.matches('[data-testid="copy-button"], [data-testid="share-button"]')) return true;
    return false;
  }

  function isKatex(element) {
    return element.classList && (element.classList.contains('katex') || element.classList.contains('katex-display'));
  }

  function convertKatex(element, state) {
    const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
    const tex = annotation ? annotation.textContent.trim() : '';
    const display = element.classList.contains('katex-display') || Boolean(element.querySelector('.katex-display'));
    if (!tex) {
      const fallback = normalizeInline(element.textContent);
      return fallback ? protect(state, fallback) : '';
    }
    return display
      ? `\n\n${protect(state, `$$${tex}$$`)}\n\n`
      : protect(state, `$${tex}$`);
  }

  function convertCodeBlock(element, state) {
    const code = element.querySelector('code') || element;
    const content = String(code.textContent || '').replace(/^\n/, '').replace(/\n+$/, '');
    if (!content.trim()) return '';

    let language = '';
    const sources = [
      code.getAttribute('data-language'),
      code.getAttribute('data-lang'),
      code.className,
      element.getAttribute('data-language'),
      element.className,
    ].join(' ');
    const match = sources.match(/(?:language-|lang-)([A-Za-z0-9_+#.-]+)/);
    if (match) language = match[1].toLowerCase();

    if (!language) {
      const banner = element.closest('[class*="code"], [class*="md-code"]');
      const label = banner && banner.querySelector('[class*="language"], [class*="lang"]');
      if (label) {
        const text = normalizeInline(label.textContent);
        if (/^[A-Za-z0-9_+#.-]{1,20}$/.test(text)) language = text.toLowerCase();
      }
    }

    let fence = '```';
    while (content.includes(fence)) fence += '`';
    return `\n\n${protect(state, `${fence}${language}\n${content}\n${fence}`)}\n\n`;
  }

  function convertInlineCode(element, state) {
    if (element.closest('pre')) return element.textContent || '';
    const content = String(element.textContent || '').replace(/\s+/g, ' ').trim();
    if (!content) return '';
    let fence = '`';
    while (content.includes(fence)) fence += '`';
    const padding = content.startsWith('`') || content.endsWith('`') ? ' ' : '';
    return protect(state, `${fence}${padding}${content}${padding}${fence}`);
  }

  function convertImage(element) {
    const source = element.getAttribute('src') || '';
    if (!source || /^data:/i.test(source)) return '';
    const alt = normalizeInline(element.getAttribute('alt') || 'Image');
    const title = element.getAttribute('title');
    return `![${alt}](${source}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
  }

  function convertLink(element, state) {
    const text = normalizeInline(convertChildren(element, state));
    const href = element.getAttribute('href');
    if (!href || /^(javascript|data):/i.test(href)) return text;
    let url = href;
    try {
      url = new URL(href, location.href).href;
    } catch (_error) {
      // Keep the raw href.
    }
    return text ? `[${text}](${url})` : url;
  }

  function convertHeading(element, state, level) {
    const content = normalizeInline(convertChildren(element, state));
    if (!content) return '';
    return `\n\n${'#'.repeat(level)} ${content}\n\n`;
  }

  function convertBlockquote(element, state) {
    const content = normalizeProse(convertChildren(element, state));
    if (!content) return '';
    const quoted = content.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
    return `\n\n${quoted}\n\n`;
  }

  function convertDetails(element, state) {
    const summary = element.querySelector(':scope > summary');
    const title = summary ? normalizeInline(summary.textContent) : 'Details';
    const clone = element.cloneNode(true);
    const cloneSummary = clone.querySelector(':scope > summary');
    if (cloneSummary) cloneSummary.remove();
    const body = htmlToMarkdown(clone);
    if (!body) return '';
    return `\n\n<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>\n\n`;
  }

  function convertList(element, ordered, state) {
    const items = Array.from(element.children).filter((child) => child.tagName.toLowerCase() === 'li');
    if (!items.length) return '';

    const indent = '  '.repeat(state.listDepth || 0);
    const lines = items.map((item, index) => {
      const children = Array.from(item.childNodes);
      const nested = [];
      let content = '';

      for (const child of children) {
        if (child.nodeType === 1 && (child.tagName.toLowerCase() === 'ul' || child.tagName.toLowerCase() === 'ol')) {
          nested.push(convertList(child, child.tagName.toLowerCase() === 'ol', {
            ...state,
            listDepth: (state.listDepth || 0) + 1,
          }));
          continue;
        }
        content += convertNode(child, {
          ...state,
          listDepth: (state.listDepth || 0) + 1,
        });
      }

      const checkbox = item.querySelector('input[type="checkbox"]');
      const task = checkbox ? (checkbox.checked ? '[x] ' : '[ ] ') : '';
      const marker = ordered ? `${index + 1}.` : '-';
      let body = normalizeInline(content).replace(/^[-*+]\s+/, '');
      if (!body && !nested.length) return '';
      if (checkbox) body = `${task}${body}`;
      const firstLine = `${indent}${marker} ${body}`.trimEnd();
      const nestedBlock = nested
        .map((chunk) => String(chunk || '').replace(/^\n+|\n+$/g, ''))
        .filter(Boolean)
        .join('\n');
      return nestedBlock ? `${firstLine}\n${nestedBlock}` : firstLine;
    }).filter(Boolean);

    return `\n\n${lines.join('\n')}\n\n`;
  }

  function convertTable(element, state) {
    const rows = Array.from(element.querySelectorAll('tr')).filter((row) => row.closest('table') === element);
    if (!rows.length) return '';

    const matrix = rows.map((row) => {
      const cells = Array.from(row.children).filter((cell) => {
        const tag = cell.tagName.toLowerCase();
        return tag === 'th' || tag === 'td';
      });
      return cells.map((cell) => {
        const content = normalizeInline(convertChildren(cell, { ...state, inTable: true }));
        return content.replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
      });
    }).filter((row) => row.length > 0);

    if (!matrix.length) return '';
    const columns = Math.max(...matrix.map((row) => row.length));
    const padded = matrix.map((row) => {
      const copy = row.slice();
      while (copy.length < columns) copy.push('');
      return copy;
    });
    const header = padded[0];
    const separator = header.map(() => '---');
    const body = padded.slice(1);
    const lines = [
      `| ${header.join(' | ')} |`,
      `| ${separator.join(' | ')} |`,
      ...body.map((row) => `| ${row.join(' | ')} |`),
    ];
    return `\n\n${lines.join('\n')}\n\n`;
  }

  return {
    htmlToMarkdown,
    normalizeMarkdown: normalizeProse,
    normalizeInline,
  };
});
