import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import express from 'express';
import cookieParser from 'cookie-parser';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'nkustudy-paths-'));
process.env.DATA_DIR = path.join(fixture, 'data');
process.env.VAULT_PATH = path.join(fixture, 'vault');
delete process.env.WEBOBSIDIAN_PASSWORD;
const root = path.join(process.env.VAULT_PATH, 'content');
await fs.mkdir(path.join(root, 'allowed'), { recursive: true });
await fs.mkdir(path.join(root, 'private'), { recursive: true });
await fs.writeFile(path.join(root, 'private/sentinel.md'), '# Sentinel\nprivate');
await fs.writeFile(path.join(root, 'allowed/sentinel.md'), '# Sentinel\nallowed');
await fs.writeFile(path.join(process.env.VAULT_PATH, 'outside-content.md'), 'outside');
const { updateSettings } = await import('../src/services/settings.js');
const { hashPassword, issueToken } = await import('../src/services/auth.js');
const { agentRouter } = await import('../src/routes/agent.js');
const { createKey } = await import('../src/services/apikeys.js');
const { filesRouter } = await import('../src/routes/files.js');
const { searchRouter } = await import('../src/routes/search.js');
const { gitRouter } = await import('../src/routes/git.js');
const { errorHandler } = await import('../src/middleware/error.js');
const vault = await import('../src/services/vault.js');
const { qmd } = await import('../src/services/search.js');
// Track real asynchronous router indexing so negative assertions start after
// the preceding successful request has completed its side effects.
const pendingIndexes = new Set<Promise<void>>();
const actualUpsert = qmd.upsert.bind(qmd);
qmd.upsert = (rel: string) => {
  const pending = actualUpsert(rel); pendingIndexes.add(pending);
  void pending.finally(() => pendingIndexes.delete(pending)); return pending;
};
async function settleIndexes() { while (pendingIndexes.size) await Promise.all([...pendingIndexes]); }
const { buildLinkGraph, graphData } = await import('../src/services/links.js');
await updateSettings(async (s) => {
  s.vault.path = process.env.VAULT_PATH!; s.vault.root = 'content';
  s.publicEditor.enabled = true; s.publicEditor.editableRoot = 'content/allowed';
  s.vault.deleteMode = 'permanent'; s.git.enabled = false; s.git.autoCommitOnSave = false;
  s.auth.userPasswordHash = await hashPassword('fixture-owner-password');
});
const owner = await issueToken();
const git = (...args: string[]) => execFileSync('git', args, { cwd: process.env.VAULT_PATH, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
git('init', '-q', '-b', 'fixture'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('add', '.'); git('commit', '-qm', 'fixture');
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use('/api/files', filesRouter); app.use('/api/search', searchRouter); app.use('/api/git', gitRouter); app.use('/api/v1', agentRouter); app.use(errorHandler);
const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/files`;
async function request(method: string, url: string, body?: unknown, asOwner = false) {
  return fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(asOwner ? { Authorization: `Bearer ${owner}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function tree() {
  const out: Record<string, string> = {};
  async function walk(abs: string) {
    const st = await fs.lstat(abs); const rel = path.relative(process.env.VAULT_PATH!, abs);
    if (st.isSymbolicLink()) out[rel] = `link:${await fs.readlink(abs)}`;
    else if (st.isDirectory()) { out[rel] = 'directory'; for (const n of (await fs.readdir(abs)).sort()) await walk(path.join(abs, n)); }
    else out[rel] = createHash('sha256').update(await fs.readFile(abs)).digest('hex');
  }
  await walk(process.env.VAULT_PATH!);
  return out;
}
async function state() { await settleIndexes(); return { tree: await tree(), search: await qmd.search('sentinel'), graph: graphData(), index: git('ls-files', '--stage'), status: git('status', '--porcelain'), head: git('rev-parse', 'HEAD') }; }
async function rejected(method: string, url: string, body?: unknown, asOwner = false) {
  await settleIndexes(); await qmd.build(); await buildLinkGraph(); const before = await state();
  const response = await request(method, url, body, asOwner);
  assert.ok([400, 403, 409].includes(response.status), `${method} ${url}: ${response.status} ${await response.text()}`);
  assert.deepEqual(await state(), before, 'denial must not mutate disk, index, graph or Git');
}

test('PATH-01–11 canonical object authorization and no side effects', async (t) => {
  try {
    await t.test('PATH-01 allowed write/read/search remains available; direct private denied', async () => {
      const response = await request('PUT', '/content', { path: 'allowed/valid.md', content: '---\ntitle: Valid note\n---\nsentinel valid' });
      assert.equal(response.status, 200); assert.match(await fs.readFile(path.join(root, 'allowed/valid.md'), 'utf8'), /Valid note/);
      await qmd.upsert('allowed/valid.md'); assert.ok((await qmd.search('sentinel')).some((hit: any) => hit.path === 'allowed/valid.md'));
      await rejected('PUT', '/content', { path: 'private/sentinel.md', content: 'changed' });
    });
    await t.test('PATH-02/03 final dotdot target and content escape denied for guest/owner', async () => {
      for (const p of ['allowed/../private/sentinel.md', 'allowed/../../outside-content.md']) await rejected('PUT', '/content', { path: p, content: 'changed' });
      await rejected('PUT', '/content', { path: '../outside-content.md', content: 'changed' }, true);
    });
    await t.test('PATH-04/05 symlink private/external, existing and missing descendants denied', async () => {
      await fs.symlink('../private', path.join(root, 'allowed/link-private'));
      await fs.symlink('../..', path.join(root, 'allowed/link-external'));
      for (const p of ['allowed/link-private/sentinel.md', 'allowed/link-private/new/future.md', 'allowed/link-external/outside-content.md', 'allowed/link-external/new/future.md']) {
        await rejected('PUT', '/content', { path: p, content: 'changed' });
        await rejected('PUT', '/content', { path: p, content: 'changed' }, true);
      }
    });
    await t.test('PATH-06/07 rename/copy both endpoints and recursive hidden entries preflighted', async () => {
      for (const method of ['rename', 'copy']) for (const [from, to] of [['allowed/valid.md', 'allowed/../private/moved.md'], ['allowed/../private/sentinel.md', 'allowed/stolen.md']]) await rejected(method === 'rename' ? 'PATCH' : 'POST', '/' + method, { from, to });
      await fs.mkdir(path.join(root, 'allowed/tree'), { recursive: true });
      await fs.writeFile(path.join(root, 'allowed/tree/first.md'), 'sentinel');
      await fs.symlink('../../private', path.join(root, 'allowed/tree/link'));
      for (const method of ['rename', 'copy']) await rejected(method === 'rename' ? 'PATCH' : 'POST', '/' + method, { from: 'allowed/tree', to: 'allowed/target' });
      await fs.unlink(path.join(root, 'allowed/tree/link'));
      await fs.mkdir(path.join(root, 'allowed/tree/.git')); await fs.writeFile(path.join(root, 'allowed/tree/.git/config'), 'fixture');
      await rejected('POST', '/copy', { from: 'allowed/tree', to: 'allowed/target' });
      await fs.rm(path.join(root, 'allowed/tree/.git'), { recursive: true });
      assert.equal((await request('POST', '/copy', { from: 'allowed/tree', to: 'allowed/copied' })).status, 200);
      assert.equal((await request('PATCH', '/rename', { from: 'allowed/copied', to: 'allowed/renamed' })).status, 200);
      assert.equal(await fs.readFile(path.join(root, 'allowed/renamed/first.md'), 'utf8'), 'sentinel');
    });
    await t.test('PATH-08 encoded query delete denied in permanent and trash modes', async () => {
      for (const mode of ['permanent', 'trash'] as const) {
        await updateSettings(s => { s.vault.deleteMode = mode; });
        await rejected('DELETE', '/?path=allowed%2F..%2Fprivate%2Fsentinel.md');
      }
      assert.equal((await request('DELETE', '/?path=allowed%2Frenamed%2Ffirst.md')).status, 200);
      assert.equal(await fs.readFile(path.join(root, '.trash/allowed/renamed/first.md'), 'utf8'), 'sentinel');
    });
    await t.test('PATH-09 portable syntax, unicode, repeated separators and no double decoding', async () => {
      for (const p of ['/allowed/a.md', 'C:/allowed/a.md', 'allowed/..\\private\\a.md', 'allowed/\0.md']) await rejected('PUT', '/content', { path: p, content: 'changed' });
      for (const p of ['allowed//./中文.md', 'allowed/%2e%2e/literal.md', 'allowed/%252e%252e/literal.md']) assert.equal((await request('PUT', '/content', { path: p, content: 'sentinel unicode' })).status, 200);
      assert.equal(await fs.readFile(path.join(root, 'allowed/%2e%2e/literal.md'), 'utf8'), 'sentinel unicode');
    });
    await t.test('PATH-10 .git direct/case/symlink aliases and nested metadata blocked', async () => {
      await fs.symlink('../../.git', path.join(root, 'allowed/git-alias'));
      for (const p of ['.git/config', 'allowed/.GIT/config', 'allowed/git-alias/config', 'allowed/.git/../note.md']) {
        await rejected('PUT', '/content', { path: p, content: 'changed' }, true);
        await assert.rejects(vault.readFileText(p));
      }
    });
    await t.test('PATH-03/10 API key retains content writes but cannot reach metadata or outside roots', async () => {
      const key = await createKey('fixture-path-key', ['read', 'write']);
      const endpoint = base.replace('/api/files', '/api/v1/notes/');
      const put = (p: string) => fetch(endpoint + p, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-API-Key': key.raw }, body: JSON.stringify({ content: 'sentinel key' }) });
      assert.equal((await put('private/key-legal.md')).status, 200);
      await settleIndexes(); await qmd.build(); await buildLinkGraph();
      for (const p of ['.git/config', '..%2Foutside-content.md', 'allowed/git-alias/config']) {
        const before = await state(); const response = await put(p);
        assert.ok([400, 403].includes(response.status)); assert.deepEqual(await state(), before);
      }
    });
    await t.test('PATH-11 root mutations, disjoint/empty roots, invalid ancestors fail closed', async () => {
      for (const p of ['', '.', 'allowed/..']) await assert.rejects(vault.remove(p));
      await rejected('DELETE', '/?path=allowed');
      await rejected('PATCH', '/rename', { from: 'allowed', to: 'allowed/newroot' });
      for (const editable of ['', 'elsewhere']) {
        await updateSettings(s => { s.publicEditor.editableRoot = editable; });
        await rejected('PUT', '/content', { path: 'allowed/new.md', content: 'changed' });
      }
      await updateSettings(s => { s.publicEditor.editableRoot = 'content'; });
      assert.equal((await request('PUT', '/content', { path: 'legal-full-root.md', content: 'sentinel' })).status, 200);
      await updateSettings(s => { s.publicEditor.editableRoot = 'content/allowed'; });
      await rejected('PUT', '/content', { path: 'allowed/sentinel.md/child.md', content: 'changed' });
      await updateSettings(s => { s.vault.root = ''; });
      assert.equal((await request('PUT', '/content', { path: 'content/allowed/root-empty.md', content: 'sentinel' })).status, 200);
      await updateSettings(s => { s.vault.root = '../outside'; });
      await assert.rejects(vault.getContentRoot());
      await updateSettings(s => { s.vault.root = 'content'; });
      // Permissions are an IO failure, not a missing ancestor. A normal user
      // cannot traverse this directory; chmod restoration is fixture cleanup.
      await fs.mkdir(path.join(root, 'allowed/unreadable')); await fs.chmod(path.join(root, 'allowed/unreadable'), 0);
      try { await assert.rejects(vault.resolveInVault('allowed/unreadable/child.md')); }
      finally { await fs.chmod(path.join(root, 'allowed/unreadable'), 0o700); }
    });

    await t.test('GUEST-READ 访客读收敛：文件树/内容/搜索/历史只落 editableRoot+附件目录', async () => {
      // 基线：owner 全可见；访客只可见 allowed 子树（fixture 的 editableRoot=content/allowed）
      const ownerTree = await request('GET', '/', undefined, true);
      const ownerFiles = JSON.stringify(await ownerTree.json());
      assert.ok(ownerFiles.includes('private/sentinel.md'));
      const guestTree = await request('GET', '/');
      const guestFiles = JSON.stringify(await guestTree.json());
      assert.ok(!guestFiles.includes('private'), 'guest 文件树不得出现 private 目录');
      assert.ok(guestFiles.includes('allowed/sentinel.md'), 'guest 文件树仍含 allowed');

      // 内容读取：allowed 200；private 403（此前 200，回归断言）
      assert.equal((await request('GET', '/content?path=allowed/sentinel.md')).status, 200);
      assert.equal((await request('GET', '/content?path=private/sentinel.md')).status, 403);

      // git 历史：访客读 allowed 的历史可以，读 private 的历史被拒
      // git 路由挂载在 /api/git，与 files 的请求端点不同
      const gitBase = base.replace('/api/files', '/api/git');
      const logOk = await fetch(gitBase + '/log?path=allowed/sentinel.md');
      assert.equal(logOk.status, 200);
      const logDenied = await fetch(gitBase + '/log?path=private/sentinel.md');
      assert.equal(logDenied.status, 403);
      const showDenied = await fetch(gitBase + '/show?hash=HEAD&path=private/sentinel.md');
      assert.ok([400, 403].includes(showDenied.status));

      // 搜索：私有内容不能被命中（fixture 已建索引）；搜索路由挂在 /api/search
      await settleIndexes(); await qmd.build(); await buildLinkGraph();
      const searchBase = base.replace('/api/files', '/api/search');
      const search = await fetch(searchBase + '/search?q=private');
      const hits = JSON.stringify(await search.json());
      assert.ok(!hits.includes('private/sentinel.md'), 'guest 搜索不得命中 private 笔记');
    });


  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
