import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { CALLOUT_RE, calloutTypeSlot, calloutDefaultTitle } from './callouts';
import { VIDEO_EXT_RE, AUDIO_EXT_RE } from './media';
import { transformWikiComponents } from './wikiComponents';
import { rehypeWikiLayout } from './wikiLayout';

// Sanitize schema extended to keep the attributes our wikilinks/callouts use.
// 注意：刻意不放行 `style`。公开编辑模式下笔记内容来自任意访客，任意 CSS 可以
// 用 position:fixed 覆盖层伪造编辑器 UI（对查看预览的 owner 做界面钓鱼）；
// 组件参数经 data 属性传递，消毒后仅重建经过严格校验的布局变量。
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Default schema constrains a.className to footnote classes — drop that
    // entry and allow any class (internal-link / embed / tag / external-link).
    a: [
      ...(defaultSchema.attributes?.a ?? []).filter((x) => !(Array.isArray(x) && x[0] === 'className')),
      ['className'],
      ['dataWikilink'],
      ['dataHref'],
      ['target'],
      ['rel'],
    ],
    div: [...(defaultSchema.attributes?.div ?? []), ['className'], ['dataCallout'], ['dataCalloutFold'], ['role'], ['dataNkuCardWidth'], ['dataNkuGalleryGap'], ['dataNkuGalleryHeight']],
    span: [...(defaultSchema.attributes?.span ?? []), ['className'], ['dataTex'], ['dataTexDisplay'], ['dataCalloutIcon'], ['dataNkuLines']],
    li: [...(defaultSchema.attributes?.li ?? []), ['className'], ['dataTask']],
    input: [['type'], ['checked'], ['disabled'], ['className'], ['dataTask']],
    img: [...(defaultSchema.attributes?.img ?? []), ['src'], ['alt'], ['dataEmbed'], ['loading'], ['width'], ['height']],
    video: [['src'], ['controls'], ['preload'], ['width'], ['height'], ['className'], ['dataEmbed'], ['loop'], ['playsInline']],
    audio: [['src'], ['controls'], ['preload'], ['className'], ['dataEmbed'], ['loop']],
    source: [['src'], ['type']],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), 'input', 'mark', 'u', 'video', 'audio', 'source'],
};

interface MdNode {
  type: string;
  checked?: boolean | null;
  value?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: MdNode[];
}

/**
 * Obsidian task semantics (§7): `[c]` with ANY single char is a task; any
 * non-space char counts as done. remark-gfm only recognizes ` `/`x`/`X`, so
 * custom states (`[/]`, `[-]`, `[>]`…) are turned into checkboxes here, and
 * every task <li> gets `data-task` so CSS can strike only x/X like Obsidian.
 */
