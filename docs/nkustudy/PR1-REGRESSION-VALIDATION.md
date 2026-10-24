# PR #1 回归修复验证（2026-10-24）

原 PR 提交：`8d18a643d150ca0e6f9e3b15e2b8140fe7e86c44`。修复后仍向 `nkustudy-dev` 合并，服务器不部署。

## 修复与新增覆盖

- 可读空目录保留，包括空 editableRoot；新建目录可见并可重命名，越界创建/移动仍拒绝且无落盘副作用。
- 访客图谱从可读源笔记生成，附件按实际路径和原始大小写检查；保留合法附件、未解析引用及重复边去重。私有来源不贡献标签或边；同名公开笔记按独立更新顺序解析，私有同名笔记新增/更新/删除不改变公开子图。Owner 原图行为保留。
- AppCards 的宽度、标题/描述行数与 Gallery 的间距/高度，经严格数值/单位范围校验后恢复。Reading 与 Live Preview 消毒管线仅重建四个固定 CSS 变量，仍移除任意原始 style、事件和危险 URL。测试覆盖分号、url/var/calc、负数、超大值与伪造 data 属性。
- WebSocket 既有测试改为等待指定广播事件，避免把异步 hello 欢迎帧当成广播；保留超时、撤销关闭和无越权消息断言，不改变 WebSocket 产品代码。

## 本地结果

- `npm run test:security`：100/100 PASS（原 PR 84项，新增16项，含后端父测试计数）。
- `npm run typecheck`：Server/Web PASS。
- `npm --workspace desktop run typecheck`：PASS。
- `npm run build`：Web/Server PASS（既有前端包体大小提示仍在）。
- 新增 `jsdom@26.1.0` 只作为测试 devDependency；本轮没有改变既有生产依赖解析。
- 独立代码复核已关闭发现的回归；`git diff --check` 通过。

首轮全套检查遇到上述 WebSocket 测试对 hello/目标事件的竞争，原失败日志保留；修正等待条件后最终全套通过。测试使用隔离合成数据，渲染测试证明两条管线的参数与消毒结果，不冒充完整浏览器视觉或服务器验收。

远端 CI 需针对最终 PR HEAD 全部通过后才合并；GitHub PR/Actions 保存该状态。冻结 r2 应用镜像、r3 部署包和数据卷不随源码合并更新，也不改写其历史清单。
