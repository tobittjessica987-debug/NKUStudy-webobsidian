# NKUStudy WebObsidian 开发交接

日期：2026-10-24。统一开发分支：[`nkustudy-dev`](https://github.com/tobittjessica987-debug/NKUStudy-webobsidian/tree/nkustudy-dev)。

初始交接提交 `4f8b637` 从已修复代码整理，保留原 4A、4B 工作区与发行包。该提交的产品源码与 4A 一致；后续 PR 会继续修改开发源码与锁文件。下面的 r2 镜像和 108 项源清单是冻结历史身份，不代表后续开发 HEAD 已构建、已部署或与 r2 逐文件相同。

## 版本与证据

| 层次 | 固定身份 / 作用 |
|---|---|
| QUT 原始基线 | `e2201591c02ecb96e4d42d6adbd0644f1a15b40a` |
| 4A 安全代码 | `1bd3f6c088466c8b46b447c9516cec623bc194f6` |
| 4A 审计 / 镜像 source label | `cb3a96e8546844416258c1af64549724685eeb04` |
| 当前程序源码 | `server/`、`web/`，另有上游 desktop；开发提交可继续演进 |
| 构建配置 | 根 Dockerfile、锁文件、`.dockerignore`、`scripts/4b/container-entrypoint.sh` |
| 运行镜像 | `nkustudy/webobsidian:4b-1bd3f6c-r2`，linux/amd64；详见 [r2 release](provenance/r2-release.json) |
| HTTPS 部署配置 | `deploy/r3/` 冻结文本；不改变 r2 应用镜像 |
| 数据卷 | `/vault` 内容、`/data` 设置及运行数据；不是源码或镜像，不纳入 Git |

镜像构建时 Docker 配置尚未提交，因此不能称镜像由本轮新 HEAD 构建。通过 [108 项源清单](provenance/r2-source-manifest.json) 将当时源码、锁文件及构建配置逐文件绑定；初始交接 `4f8b637` 已核对全部匹配。image config / manifest / index digest 是不同身份，不能互换。完整值见 release.json。

- 源清单 SHA256：`46ad2d97bdc2c2fcb0f9b8811b9424886091ed71a81b9c17924cf62f9990b186`
- 锁文件 SHA256：`671963de571dfc611e7f370482640455928bde108ed0e7c9383fd633f090d7ed`
- Dockerfile SHA256：`8331f28f55ea2bc785315c5da166c4fbf54887d9414504a17ed3f42c5f184bdb`
- r2 镜像 TAR SHA256：`c2a1839b9037784695a6e8ecfeba036a4f5ae4c3cd98ce561c09b9e5617d3beb`
- r3 完整发行 TGZ SHA256：`8bdafe79b06478169b572016c142dde13d58d402c7a92b677e4d3a3fc8b9962b`

公网预览使用部署版；GitHub push / PR merge 不会自动更新服务器。本轮没有重建或替换已验收镜像，没有服务器操作。服务器当前使用 r2+r3 来自用户确认；本轮本地测试不替代服务器或真实 Wiki 业务验收。

## 本地开发与检查

Node.js 22、npm；建议在独立开发目录使用合成测试内容，不连接真实 Wiki。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:security
npm run typecheck
npm --workspace desktop run typecheck
npm run build
```

应用启动参数见根 `.env.example`；真实 `.env`、密码与 Token 不提交。构建输出 `server/dist`、`server/public` 等不入库。根 Dockerfile 构建未来开发镜像时应使用新的 tag 和对应提交/清单，不覆盖 r2 标签，不复用旧清单冒充新镜像。`docker-compose.yml` 是上游通用示例，不具备本项目 r3 的完整隔离部署合同。

离线部署与包复原见 [部署说明](../../deploy/README.md)。相关测试只检查外部完整包和合成合同，不启动 Docker：

```sh
# R3_PACKAGE、R2_PACKAGE 为仓库外完整包；EVIDENCE 为新的仓库外目录
python3 scripts/4b/https/test_bindings.py "$R3_PACKAGE" "$R2_PACKAGE" "$EVIDENCE/bindings"
python3 scripts/4b/https/test_archive_bindings.py "$R3_PACKAGE" "$EVIDENCE/archive-fixtures" "$EVIDENCE/archive"
python3 scripts/4b/https/run_legacy_contracts.py "$R3_PACKAGE" "$PWD" "$EVIDENCE/legacy"
```

legacy runner 使用明确的合成 Docker/cgroup 输入，无历史私有采样依赖；其通过不代表真实资源限制已在服务器再次验证。旧的 `scripts/4b/offline/test_*` 部分依赖历史夹具，不能不加区分批量运行。

## Wiki 负责人协作

```sh
git fetch origin nkustudy-dev
git switch -c feature/your-topic origin/nkustudy-dev
```

完成修改后向 `nkustudy-dev` 发 Pull Request，必须经过代码审查、测试和验收才能合并。此文档记录协作规则，未声称已经配置 GitHub 分支保护。CI 已覆盖该分支 push/PR，无服务器部署步骤。合并后是否部署需要单独安排版本和验收。

NKUStudy 网站主仓库、WebObsidian 程序仓库和 Wiki 内容仓库保持独立。本轮不涉及品牌重设计、真实 Wiki、GitHub App 或真实投稿流程。

## 不纳入版本控制

- 所有真实凭据、Cookie、`.env`、`setup.env`、`settings.json`、TLS 私钥。
- 4B/r3 外部目录中的镜像 TAR、发行 TAR.GZ/ZIP、快照、数据卷、state/private 目录及服务器日志。
- 原主工作区的 `docs/nkustudy.zip`，原 4B 的完整 preflight evidence 目录。
- r3 本机 HTTPS/浏览器/回滚实测脚本和原始运行现场：仍在原交付物中，依赖本机路径和私有测试状态，不作为通用入口。

仓库已有的 4A 日志是公开的本地测试/构建证据，未混入服务器日志。原有 logo/icon 是源码资源，不是二进制发行包。历史报告保留当时状态，当前整理结果见 [本轮验收报告](HANDOFF-20261024.md)。
