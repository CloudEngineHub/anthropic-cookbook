/**
 * Page-side DOM extraction. Runs inside page.evaluate() — no node imports,
 * no closures over worker scope. Produces a numbered list of interactive
 * elements and a rough text rendering.
 *
 * Kept as a raw string literal (not a stringified function) so wrangler's
 * esbuild doesn't inject __name() helpers that don't exist in the page
 * context.
 */

export interface ExtractResult {
  url: string;
  title: string;
  text: string;
  map: Record<string, string>;
}

export const EXTRACT_SCRIPT = `(() => {
  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) {
        sel += '#' + CSS.escape(cur.id);
        parts.unshift(sel);
        break;
      }
      const sibs = cur.parentElement
        ? Array.from(cur.parentElement.children).filter(
            (s) => s.tagName === cur.tagName,
          )
        : [];
      if (sibs.length > 1) {
        sel += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ') || 'body';
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  function label(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    if (el.tagName === 'INPUT')
      return el.placeholder || el.name || el.type;
    if (el.tagName === 'TEXTAREA')
      return el.placeholder || el.name || 'textarea';
    if (el.tagName === 'SELECT') {
      const opts = Array.from(el.options || [])
        .slice(0, 8)
        .map(o => o.value)
        .join('|');
      return (el.name || 'select') + ' opts:[' + opts +
        (el.options.length > 8 ? '|…' : '') + ']';
    }
    const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    return t.slice(0, 80);
  }

  const interactive = Array.from(
    document.querySelectorAll(
      'a[href], button, input, textarea, select, [role="button"], [onclick]',
    ),
  ).filter(visible);

  const map = {};
  const lines = [];
  interactive.forEach((el, i) => {
    const idx = '[' + i + ']';
    const sel = cssPath(el);
    map[idx] = sel;
    const tag = el.tagName.toLowerCase();
    const href =
      el.tagName === 'A' && el.href
        ? ' → ' + el.href.slice(0, 80)
        : '';
    lines.push(idx + ' <' + tag + '> ' + label(el) + href);
  });

  const bodyText = (document.body && document.body.innerText || '')
    .replace(/\\n{3,}/g, '\\n\\n')
    .slice(0, 6000);

  return {
    url: location.href,
    title: document.title,
    text:
      '# ' + document.title + '\\n' + location.href + '\\n\\n' +
      '## Interactive elements (' + interactive.length + ')\\n' +
      lines.join('\\n') +
      '\\n\\n## Page text\\n' + bodyText,
    map: map,
  };
})()`;
