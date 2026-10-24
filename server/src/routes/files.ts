import { Router, type Request, type Response, type NextFunction } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stableMutationHandler as asyncHandler } from '../middleware/stableMutation.js';
import { requireAuth, denyGuest } from '../middleware/auth.js';
import * as vault from '../services/vault.js';
import { getSettings } from '../services/settings.js';
import { qmd } from '../services/search.js';
import { updateLinkGraphForFile } from '../services/links.js';
import { scheduleAutoCommitOnSave } from '../services/git.js';
import { resolveFile } from '../services/fileindex.js';
import { onFileRenamed } from '../services/shares.js';
import { mimeFor } from '../services/mime.js';
import { sendFileWithRange } from '../services/httpfile.js';
import { uploadImage, UploadError } from '../services/upload.js';
import { assertGuestWritable, isGuestReadable, assertGuestReadable } from '../services/guestpath.js';
import type { TreeNode } from '../services/vault.js';
import { receiveUpload, assertRasterImage } from '../services/uploadPolicy.js';

export const filesRouter = Router();
filesRouter.use(requireAuth);


const isMd = (p: string) => /\.(md|markdown)$/i.test(p);

/** 取上传文件名的纯文件名，去掉任何目录/穿越片段（防止 originalname 携带 ../）。 */
const safeUploadName = (name: string): string => {
  const safe = path.posix.basename(String(name ?? '').replace(/\\/g, '/')).replace(/^\.+/, '') || 'file';
  if (safe.includes('\0') || Buffer.byteLength(safe) > 240) {
    throw Object.assign(new Error('Invalid upload filename'), { status: 400 });
  }
  return safe;
};

// 访客（公开编辑）只能改动 publicEditor.editableRoot 下的路径；
// 校验逻辑见 services/guestpath.ts（路径口径：相对内容根）。

/** 递归裁剪文件树：文件保留可读项，文件夹自身可读或含可读后代时保留（包括空目录）。 */
function filterTreeNodes(nodes: TreeNode[], readable: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'folder') {
      const children = filterTreeNodes(node.children ?? [], readable);
      if (readable.has(node.path) || children.length) out.push({ ...node, children });
    } else if (readable.has(node.path)) {
      out.push(node);
    }
  }
  return out;
}

async function filterTreeForGuest(tree: TreeNode): Promise<TreeNode> {
  // 逐节点判定（而非按前缀字符串匹配）：路径经 vault 解析锚定，防 ./ 别名绕过
  const readable = new Set<string>();
  const collect = async (nodes: TreeNode[]): Promise<void> => {
    for (const node of nodes) {
      if (await isGuestReadable(node.path)) readable.add(node.path);
      if (node.type === 'folder') await collect(node.children ?? []);
    }
  };
  await collect(tree.children ?? []);
  return { ...tree, children: filterTreeNodes(tree.children ?? [], readable) };
}

/** 访客写操作守卫：仅 guest 受限，owner 不受限。 */
function guestWriteGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.sessionRole !== 'guest') {
    next();
    return;
  }
  // 收集请求里涉及的路径（query.path / body.path / body.from / body.to / body.dir）。
  const paths: string[] = [];
  for (const v of [req.query.path, req.body?.path, req.body?.from, req.body?.to, req.body?.dir]) {
    if (typeof v === 'string' && v) paths.push(v);
  }
  Promise.all(paths.map((p) => assertGuestWritable(p)))
    .then(() => next())
    .catch((e) => {
      res.status(e?.status ?? 403).json({ error: e?.message ?? 'Forbidden' });
    });
}

// Refresh derived indexes after a mutation (best-effort, non-blocking).
// Incremental: only the touched file(s) are reparsed, not the whole vault.
async function reindex(opts: { upsert?: string; added?: string; removed?: string } = {}) {
  if (opts.upsert) await qmd.upsert(opts.upsert).catch(() => {});
  if (opts.added && isMd(opts.added)) await updateLinkGraphForFile(opts.added).catch(() => {});
  if (opts.removed && isMd(opts.removed)) await updateLinkGraphForFile(opts.removed, true).catch(() => {});
  scheduleAutoCommitOnSave();
}

filesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const tree = await vault.listTree();
    // 访客只见可读范围（editableRoot + 附件目录）内的子树：私有目录既不能读，
    // 也不该出现在文件树里被人 enumerate
    if (req.sessionRole === 'guest') {
      res.json(await filterTreeForGuest(tree));
      return;
    }
    res.json(tree);
  }),
);

filesRouter.get(
  '/content',
  asyncHandler(async (req, res) => {
    let rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    rel = await vault.canonicalRelativePath(rel);
    // Obsidian-style resolution: if the exact path doesn't exist (e.g. an embed
    // `![[image.jpg]]` that lives in Attachments/), resolve it by basename.
    if (!(await vault.exists(rel))) {
      const resolved = resolveFile(rel);
      if (resolved) rel = resolved;
    }
    // 读权限守卫放在路径解析之后：按 basename 解析出来的嵌入目标也要按其真实路径判定
    if (req.sessionRole === 'guest') {
      try {
        await assertGuestReadable(rel);
      } catch (e) {
        res.status((e as { status?: number })?.status ?? 403).json({ error: (e as Error).message });
        return;
      }
    }
    if (vault.isTextFile(rel)) {
      res.json({ path: rel, content: await vault.readFileText(rel), encoding: 'utf8' });
    } else {
      // Stream with Range support so embedded <video>/<audio> can seek.
      const abs = await vault.resolveInVault(rel);
      await sendFileWithRange(req, res, abs, mimeFor(rel));
    }
  }),
);

filesRouter.put(
  '/content',
  guestWriteGuard,
  asyncHandler(async (req, res) => {
    const { path: rel, content } = req.body ?? {};
    if (typeof rel !== 'string' || typeof content !== 'string') {
      res.status(400).json({ error: 'path and content required' });
      return;
    }
    const canonical = await vault.canonicalRelativePath(rel);
    await vault.writeFileText(canonical, content);
    await reindex({ upsert: canonical, added: canonical });
    res.json({ ok: true, path: canonical });
  }),
);

filesRouter.post(
  '/folder',
  guestWriteGuard,
  asyncHandler(async (req, res) => {
    const { path: rel } = req.body ?? {};
    if (typeof rel !== 'string') {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const canonical = await vault.canonicalRelativePath(rel);
    await vault.createFolder(canonical);
    res.json({ ok: true, path: canonical });
  }),
);

filesRouter.post(
  '/upload',
  receiveUpload('attachment'),
  asyncHandler(async (req, res) => {
    const dir = String(req.body?.dir ?? '');
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'file required' });
      return;
    }
    // Reuse an existing folder that differs only in case (e.g. an Obsidian vault's
    // "Attachments") instead of creating a duplicate "attachments". See vault.ts.
    const resolvedDir = dir ? await vault.resolveDirCaseInsensitive(dir) : '';
    const rel = path.posix.join(resolvedDir, safeUploadName(file.originalname));
    if (req.sessionRole === 'guest') await assertGuestWritable(rel);
    await vault.importUpload(rel, file.path);
    res.json({ ok: true, path: rel, size: file.size });
  }),
);

/**
 * 图片上传到外部图床（PicList-Core）。成功返回远程 URL；未启用/失败时
 * 回退到本地 attachments，返回 vault 相对路径（前端据此决定插入形式）。
 */
