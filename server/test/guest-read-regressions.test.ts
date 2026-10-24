import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { TreeNode } from '../src/services/vault.js';
import type { GraphData } from '../src/services/links.js';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'nkustudy-guest-read-'));
process.env.DATA_DIR = path.join(fixture, 'data');
process.env.VAULT_PATH = path.join(fixture, 'vault');
delete process.env.WEBOBSIDIAN_PASSWORD;
const content = path.join(process.env.VAULT_PATH, 'content');
const editable = 'space/allowed';
for (const dir of [editable, 'space/private/empty', 'a-private', 'Attachments']) {
  await fs.mkdir(path.join(content, dir), { recursive: true });
}
const { updateSettings } = await import('../src/services/settings.js');
const { hashPassword, issueToken } = await import('../src/services/auth.js');
const { filesRouter } = await import('../src/routes/files.js');
const { searchRouter } = await import('../src/routes/search.js');
const { errorHandler } = await import('../src/middleware/error.js');
const { buildLinkGraph, graphData, updateLinkGraphForFile, resolveLink } = await import('../src/services/links.js');
const { buildFileIndex } = await import('../src/services/fileindex.js');
await updateSettings(async (s) => {
  s.vault.path = process.env.VAULT_PATH!;
  s.vault.root = 'content';
  s.vault.attachmentDir = 'Attachments';
  s.publicEditor.enabled = true;
  s.publicEditor.editableRoot = `content/${editable}`;
  s.git.enabled = false;
  s.git.autoCommitOnSave = false;
  s.auth.userPasswordHash = await hashPassword('synthetic-guest-read-owner');
});
const owner = await issueToken();
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/files', filesRouter);
app.use('/api', searchRouter);
app.use(errorHandler);
const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
function request(method: string, url: string, body?: unknown, asOwner = false) {
  return fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(asOwner ? { Authorization: `Bearer ${owner}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function tree(asOwner = false): Promise<TreeNode> {
  const response = await request('GET', '/api/files', undefined, asOwner);
  assert.equal(response.status, 200);
  return response.json();
}
function paths(node: TreeNode): string[] {
  return [node.path, ...(node.children ?? []).flatMap(paths)];
}
async function graph(asOwner = false): Promise<GraphData> {
  const response = await request('GET', '/api/graph', undefined, asOwner);
  assert.equal(response.status, 200);
  return response.json();
}

test('Guest read regressions preserve permitted folders and graph without exposing private sources', async (t) => {
  try {
    await t.test('Empty editableRoot and readable attachments remain visible, private sibling folders stay hidden', async () => {
      assert.deepEqual(paths(await tree()).sort(), ['', 'space', editable, 'Attachments'].sort());
      const ownerPaths = paths(await tree(true));
      assert.ok(ownerPaths.includes('space/private/empty'));
      assert.ok(ownerPaths.includes('a-private'));
    });

    await t.test('Guest can create, see and rename an empty directory; private create/rename stays rejected', async () => {
      const fresh = `${editable}/Untitled`;
      const renamed = `${editable}/Renamed`;
      assert.equal((await request('POST', '/api/files/folder', { path: fresh })).status, 200);
      assert.ok(paths(await tree()).includes(fresh), 'new row must exist for inline rename');
      assert.equal((await request('PATCH', '/api/files/rename', { from: fresh, to: renamed })).status, 200);
      const visible = paths(await tree());
      assert.ok(visible.includes(renamed));
      assert.ok(!visible.includes(fresh));
      assert.ok((await fs.stat(path.join(content, renamed))).isDirectory());
      assert.equal((await request('POST', '/api/files/folder', { path: 'space/private/new' })).status, 403);
      assert.equal((await request('PATCH', '/api/files/rename', { from: renamed, to: 'space/private/stolen' })).status, 403);
      assert.ok((await fs.stat(path.join(content, renamed))).isDirectory());
      await assert.rejects(fs.stat(path.join(content, 'space/private/new')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(content, 'space/private/stolen')), { code: 'ENOENT' });
    });

    await t.test('Graph retains real readable attachments and unresolved references only from public notes', async () => {
      await fs.writeFile(path.join(content, `${editable}/note.md`), [
        '---', 'tags: [public-marker]', '---', '# Public note',
        '![[Attachments/Image.PNG]]', '![[Photo.PNG]]', '[[Missing]]', '[[Shared]]', '[[secret]]',
        '![[Photo.PNG]]', '[[Shared]]', // duplicate links still produce one edge
        '![[a-private/Hidden.png]]', '![[Gone.png]]', `![[${editable}/Link.png]]`,
      ].join('\n'));
      await fs.writeFile(path.join(content, 'a-private/secret.md'), '---\ntags: [private-marker]\n---\n# Secret\n[[SHARED]]\n[[PrivateOnlyMissing]]\n![[Attachments/PrivateOnly.png]]');
      for (const file of ['Attachments/Image.PNG', 'Attachments/Photo.PNG', 'Attachments/PrivateOnly.png', 'a-private/Hidden.png']) {
        await fs.writeFile(path.join(content, file), 'synthetic image');
      }
      await fs.symlink('../../a-private/Hidden.png', path.join(content, `${editable}/Link.png`));
      await buildFileIndex();
      await buildLinkGraph();
      const ownerGraph = await graph(true);
      assert.deepEqual(ownerGraph, graphData(), 'owner graph is unchanged');
      assert.ok(ownerGraph.nodes.some((node) => node.id === 'a-private/secret.md'));
      const guest = await graph();
      const expected = [
        `${editable}/note.md`, 'attachment:attachments/image.png', 'attachment:photo.png',
        'unresolved:missing', 'unresolved:shared', 'unresolved:secret',
      ].sort();
      assert.deepEqual(guest.nodes.map((node) => node.id).sort(), expected);
      assert.equal(guest.edges.length, expected.length - 1);
      assert.ok(guest.edges.every((edge) => edge.source === `${editable}/note.md`));
      assert.equal(guest.nodes.find((node) => node.id === 'unresolved:shared')?.label, 'Shared', 'private source cannot supply the shared label');
      assert.ok(!JSON.stringify(guest).includes('private-marker'));
      assert.ok(!JSON.stringify(guest).includes('PrivateOnly'));
      assert.ok(!JSON.stringify(guest).includes('Hidden.png'));
      const image = await request('GET', '/api/files/content?path=Photo.PNG');
      assert.equal(image.status, 200, 'indexed basename attachment is genuinely readable');
      assert.equal((await request('GET', '/api/files/content?path=a-private/Hidden.png')).status, 403);
    });

    await t.test('Private note existence does not change an unresolved reference in the guest graph', async () => {
      const before = await graph();
      await fs.rename(path.join(content, 'a-private/secret.md'), path.join(fixture, 'private-note.md'));
      await buildLinkGraph();
      assert.deepEqual(await graph(), before, 'guest only learns reference text already in readable notes');
      await fs.rename(path.join(fixture, 'private-note.md'), path.join(content, 'a-private/secret.md'));
      await buildLinkGraph();
    });
    await t.test('Incremental duplicate-basename resolution agrees for guest and owner without admitting private winners', async () => {
      const first = `${editable}/a/Same.md`;
      const second = `${editable}/b/Same.md`;
      const source = `${editable}/references.md`;
      for (const rel of [first, second]) {
        await fs.mkdir(path.dirname(path.join(content, rel)), { recursive: true });
        await fs.writeFile(path.join(content, rel), '# Same');
      }
      await fs.writeFile(path.join(content, source), '[[Same]]');
      await buildLinkGraph();
      assert.equal(resolveLink('Same'), second);
      await fs.writeFile(path.join(content, first), '# Same updated');
      await updateLinkGraphForFile(first);
      assert.equal(resolveLink('Same'), first);
      for (const asOwner of [false, true]) {
        const data = await graph(asOwner);
        assert.deepEqual(data.edges.filter((edge) => edge.source === source), [{ source, target: first }]);
      }
      const resolved = await request('GET', '/api/resolve?target=Same');
      assert.deepEqual(await resolved.json(), { target: 'Same', path: first });

      const publicGraph = await graph();
      const hidden = 'a-private/Same.md';
      await fs.writeFile(path.join(content, hidden), '# Private duplicate');
      await updateLinkGraphForFile(hidden);
      assert.equal(resolveLink('Same'), hidden);
      const guest = await graph();
      assert.ok(!guest.nodes.some((node) => node.id === hidden));
      assert.deepEqual(guest.edges.filter((edge) => edge.source === source), [{ source, target: first }]);
      assert.deepEqual(guest, publicGraph, 'adding a private duplicate must not change public resolution');
      await fs.writeFile(path.join(content, hidden), '# Private duplicate updated');
      await updateLinkGraphForFile(hidden);
      assert.deepEqual(await graph(), publicGraph, 'updating a private duplicate must not change public resolution');
      await fs.unlink(path.join(content, hidden));
      await updateLinkGraphForFile(hidden, true);
      assert.deepEqual(await graph(), publicGraph, 'deleting a private duplicate must not change public resolution');
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