function remarkObsidianTasks() {
  return (tree: MdNode) => {
    const visit = (node: MdNode) => {
      if (node.type === 'listItem') {
        node.data = node.data ?? {};
        if (node.checked === true || node.checked === false) {
          node.data.hProperties = {
            ...node.data.hProperties,
            className: 'task-list-item' + (node.checked ? ' is-checked' : ''),
            'data-task': node.checked ? 'x' : ' ',
          };
        } else {
          const para = node.children?.[0];
          const txt = para?.type === 'paragraph' ? para.children?.[0] : undefined;
          const m = txt?.type === 'text' ? txt.value?.match(/^\[(.)\] /) : null;
          if (m && para?.children && txt) {
            txt.value = txt.value!.slice(m[0].length);
            const done = m[1] !== ' ';
            node.data.hProperties = {
              ...node.data.hProperties,
              className: 'task-list-item' + (done ? ' is-checked' : ''),
              'data-task': m[1],
            };
            para.children.unshift({
              type: 'html',
              value: `<input type="checkbox" class="task-list-item-checkbox" disabled${done ? ' checked' : ''}> `,
            });
          }
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // Obsidian dialect: single newline renders as <br> (breaks: true, §7)
  .use(remarkBreaks)
  .use(remarkObsidianTasks as any)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema as any)
  .use(rehypeWikiLayout)
  .use(rehypeStringify);

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const IMG_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i;

/**
 * Pre-process Obsidian-flavored syntax before markdown parsing:
 *  - ![[image.png]]  → embedded image
 *  - ![[note]]       → embed link (rendered as link for now)
 *  - [[note|alias]]  → internal link
 *  - > [!note] ...   → callout
 */
// Tag body charset (§7) — same rule as the editor (needs a letter, not all digits).
const TAG_READ_RE = /(^|\s)(#[^\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s]+)/g;

function preprocess(src: string, rawUrl: (p: string) => string): string {
  // Strip YAML frontmatter (rendered separately as properties, like Obsidian)
  src = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  // Protect code (fenced + inline) so Obsidian syntax inside it stays literal —
  // e.g. `![[file]]` in backticks is sample text, not an embed. Restored below.
  const code: string[] = [];
  const stash = (m: string) => `\x00${code.push(m) - 1}\x00`;
  src = src.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, stash);
  src = src.replace(/`[^`\n]+`/g, stash);
  // QUTWiKi 自定义组件（Gallery/AppCards/Flink）：在代码保护之后、其它语法转换
  // 之前转换为等价 HTML。此时 Gallery 内部的 Markdown 图片尚未被标准图片正则
  // 处理，转换才能识别；生成的块级 HTML 由 remark 原样保留、rehype-raw 解析。
  src = src.replace(
    /<Gallery\b[^>]*>[\s\S]*?<\/Gallery>|<AppCards\b[^>]*?\/>|<flink\b[^>]*>[\s\S]*?<\/flink\s*>|<flink\b[^>]*?\/>|<flink\b[^>]*?>\s*<\/flink\s*>/g,
    (m) => transformWikiComponents(m, rawUrl),
  );
  // %%Comments%% are dropped from reading view (§7): block fences then inline.
  src = src.replace(/^%%[ \t]*\n[\s\S]*?\n%%[ \t]*$/gm, '');
  src = src.replace(/%%(.+?)%%/g, '');
  // Math → placeholders rendered by KaTeX after sanitize (display first).
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) =>
    stash(`<span class="math math-block" data-tex="${esc(tex.trim())}" data-tex-display="1">${esc(tex)}</span>`),
  );
  src = src.replace(
    /(?<![$\\])\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?!\d|\$)/g,
    (_m, tex: string) => stash(`<span class="math math-inline" data-tex="${esc(tex)}">${esc(tex)}</span>`),
  );
  // ==Highlight== → <mark> (open not followed by space/=, §7)
  src = src.replace(/==(?![\s=])(.+?)==/g, '<mark>$1</mark>');
  // Trailing block ids ` ^abc-123` are invisible in reading view.
  src = src.replace(/(^|\s)\^[a-zA-Z0-9-]+(?=[ \t]*$)/gm, '');
  // Embeds first (![[...]])
  src = src.replace(/!\[\[([^\]]+?)\]\]/g, (m, inner: string) => {
    if (inner.includes('[[')) return m;
    const pi = inner.indexOf('|');
    const t = (pi > 0 ? inner.slice(0, pi) : inner).trim();
    if (IMG_RE.test(t)) {
      // size param: last `|` segment `300` or `300x200` (§7)
      let size = '';
      if (pi > 0) {
        const segs = inner.split('|');
        const sm = segs[segs.length - 1].match(/^\s*([0-9]+)\s*(?:x\s*([0-9]+)\s*)?$/);
        if (sm) size = ` width="${sm[1]}"${sm[2] ? ` height="${sm[2]}"` : ''}`;
      }
      return `<img src="${rawUrl(t)}" alt="${esc(t)}" data-embed="1"${size} />`;
    }
    if (VIDEO_EXT_RE.test(t) || AUDIO_EXT_RE.test(t)) {
      const isVid = VIDEO_EXT_RE.test(t);
      // size param (video only): last `|` segment `300` / `300x200` → width/height
      let size = '';
      if (isVid && pi > 0) {
        const segs = inner.split('|');
        const sm = segs[segs.length - 1].match(/^\s*([0-9]+)\s*(?:x\s*([0-9]+)\s*)?$/);
        if (sm) size = ` width="${sm[1]}"${sm[2] ? ` height="${sm[2]}"` : ''}`;
      }
      const tag = isVid ? 'video' : 'audio';
      return `<${tag} class="media-embed" src="${rawUrl(t)}" controls preload="metadata" data-embed="1"${size}></${tag}>`;
    }
    return `<a class="internal-link embed" data-wikilink="${esc(t)}" href="#">${esc(inner)}</a>`;
  });
  // Standard markdown images ![alt](url): load web URLs directly, resolve any
  // relative path or custom scheme by basename via the vault file index.
  src = src.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, rawTarget: string) => {
    const url = rawTarget.replace(/\s+"[^"]*"$/, '').trim();
    const webLoadable = /^(https?|data|blob|file):/i.test(url);
    const finalSrc = webLoadable ? url : rawUrl(url.split('/').pop() || url);
    // size param in the alt text: `![alt|300](url)` / `![|300x200](url)` (§7)
    let altText = alt;
    let size = '';
    const ai = alt.lastIndexOf('|');
    if (ai >= 0) {
      const sm = alt.slice(ai + 1).match(/^\s*([0-9]+)\s*(?:x\s*([0-9]+)\s*)?$/);
      if (sm) {
        size = ` width="${sm[1]}"${sm[2] ? ` height="${sm[2]}"` : ''}`;
        altText = alt.slice(0, ai);
      }
    }
    return `<img src="${esc(finalSrc)}" alt="${esc(altText)}"${size} />`;
  });
  // Links [[target|alias]] — alias after the FIRST `|`; default display text in
  // reading view is `href.split('#').join(' > ')` (§7).
  src = src.replace(/\[\[([^\]]+?)\]\]/g, (m, inner: string) => {
    if (inner.includes('[[')) return m;
    const pi = inner.indexOf('|');
    const target = (pi > 0 ? inner.slice(0, pi) : inner).replace(/\u00A0/g, ' ').trim().normalize('NFC');
    const alias = pi > 0 ? inner.slice(pi + 1).trim() : null;
    const label = alias || target.split('#').filter(Boolean).join(' > ') || target;
    return `<a class="internal-link" data-wikilink="${esc(target)}" href="#">${esc(label)}</a>`;
  });
  // Inline tags → pills (after links so attribute/label text is untouched).
  src = src.replace(TAG_READ_RE, (m, pre: string, tag: string) => {
    if (/^#\d+$/.test(tag) || !/[a-z]/i.test(tag)) return m;
    return `${pre}<a class="tag" href="#">${esc(tag)}</a>`;
  });
  // Callouts: exact first-line regex (§7), §20 DOM, fold via data attr + class.
  src = src.replace(/^>[ \t]?(\[![^\n]*)$((?:\n>.*)*)/gm, (m, first: string, rest: string) => {
    const cm = first.match(CALLOUT_RE);
    if (!cm) return m;
    const { type, slot } = calloutTypeSlot(cm[1]);
    const fold = cm[2];
    const title = first.slice(cm[0].length).trim() || calloutDefaultTitle(type);
    const bodyLines = rest
      .split('\n')
      .filter(Boolean)
      .map((l) => l.replace(/^> ?/, ''))
      .join('\n');
    return `<div class="callout${fold === '-' ? ' is-collapsed' : ''}" data-callout="${esc(type)}" data-callout-fold="${fold}"><div class="callout-title"><span class="callout-icon" data-callout-icon="${esc(slot)}"></span><span class="callout-title-inner">${esc(title)}</span></div><div class="callout-content">\n\n${bodyLines}\n\n</div></div>`;
  });
  // Restore protected code spans now that Obsidian-syntax transforms are done.
  src = src.replace(/ (\d+) /g, (_m, i: string) => code[+i]);
  return src;
}

/** Render leading YAML frontmatter as an Obsidian-like properties block. */
function frontmatterHtml(src: string): string {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  const unquote = (s: string) => s.replace(/^["'](.*)["']$/, '$1');
  type P = { key: string; vals: string[]; list: boolean };
  const props: P[] = [];
  let cur: P | null = null;
  for (const line of m[1].split('\n')) {
    const li = line.match(/^\s*-\s+(.+)$/);
    const kv = line.match(/^([\w .-]+?):\s*(.*)$/);
    if (li && cur) {
      cur.list = true;
      cur.vals.push(unquote(li[1].trim()));
    } else if (kv) {
      cur = { key: kv[1].trim(), vals: [], list: false };
      const val = kv[2].trim();
      const arr = val.match(/^\[(.*)\]$/);
      if (arr) {
        cur.list = true;
        cur.vals = arr[1].split(',').map((s) => unquote(s.trim())).filter(Boolean);
      } else if (val) {
        cur.vals = [unquote(val)];
      }
      props.push(cur);
    }
  }
  const rows = props
    .map((p) => {
      const val = p.list
        ? p.vals.map((v) => `<span class="prop-pill">${esc(v)}</span>`).join(' ')
        : esc(p.vals[0] ?? '');
      return `<div class="prop-row"><span class="prop-key">${esc(p.key)}</span><span class="prop-val">${val}</span></div>`;
    })
    .join('');
  return rows ? `<div class="properties">${rows}</div>` : '';
}

export interface RenderOpts {
  rawUrl: (p: string) => string;
  /** Resolve a non-image embed target to its markdown content (transclusion). */
  resolveEmbed?: (target: string) => Promise<{ path: string; content: string } | null>;
}

const IMG_EMBED_RE = /!\[\[([^\]]+?)\]\]/g;

/** Expand `![[note]]` transclusions inline (images are left for preprocess). */
async function expandEmbeds(src: string, opts: RenderOpts, depth: number): Promise<string> {
  if (!opts.resolveEmbed || depth > 3) return src;
  const matches = [...src.matchAll(IMG_EMBED_RE)];
  let out = src;
  for (const m of matches) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    // images & a/v are rendered as elements in preprocess, not transcluded
    if (IMG_RE.test(target) || VIDEO_EXT_RE.test(target) || AUDIO_EXT_RE.test(target)) continue;
    const note = await opts.resolveEmbed(target);
    if (!note) continue;
    const stripped = note.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    const inner = await renderMarkdown(stripped, opts, depth + 1);
    const block = `<div class="embed-note"><div class="embed-title">${esc(target)}</div>${inner}</div>`;
    out = out.replace(m[0], block);
  }
  return out;
}

export async function renderMarkdown(
  src: string,
  opts: RenderOpts,
  depth = 0,
): Promise<string> {
  const props = depth === 0 ? frontmatterHtml(src) : '';
  const expanded = await expandEmbeds(src, opts, depth);
  const pre = preprocess(expanded, opts.rawUrl);
  const file = await processor.process(pre);
  return props + String(file);
}

/** Build an outline (headings) for the outline panel. `line` 为 0 基行号。 */
export function outline(src: string): { level: number; text: string; line: number }[] {
  const out: { level: number; text: string; line: number }[] = [];
  src.split('\n').forEach((line, idx) => {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2], line: idx });
  });
  return out;
}
