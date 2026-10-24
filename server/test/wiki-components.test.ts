import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderMarkdown } from '../../web/src/lib/markdown';
import { transformWikiComponents } from '../../web/src/lib/wikiComponents';
import { sanitizeNoteHtml } from '../../web/src/lib/noteHtml';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
type Mode = 'Reading' | 'Live Preview';

async function render(mode: Mode, src: string): Promise<any> {
  if (mode === 'Reading') return new JSDOM(await renderMarkdown(src, { rawUrl: (p) => '/' + p })).window.document;
  const dom = new JSDOM('');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    return new JSDOM(sanitizeNoteHtml(transformWikiComponents(src))).window.document;
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
    dom.window.close();
  }
}

const cards = (attrs = '') => `<AppCards ${attrs} :links="[{text: 'Hello', desc: 'Description', link: '/page'}]" />`;
const gallery = (attrs = '') => `<Gallery ${attrs}>\n![Photo](/photo.png)\n</Gallery>`;

for (const mode of ['Reading', 'Live Preview'] as const) {
  test(`${mode}: AppCards preserves valid width and title/description line counts`, async () => {
    const doc = await render(mode, cards('width="24em" text-lines="4" desc-lines="3"'));
    assert.equal(doc.querySelector('.app-cards').style.getPropertyValue('--col-width'), '24em');
    assert.equal(doc.querySelector('.content').style.getPropertyValue('--lines'), '4');
    assert.equal(doc.querySelector('.link-desc').style.getPropertyValue('--lines'), '3');
    assert.equal(doc.querySelector('a.card').getAttribute('href'), '/page');
    assert.equal(doc.querySelector('.content').textContent, 'Hello');
    for (const width of ['320px', '18.5rem', '50%']) {
      const variant = await render(mode, cards(`width="${width}"`));
      assert.equal(variant.querySelector('.app-cards').style.getPropertyValue('--col-width'), width);
    }
  });

  test(`${mode}: Gallery preserves finite gap/height including zero gap`, async () => {
    const doc = await render(mode, gallery('gap="0" row-height="240"'));
    const el = doc.querySelector('.qut-gallery');
    assert.equal(el.style.getPropertyValue('--gallery-gap'), '0px');
    assert.equal(el.style.getPropertyValue('--gallery-row-height'), '240px');
    assert.equal(el.querySelector('img').getAttribute('src'), '/photo.png');
    const fractional = await render(mode, gallery('gap="8.5" row-height="180.5"'));
    assert.equal(fractional.querySelector('.qut-gallery').style.getPropertyValue('--gallery-gap'), '8.5px');
    assert.equal(fractional.querySelector('.qut-gallery').style.getPropertyValue('--gallery-row-height'), '180.5px');
  });

  test(`${mode}: malformed, excessive and injected component parameters use safe defaults`, async () => {
    for (const value of ['1px;position:fixed;inset:0', 'url(https://attacker.invalid)', 'var(--evil)', 'calc(100vw)', '-1px', '999999px', 'Infinity', '1e9px', '']) {
      const doc = await render(mode, cards(`width="${value}" text-lines="${value}" desc-lines="${value}"`));
      assert.equal(doc.querySelector('.app-cards').style.getPropertyValue('--col-width'), '12em');
      assert.equal(doc.querySelector('.content').style.getPropertyValue('--lines'), '2');
      assert.equal(doc.querySelector('.link-desc').style.length, 0);
      assert.ok(!doc.querySelector('[style*="position"], [style*="url("], [style*="var("], [style*="calc("]'));
    }
    for (const value of ['0', '1.5', '21', '999999']) {
      const doc = await render(mode, cards(`text-lines="${value}"`));
      assert.equal(doc.querySelector('.content').style.getPropertyValue('--lines'), '2');
    }
    for (const value of ['-1', '999999', 'Infinity', '1e6', '1;position:fixed', 'calc(2)']) {
      const doc = await render(mode, gallery(`gap="${value}" row-height="${value}"`));
      assert.equal(doc.querySelector('.qut-gallery').style.length, 0);
    }
  });

  test(`${mode}: raw inline style and forged layout attributes cannot inject CSS or events`, async () => {
    const doc = await render(mode, `<div class="app-cards" data-nku-card-width="24em;position:fixed" style="position:fixed;inset:0" onclick="alert(1)">X</div>
<span class="text-ellipsis content" data-nku-lines="4;position:fixed" style="--lines:99">Y</span>
<div class="qut-gallery" data-nku-gallery-gap="url(https://attacker.invalid)" data-nku-gallery-height="1000;z-index:999999">Z</div>
<a style="position:fixed" href="javascript:alert(1)">unsafe</a>`);
    assert.equal(doc.querySelectorAll('[style], [onclick]').length, 0);
    assert.ok(!doc.querySelector('a')?.getAttribute('href')?.startsWith('javascript:'));
    const bounded = await render(mode, '<div class="app-cards" data-nku-card-width="20rem" style="position:fixed">X</div>');
    const el = bounded.querySelector('.app-cards');
    assert.equal(el.style.length, 1);
    assert.equal(el.style.getPropertyValue('--col-width'), '20rem');
    assert.equal(el.style.position, '');
    const wrongKind = await render(mode, '<p data-nku-card-width="20rem">X</p>');
    assert.equal(wrongKind.querySelectorAll('[style]').length, 0);
  });

  test(`${mode}: absent optional layout parameters retain component defaults`, async () => {
    const doc = await render(mode, cards());
    assert.equal(doc.querySelector('.app-cards').style.getPropertyValue('--col-width'), '12em');
    assert.equal(doc.querySelector('.content').style.getPropertyValue('--lines'), '2');
    assert.equal(doc.querySelector('.link-desc').style.length, 0);
    const images = await render(mode, gallery());
    assert.equal(images.querySelector('.qut-gallery').style.length, 0);
  });
}
