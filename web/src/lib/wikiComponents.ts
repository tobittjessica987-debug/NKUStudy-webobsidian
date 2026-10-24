/**
 * QUTWiKi 自定义 Vue 组件的静态 HTML 渲染适配。
 *
 * 编辑器的 Reading / Preview 走 unified(remark→rehype) 管线，无法执行 Vue 组件，
 * 因此这里把 Markdown 中出现的三类组件预转换成等价的纯 HTML（配合 obsidian.css
 * 中的样式），使其在编辑器里也能正确显示：
 *   - <Gallery>…</Gallery>          图片画廊
 *   - <AppCards :links="[...]" />   应用卡片
 *   - <flink>…</flink> / <flink …/> 友链卡片
 *
 * 不处理依赖外置数据文件或 Twikoo 的组件（XLSX 卡片、FoodCards）。
 */

import { cardWidth, lineCount, galleryGap, galleryHeight } from './wikiLayout';

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** 仅允许 http/https 或站内相对链接，其余返回 undefined（对齐组件逻辑）。 */
function safeLink(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^(\/|\.\/|\.\.\/|#)/.test(value)) return value.startsWith('//') ? undefined : value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 从标签属性串里取 `key="value"` / `:key="value"`。 */
function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`:?${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = tag.match(re);
  return m ? m[1] : undefined;
}

/* ---------------- AppCards ---------------- */

interface AppCard {
  text?: string;
  icon?: string;
  desc?: string;
  link?: string;
}

/** 解析 `:links` 的 JS 数组字面量（键可无引号，值用单/双引号）。 */
function parseAppCards(raw: string): AppCard[] {
  const out: AppCard[] = [];
  const objRe = /\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(raw))) {
    const body = m[1];
    const item: AppCard = {};
    const kvRe = /([\w-]+)\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
    let kv: RegExpExecArray | null;
    while ((kv = kvRe.exec(body))) {
      const key = kv[1];
      const val = (kv[2] ?? kv[3] ?? '').replace(/\\(['"\\])/g, '$1');
      if (key === 'text') item.text = val;
      else if (key === 'icon') item.icon = val;
      else if (key === 'desc') item.desc = val;
      else if (key === 'link') item.link = val;
    }
    if (item.text || item.desc) out.push(item);
  }
  return out;
}

function renderAppCards(tag: string): string {
  const raw = attr(tag, 'links') ?? '';
  const items = parseAppCards(raw);
  if (!items.length) return '';
  const width = cardWidth(attr(tag, 'width')) ?? '12em';
  const textLines = lineCount(attr(tag, 'text-lines')) ?? '2';
  const descLines = lineCount(attr(tag, 'desc-lines'));
  const cards = items
    .map((it) => {
      const link = safeLink(it.link);
      const external = link?.startsWith('http') ?? false;
      const tagName = link ? 'a' : 'span';
      const href = link ? ` href="${escapeHtml(link)}"` : '';
      const target = external ? ' target="_blank" rel="noopener noreferrer"' : '';
      const icon = it.icon?.startsWith('http')
        ? `<img class="icon" src="${escapeHtml(it.icon)}" alt="">`
        : '';
      const body =
        it.text || it.desc
          ? `<span class="body">` +
            `<span class="text-ellipsis content" data-nku-lines="${textLines}">${escapeHtml(it.text ?? '')}</span>` +
            (it.desc
              ? `<span class="text-ellipsis link-desc"${descLines ? ` data-nku-lines="${descLines}"` : ''}>${escapeHtml(it.desc)}</span>`
              : '') +
            `</span>`
          : '';
      return `<${tagName} class="link card"${href}${target}>${icon}${body}</${tagName}>`;
    })
    .join('');
  return `<div class="app-cards" data-nku-card-width="${width}">${cards}</div>`;
}

/* ---------------- Flink ---------------- */

interface FlinkItem {
  name: string;
  link: string;
  avatar?: string;
  siteshot?: string;
  desc?: string;
}

const FLINK_ITEM_RE = /^-\s+([\w-]+)\s*:\s*(.*)$/;
const FLINK_KV_RE = /^([\w-]+)\s*:\s*(.*)$/;

function parseFlinkContainer(inner: string): FlinkItem[] {
  const items: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const raw of inner.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const item = line.match(FLINK_ITEM_RE);
    if (item) {
      current = { [item[1]]: item[2] };
      items.push(current);
      continue;
    }
    const kv = line.match(FLINK_KV_RE);
    if (kv && current) current[kv[1]] = kv[2];
  }
  return items
    .filter((it) => it.name && it.link && safeLink(it.link))
    .map((it) => ({
      name: it.name,
      link: it.link,
      desc: it.desc ?? it.descr,
      avatar: it.avatar,
      siteshot: it.siteshot,
    }));
}

function flinkCard(it: FlinkItem): string {
  const link = safeLink(it.link);
  if (!link) return '';
  const shot = it.siteshot
    ? `<div class="qut-flink-img"><img src="${escapeHtml(it.siteshot)}" alt="${escapeHtml(it.name)}" loading="lazy" onerror="this.style.display='none'"></div>`
    : '<div class="qut-flink-img"></div>';
  const avatar = it.avatar
    ? `<img class="qut-flink-avatar" src="${escapeHtml(it.avatar)}" alt="${escapeHtml(it.name)}" loading="lazy" onerror="this.style.display='none'">`
    : '';
  const desc = it.desc ? `<span class="qut-flink-desc">${escapeHtml(it.desc)}</span>` : '';
  return (
    `<a class="qut-flink" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">` +
    shot +
    `<div class="qut-flink-info">${avatar}<span class="qut-flink-title">${escapeHtml(it.name)}</span>${desc}</div>` +
    `</a>`
  );
}

