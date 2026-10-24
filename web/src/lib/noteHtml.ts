import { wikiLayoutStyle } from './wikiLayout';

// Live Preview's raw-note HTML boundary. Reading uses rehype-sanitize instead.
const HTML_DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base']);
export function sanitizeNoteHtml(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const el of Array.from(tpl.content.querySelectorAll('*'))) {
    if (HTML_DROP_TAGS.has(el.tagName.toLowerCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on') || n === 'style') el.removeAttribute(attr.name);
      else if ((n === 'href' || n === 'src' || n === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    // Recreate only bounded, component-specific layout properties after all raw
    // style has been removed. Fabricated data attributes pass the same validator.
    const style = wikiLayoutStyle(el.tagName.toLowerCase(), Array.from(el.classList),
      (name) => el.getAttribute(name) ?? undefined);
    if (style) el.setAttribute('style', style);
  }
  return tpl.innerHTML;
}
