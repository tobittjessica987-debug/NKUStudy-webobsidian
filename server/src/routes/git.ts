import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth, requireOwner, denyGuest } from '../middleware/auth.js';
import * as git from '../services/git.js';
import { COMMIT_PREFIXES, buildCommitMessage, CommitTemplateError } from '../services/commitTemplate.js';
import { isGithubAppConfigured } from '../services/githubApp.js';
import { assertGuestWritable, isGuestWritable, assertGuestReadable } from '../services/guestpath.js';

export const gitRouter = Router();
// 允许 owner 与（公开编辑开启时的）guest；敏感操作再单独 requireOwner。
gitRouter.use(requireAuth);

// 提交模板：可用的中文前缀列表（访客构建提交信息也需要）。
gitRouter.get('/commit-prefixes', (_req, res) => {
  res.json({ prefixes: COMMIT_PREFIXES });
});

// 工作区变更列表（git 风格）。访客只看到可编辑目录内的变更。
gitRouter.get(
  '/changes',
  asyncHandler(async (req, res) => {
    const all = await git.changes();
    if (req.sessionRole !== 'guest') {
      res.json({ changes: all });
      return;
    }
    const visible = [];
    for (const c of all) {
      if (await isGuestWritable(c.path)) visible.push(c);
    }
    res.json({ changes: visible });
  }),
);

gitRouter.get(
  '/log',
  asyncHandler(async (req, res) => {
    const path = String(req.query.path ?? '').trim();
    if (!path) return res.status(400).json({ error: 'path required' });
    // 访客只查可读范围内文件的历史：私有笔记的提交记录（含已删除内容）不匿名开放
    if (req.sessionRole === 'guest') {
      try {
        await assertGuestReadable(path);
      } catch (e) {
        return res.status((e as { status?: number })?.status ?? 403).json({ error: (e as Error).message });
      }
    }
    res.json({ commits: await git.log(path) });
  }),
);

gitRouter.get(
  '/show',
  asyncHandler(async (req, res) => {
    const hash = String(req.query.hash ?? '').trim();
    const path = String(req.query.path ?? '').trim();
    if (!hash || !path) return res.status(400).json({ error: 'hash and path required' });
    if (req.sessionRole === 'guest') {
      try {
        await assertGuestReadable(path);
      } catch (e) {
        return res.status((e as { status?: number })?.status ?? 403).json({ error: (e as Error).message });
      }
    }
    res.json({ content: await git.showFile(hash, path) });
  }),
);

// 仅本地提交（不推送）。仅 owner：访客必须走 /sync 投稿流程（推配置编辑分支 + 开 PR），
// 不允许把改动留在本地仓库。
gitRouter.post(
  '/commit',
  requireOwner,
  asyncHandler(async (req, res) => {
    const message = resolveMessage(req.body);
    if (message instanceof CommitTemplateError) {
      res.status(400).json({ error: message.message });
      return;
    }
    const out = await git.commitAll(message, normalizePaths(req.body?.paths));
    console.log('[git] commit:', out);
    res.json({ message: out });
  }),
);

// 投稿：提交 + 拉取 + 推送 + 自动开 PR（受 GitHub App 配置约束）。
// owner 推送到配置的编辑分支；访客与 owner 使用同一显式编辑分支（不信任客户端输入）。
gitRouter.post(
  '/sync',
  asyncHandler(async (req, res) => {
    const message = resolveMessage(req.body);
    if (message instanceof CommitTemplateError) {
      res.status(400).json({ error: message.message });
      return;
    }
    const role = req.sessionRole === 'guest' ? 'guest' : 'owner';
    let paths = normalizePaths(req.body?.paths);
    // 访客：只能提交可编辑目录内的变更。勾选的路径必须都在该目录内；未指定
    // paths 时，自动收敛为「可编辑目录内的全部变更」，绝不放行越界内容。
    if (req.sessionRole === 'guest') {
      if (paths) {
        for (const p of paths) await assertGuestWritable(p);
      } else {
        const all = await git.changes();
        const allowed: string[] = [];
        for (const c of all) {
          if (await isGuestWritable(c.path)) allowed.push(c.path);
        }
        paths = allowed;
      }
    }
    console.log('[git] manual sync requested');
    const result = await git.sync(message, undefined, paths, role);
    console.log(`[git] sync ${result.ok ? 'ok' : 'not-ok'}:`, result.log.join(' | '));
    res.json(result);
  }),
);

// ---- 以下为 owner 专属（访客不可用）----

// 舍弃未提交改动，恢复到上次提交（VS Code 的「Discard Changes」）。仅 owner。
gitRouter.post(
  '/discard',
  requireOwner,
  asyncHandler(async (req, res) => {
    const paths = normalizePaths(req.body?.paths) ?? [];
    if (!paths.length) {
      res.status(400).json({ error: 'paths required' });
      return;
    }
    const n = await git.discard(paths);
    console.log(`[git] discard ${n} path(s)`);
    res.json({ ok: true, discarded: n });
  }),
);

gitRouter.get('/status', requireOwner, asyncHandler(async (_req, res) => res.json(await git.status())));
gitRouter.get('/sync-status', requireOwner, asyncHandler(async (_req, res) => res.json({ receipt: await git.syncStatus() })));

// 手动让编辑分支跟进主分支（baseBranch → editBranch）。仅 owner。
gitRouter.post(
  '/follow-base',
  requireOwner,
  asyncHandler(async (_req, res) => {
    const result = await git.followBase();
    console.log('[git] follow-base:', result.log.join(' | '));
    res.json(result);
  }),
);

gitRouter.get(
  '/github-app',
  requireOwner,
  asyncHandler(async (_req, res) => {
    res.json({ configured: await isGithubAppConfigured() });
  }),
);

gitRouter.post(
  '/pull-request',
  requireOwner,
  asyncHandler(async (req, res) => {
    const result = await git.openPullRequest({ title: req.body?.title, body: req.body?.body });
    res.json(result);
  }),
);

gitRouter.post(
  '/init',
  requireOwner,
  asyncHandler(async (_req, res) => {
    await git.init();
    res.json(await git.status());
  }),
);

gitRouter.post(
  '/clone',
  requireOwner,
  asyncHandler(async (_req, res) => {
    await git.clone();
    res.json(await git.status());
  }),
);

gitRouter.post(
  '/pull',
  requireOwner,
  asyncHandler(async (_req, res) => {
    const message = await git.pull();
    console.log('[git] pull:', message);
    res.json({ message });
  }),
);

gitRouter.post(
  '/push',
  requireOwner,
  asyncHandler(async (_req, res) => {
    const message = await git.push();
    console.log('[git] push:', message);
    res.json({ message });
  }),
);

/**
 * 规范化请求里的 paths：必须是字符串数组。返回 undefined 表示「全部提交」，
 * 返回数组（可能为空）表示「只提交这些路径」。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizePaths(raw: any): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some(p => typeof p !== 'string' || !p.trim())) {
    throw Object.assign(new Error('paths must be an array of non-empty file paths'), { status: 400 });
  }
  return raw;
}

/** 解析提交信息：支持 { prefix, description } 模板或 { message }。 */
function resolveMessage(body: any): string | CommitTemplateError {
  let message = String(body?.message ?? '');
  const prefix = body?.prefix;
  const description = body?.description;
  if (prefix !== undefined || description !== undefined) {
    try {
      message = buildCommitMessage({ prefix: String(prefix ?? ''), description: String(description ?? '') });
    } catch (e) {
      if (e instanceof CommitTemplateError) return e;
      throw e;
    }
  }
  return message;
}