filesRouter.post(
  '/upload-image',
  receiveUpload('image'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'file required' });
      return;
    }
    await assertRasterImage(file);
    try {
      const { url } = await uploadImage(await fs.readFile(file.path), file.originalname, file.mimetype, res.locals.uploadAbortSignal);
      res.json({ ok: true, remote: true, url });
    } catch (e) {
      if (res.destroyed || res.writableEnded) return;
      if (e instanceof UploadError && e.status === 400) {
        // 未启用图床：回退到本地 attachments。
        const s = await getSettings();
        const resolvedDir = await vault.resolveDirCaseInsensitive(s.vault.attachmentDir || 'attachments');
        const rel = path.posix.join(resolvedDir, safeUploadName(file.originalname));
        if (req.sessionRole === 'guest') await assertGuestWritable(rel);
        await vault.importUpload(rel, file.path);
        res.json({ ok: true, remote: false, path: rel, size: file.size });
        return;
      }
      throw e;
    }
  }),
);

filesRouter.patch(
  '/rename',
  guestWriteGuard,
  asyncHandler(async (req, res) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to required' });
      return;
    }
    if (req.sessionRole === 'guest') {
      await assertGuestWritable(from, { protectRoot: true });
      await assertGuestWritable(to, { protectRoot: true });
    }
    const canonicalFrom = await vault.canonicalRelativePath(from);
    const canonicalTo = await vault.canonicalRelativePath(to);
    await vault.rename(canonicalFrom, canonicalTo);
    await qmd.rename(canonicalFrom, canonicalTo);
    await onFileRenamed(canonicalFrom, canonicalTo).catch(() => {}); // keep public share links pointing at the note
    await reindex({ added: canonicalTo, removed: canonicalFrom });
    res.json({ ok: true, from: canonicalFrom, to: canonicalTo });
  }),
);

filesRouter.post(
  '/copy',
  guestWriteGuard,
  asyncHandler(async (req, res) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to required' });
      return;
    }
    if (req.sessionRole === 'guest') {
      await assertGuestWritable(from, { protectRoot: true });
      await assertGuestWritable(to, { protectRoot: true });
    }
    const copied = await vault.copy(from, to);
    for (const f of copied) {
      if (isMd(f)) {
        await qmd.upsert(f).catch(() => {});
        await updateLinkGraphForFile(f).catch(() => {});
      }
    }
    scheduleAutoCommitOnSave();
    res.json({ ok: true, from, to });
  }),
);

// --- Trash (FR-1) -----------------------------------------------------------
// Listed/mutated via dedicated /trash* routes; the plain DELETE / below either
// trashes or permanently removes depending on settings.vault.deleteMode.

filesRouter.get(
  '/trash',
  denyGuest,
  asyncHandler(async (_req, res) => {
    res.json({ items: await vault.listTrash() });
  }),
);

filesRouter.post(
  '/trash/restore',
  denyGuest,
  asyncHandler(async (req, res) => {
    const rel = String(req.body?.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const restored = await vault.restoreFromTrash(rel);
    await reindex({ upsert: restored, added: restored });
    res.json({ ok: true, restored });
  }),
);

// Permanently delete one trashed item.
filesRouter.delete(
  '/trash/item',
  denyGuest,
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    await vault.deleteFromTrash(rel);
    res.json({ ok: true });
  }),
);

// Empty the whole trash.
filesRouter.delete(
  '/trash',
  denyGuest,
  asyncHandler(async (_req, res) => {
    await vault.emptyTrash();
    res.json({ ok: true });
  }),
);

filesRouter.delete(
  '/',
  guestWriteGuard,
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    if (req.sessionRole === 'guest') await assertGuestWritable(rel, { protectRoot: true });
    const s = await getSettings();
    const canonical = await vault.canonicalRelativePath(rel);
    if (s.vault.deleteMode === 'permanent') {
      await vault.remove(canonical);
      qmd.remove(canonical);
      await reindex({ removed: canonical });
      res.json({ ok: true, deleted: canonical });
      return;
    }
    const dest = await vault.trash(canonical);
    qmd.remove(canonical);
    await reindex({ removed: canonical });
    res.json({ ok: true, trashed: dest });
  }),
);
