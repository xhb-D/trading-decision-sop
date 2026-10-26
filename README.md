# Trading Decision SOP Dashboard V1

独立、人工确认驱动的交易决策导航。基于用户确定的 SOP V1.1；包含 MVP 使用效率监测和一键 SOP Analytics Bundle。所有数据只保存在浏览器本地，运行时无第三方依赖、账号、数据库或交易 API。

## 本地启动

要求 Node.js 22.18+（建议 Node 22 LTS）、npm。

```sh
cd /Users/hongchujun/Documents/日内交易/trading-decision-sop
npm ci
npm run dev
```

打开终端打印的地址（默认 `http://127.0.0.1:5173/trading-decision-sop/`）。本轮浏览器 QA 使用 4317 端口，里面是模拟操作记录；默认 5173 与其为不同 origin，首次使用会进入干净的 P0。

```sh
npm test
npm run build
npm run preview
```

构建产物在 `dist/`，可以放到 GitHub Pages 或任何静态服务器。运行时不需要 Node。开发工具版本由 package-lock.json 固定。

## 最短使用路径

1. P0 核对真实平台的持仓、挂单和已有快照。若平台存在持仓/挂单，使用相应恢复按钮；可随时回 P0 补录另一种敞口，不会清除已有记录。
2. P1 点击 Bias，再确认进入结构；P2 点击结构方向、阶段、观察级别并确认。不会自动识别行情。
3. P3 新增你已判断合格的候选位置。方向、PB/BOF 默认可直接点击，标签、价格和长备注都非必填。中性 Bias 须明确确认当前候选的具体方向权限。
4. 价格到位点击 R01 → P4，Setup 成立点击确认 → P5。可以直接从等待状态处理新事件，无需先点“恢复”。
5. P5 明确确认总体风险/订单冲突，以及“入场前已确定逻辑失效点”。再按平台实际结果记录挂单、全部或部分成交。
6. P6 按既定规则管理；触及原失效点或计划离场后，到平台执行并人工核对。看板不会自动撤单或平仓。

“发生新事件”提供 R01–R04、Bias/结构变化、失效、成交、离场、U0 和 U2 的入口。R02 只更新观察级别时可恢复原任务；若修改母结构方向/阶段，则原依赖失效，不能继续用旧 Setup。危险更新、导入、清空日志有确认步骤。

多候选互相独立，非当前候选默认折叠。V1 每品种同时管理一个实际执行计划；已有敞口时先处理风险，其他候选保留。GC/CL/ES 各自保存。跨品种总风险仍由你人工检查。

## 本地保存与备份

- 仅访问 `trading-decision-sop:v1:workspace`、`:backup`、`:damaged`，不读取/写入原看板键。
- 状态与日志保存于同一版本化 envelope。主要操作立即保存，后台计时每 15 秒保存；离开页面时再保存一次。异常强制终止可能丢失最近未提交的计时片段，已确认流程操作会立即保存。
- 备份/导入提供完整 JSON。导入先验证，旧主数据留作滚动备用；有真实持仓/委托记录时拒绝覆盖。损坏原文（在可写条件下）保留于隔离键，可导出。
- 有敞口刷新强制 P0 核对；空仓有效快照直接恢复原环节。跨日或离开超过 8 小时提示快照可能过期，由人确认继续或 U2。
- 多标签页更新触发只读保护；保留一个页面并刷新后继续，避免互相覆盖。
- 浏览器清理数据会删除本地记录，定期导出完整 JSON。不同域名、浏览器、端口不共享记录，部署后需人工导入备份。

## SOP 使用分析与 Bundle

默认折叠，不增加盘中采集动作。只记录流程动作代码、系统 ID、品种、环节、路由原因和白名单状态字段；不记录价格、位置标签、自由备注、账号或交易平台订单号。