function renderFlinkContainer(inner: string): string {
  const items = parseFlinkContainer(inner);
  if (!items.length) return '';
  return `<div class="qut-flinks" role="list">${items.map(flinkCard).join('')}</div>`;
}

function renderFlinkSingle(tag: string): string {
  const name = attr(tag, 'name');
  const link = attr(tag, 'link');
  if (!name || !link) return '';
  const card = flinkCard({
    name,
    link,
    avatar: attr(tag, 'avatar'),
    siteshot: attr(tag, 'siteshot'),
    desc: attr(tag, 'desc') ?? attr(tag, 'descr'),
  });
  return card ? `<div class="qut-flinks" role="list">${card}</div>` : '';
}

/* ---------------- Gallery ---------------- */

const MD_IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Gallery 内部是 Markdown 图片列表。由于 remark 不会解析块级 HTML 内的
 * Markdown，这里直接把图片语法转成 `<img>`，并用 flex 容器承载。
 * `rawUrl` 用于把站内相对路径解析为可访问地址。
 */
function renderGallery(tag: string, inner: string, rawUrl?: (p: string) => string): string {
  const gap = galleryGap(attr(tag, 'gap'));
  const rowHeight = galleryHeight(attr(tag, 'row-height'));
  const layoutAttrs =
    (gap !== undefined ? ` data-nku-gallery-gap="${gap}"` : '') +
    (rowHeight !== undefined ? ` data-nku-gallery-height="${rowHeight}"` : '');

  const imgs: string[] = [];
  let m: RegExpExecArray | null;
  MD_IMG_RE.lastIndex = 0;
  while ((m = MD_IMG_RE.exec(inner))) {
    const alt = m[1];
    const raw = m[2];
    const webLoadable = /^(https?|data|blob|file):/i.test(raw);
    const src = webLoadable || !rawUrl ? raw : rawUrl(raw.split('/').pop() || raw);
    imgs.push(`<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">`);
  }
  if (!imgs.length) return '';
  return `<div class="qut-gallery" role="list"${layoutAttrs}>${imgs.join('')}</div>`;
}

/**
 * 把 Markdown 源里的自定义组件转换为等价 HTML。
 * 应在其它预处理（代码保护、wikilink 等）之后、返回给 remark 之前调用，
 * 这样生成的 HTML 不会再被后续正则误伤。
 */
export function transformWikiComponents(src: string, rawUrl?: (p: string) => string): string {
  let out = src;

  // <Gallery …>…</Gallery>
  out = out.replace(/<Gallery\b([^>]*)>([\s\S]*?)<\/Gallery>/g, (_m, tag: string, inner: string) =>
    renderGallery(tag, inner, rawUrl),
  );

  // <AppCards … />（可能跨行）
  out = out.replace(/<AppCards\b[^>]*?\/>/g, (m) => renderAppCards(m));

  // <flink>…</flink> 容器（先于单标签处理）
  out = out.replace(/<flink\b[^>]*>\s*\r?\n([\s\S]*?)\r?\n\s*<\/flink\s*>/g, (_m, inner: string) =>
    renderFlinkContainer(inner),
  );

  // <flink … /> 或 <flink …></flink> 单标签
  out = out.replace(/<flink\b([^>]*?)\/>/g, (m) => renderFlinkSingle(m));
  out = out.replace(/<flink\b([^>]*?)>\s*<\/flink\s*>/g, (m) => renderFlinkSingle(m));

  return out;
}
