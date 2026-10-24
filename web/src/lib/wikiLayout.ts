/** Only these bounded component parameters can become CSS after sanitization.
 * Raw note style attributes are never passed through, including custom properties.
 */
export const WIKI_LAYOUT_ATTRIBUTES = {
  width: 'data-nku-card-width',
  lines: 'data-nku-lines',
  gap: 'data-nku-gallery-gap',
  height: 'data-nku-gallery-height',
} as const;

function decimal(value: string | undefined, min: number, max: number): string | undefined {
  if (!value || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return undefined;
  const number = Number(value);
  return number >= min && number <= max ? String(number) : undefined;
}

export function cardWidth(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?|\.\d+)(px|em|rem|%)$/);
  if (!match) return undefined;
  const number = decimal(match[1], 0.1, match[2] === 'px' ? 1600 : 100);
  return number === undefined ? undefined : number + match[2];
}

export function lineCount(value: string | undefined): string | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  return decimal(value.trim(), 1, 20);
}

export function galleryGap(value: string | undefined): string | undefined {
  return decimal(value?.trim(), 0, 128);
}

export function galleryHeight(value: string | undefined): string | undefined {
  return decimal(value?.trim(), 1, 1200);
}

/** Safe even for forged data attributes: names are fixed and values revalidated. */
export function wikiLayoutStyle(tag: string, classes: string[], get: (name: string) => string | undefined): string {
  const styles: string[] = [];
  if (tag === 'div' && classes.includes('app-cards')) {
    const width = cardWidth(get(WIKI_LAYOUT_ATTRIBUTES.width));
    if (width !== undefined) styles.push(`--col-width:${width}`);
  }
  if (tag === 'span' && classes.includes('text-ellipsis') &&
      (classes.includes('content') || classes.includes('link-desc'))) {
    const lines = lineCount(get(WIKI_LAYOUT_ATTRIBUTES.lines));
    if (lines !== undefined) styles.push(`--lines:${lines}`);
  }
  if (tag === 'div' && classes.includes('qut-gallery')) {
    const gap = galleryGap(get(WIKI_LAYOUT_ATTRIBUTES.gap));
    const height = galleryHeight(get(WIKI_LAYOUT_ATTRIBUTES.height));
    if (gap !== undefined) styles.push(`--gallery-gap:${gap}px`);
    if (height !== undefined) styles.push(`--gallery-row-height:${height}px`);
  }
  return styles.join(';');
}

interface HtmlNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
}

/** Run only after rehype-sanitize; it does not allow any input style through. */
export function rehypeWikiLayout() {
  return (tree: HtmlNode) => {
    const visit = (node: HtmlNode) => {
      if (node.tagName && node.properties) {
        const props = node.properties;
        const names = Array.isArray(props.className) ? props.className.map(String) : [];
        const style = wikiLayoutStyle(node.tagName, names, (name) => {
          const key = name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
          const value = props[key];
          return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
        });
        if (style) props.style = style;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
