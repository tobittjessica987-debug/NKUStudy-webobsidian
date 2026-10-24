import path from 'node:path';
import { getSettings } from './settings.js';
import { getVaultRoot, getContentRoot, resolveInVault, normalizeRelativePath, isWithin } from './vault.js';

const denied = () => Object.assign(new Error('公开编辑仅允许修改指定目录'), { status: 403 });
const deniedRead = () => Object.assign(new Error('公开编辑模式下仅可访问指定目录'), { status: 403 });

/** editableRoot is repository-relative; API paths are content-relative. */
export async function getGuestWritableRoot(): Promise<string> {
  const s = await getSettings();
  const editable = normalizeRelativePath((s.publicEditor.editableRoot ?? '').trim());
  // An empty/unrelated configuration must never silently mean all content.
  if (!editable) throw denied();
  const configured = path.resolve(await getVaultRoot(), editable);
  const content = await getContentRoot();
  const repoContent = path.resolve(await getVaultRoot(), normalizeRelativePath(s.vault.root ?? ''));
  if (!isWithin(repoContent, configured)) throw denied();
  const root = await resolveInVault(path.relative(repoContent, configured).split(path.sep).join('/'));
  if (!isWithin(content, root)) throw denied();
  return root;
}

/** Authorize the canonical physical target, not the request's original prefix. */
export async function assertGuestWritable(rel: string, options: { protectRoot?: boolean } = {}): Promise<void> {
  const allowed = await getGuestWritableRoot();
  const target = await resolveInVault(rel);
  if (!isWithin(allowed, target) || (options.protectRoot && target === allowed)) throw denied();
}

export async function isGuestWritable(rel: string): Promise<boolean> {
  try {
    await assertGuestWritable(rel);
    return true;
  } catch {
    return false;
  }
}

/**
 * 访客可读范围：editableRoot ∪ 附件目录。读写同权是公开编辑的默认姿态——
 * 此前读侧完全敞开（整棵内容树、任意笔记、全文搜索、git 历史都匿名可读），
 * 现在收敛到访客实际需要看到的范围；附件目录额外放行，是因为 editableRoot
 * 里笔记的内嵌图片/媒体按设置通常落在内容根的 attachments/ 下，不放行会
 * 让访客侧所有嵌入图挂掉。附件目录不存在（或被配置到内容根之外）时静默跳过。
 */
export async function getGuestReadableRoots(): Promise<string[]> {
  const s = await getSettings();
  const roots = new Set<string>([await getGuestWritableRoot()]);
  const attachmentDir = normalizeRelativePath((s.vault.attachmentDir ?? '').trim());
  if (attachmentDir) {
    try {
      const root = await resolveInVault(attachmentDir);
      const content = await getContentRoot();
      // 只认内容根内的附件目录：配置指到内容根外时 vault 解析会抛或越界，直接放弃
      if (isWithin(content, root)) roots.add(root);
    } catch {
      /* 附件目录不存在不是错误：上传时才会创建 */
    }
  }
  return [...roots];
}

/** 读路径守卫：目标（经 vault 规范化/符号链接锚定后的物理路径）必须落在任一可读根内。 */
export async function assertGuestReadable(rel: string): Promise<void> {
  const roots = await getGuestReadableRoots();
  const target = await resolveInVault(rel);
  if (!roots.some((allowed) => isWithin(allowed, target))) throw deniedRead();
}

export async function isGuestReadable(rel: string): Promise<boolean> {
  try {
    await assertGuestReadable(rel);
    return true;
  } catch {
    return false;
  }
}