- `USER_ACTION` 是一次真人有效操作；系统自动跳转不算点击。确认弹窗的打开与提交分别计数；主题/统计筛选/导出等非决策操作不混入任务点击。机会创建前的准备操作归此前恢复/观察任务。
- 活跃耗时是可观察估计：排除显式 W 等待、后台时间；无交互超过 30 秒的部分为 idle。不会宣称能测量真实思考时间。已结束任务以首个完成/注销事件为边界，后续操作不回填。
- R02 市场更新与主动上游返回分开。重复返回只有缺少已记录变化证据时标记“待人工复核”，不推断用户未记录的市场事件，不自动认定违规。
- 日志最多 4,000 条，保存时还控制工作区约 900,000 字符。超限裁剪前缀并累计丢弃数；缺少生命周期边界的任务不纳入完成均值。较长使用期应定期导出。

展开「SOP 使用分析」后，点击 **一键导出 SOP Analytics Bundle**。当前日期/品种筛选会写入导出范围；需要全量保留窗口时清空筛选。

Bundle 为 JSON，`format: "SOP Analytics Bundle"`、`schemaVersion: 1`，包含：

- `rawLog`：原始版本化事件，是统计唯一事实输入。
- `taskLifecycles`：开始、中断、恢复、注销、完成及事件 ID。
- `stateChanges`：脱敏的 before/after、变化字段及原因。
- `routes`：环节迁移、主动返回、阻断、异常及路由原因。
- `sopVersion`、`routingVersion`、`ruleSnapshot`：SOP 版本与路由规则快照。
- `upstreamReturns`：逐次关联前次目标环节/任务开始后的状态变化事件 ID、已确认条件事件 ID、窗口完整性与人工复核提示。
- `summary`、`metricDefinitions`、`retention`、`evidenceWarnings`：汇总、口径、裁剪边界和证据限制。

旧事件缺少逐条版本/状态快照时会明确提示，不能追溯补造。状态变化存在不代表返回必然合理；缺少变化记录也不证明用户违反纪律。

独立重算并核对导出汇总：

```sh
npm run analytics:recompute -- /绝对路径/sop-analytics-bundle-v1.json
```

输出 `matchesExportedSummary: true` 表示当前实现从原始日志计算得到的全部指标与导出一致。重算无需浏览器状态；筛选后的 Bundle 已含对应原始事件，不需二次筛选。CSV 导出也保留逐条事件、计时和结构化状态变化；普通统计 JSON 另保留为快速查看入口。

## GitHub Pages 部署

目标仓库：https://github.com/xhb-D/trading-decision-sop 。目标 Pages 地址：https://xhb-d.github.io/trading-decision-sop/ 。

Vite `base` 固定为 `/trading-decision-sop/`；构建的 HTML 引用该子目录内的 CSS 与 JavaScript。`.github/workflows/pages.yml` 在推送 `main` 时自动运行，也可手动触发。仓库 Pages 使用 GitHub Actions。工作流执行 npm ci、自动化测试、TypeScript 检查和 Vite 构建，再将 dist 上传并发布。源码与部署配置保存在 main，dist 作为 Actions 构建产物发布，不重复提交生成文件。

开发/preview 访问 URL 包含 `/trading-decision-sop/`。部署后平台 origin 改变，请用本地 JSON 备份迁移；应用仍只使用专属存储键，不会读取同一 Pages 域名下原看板的数据。发布是否成功须以 Actions 结果及线上检查为准；初始 MVP 验证记录仅描述当时的本地交付状态。

## 验证材料与限制

见 `docs/SPEC.md`（业务/技术规范）、`docs/VERIFICATION.md`、`docs/test-results.tap` 和 `docs/screenshots/`。`docs/browser-sop-analytics-bundle-v1.json` 是浏览器模拟 QA 的导出实例，供重算验证，不应导入为真实交易记录。

未接入行情、交易平台和盈亏统计，均为需求明确排除内容。未执行真实账户操作或真实盘中用户验收；没有承诺自动检测止损、成交或撤单。V1 不标记 FROZEN，仍需用户按实际并排盯盘习惯验收。

## 界面更新：三品种总览与中文流程说明

顶部同时展示 GC、CL、ES 的 Bias、结构、执行状态与当前任务，持仓和挂单提示无需切换即可看到。点击卡片只切换下方主任务，三张状态卡始终保留。决策环节、快速事件、历史和提示均以中文名称显示；存储中的事件标识、路由规则与 Analytics Bundle 保持兼容。
