# ZCode 单回合空转与 rollout 膨胀 RCA

日期：2026-09-09
目标会话：`sess_54ce5ce9-0b0e-4ec0-9a7b-86074c6f6b72`
目标 turn：`turn_c60a8958-be97-4518-bfb0-2b202dc7c2a7`
本机版本：ZCode `3.11.2.6792`，CLI/session schema `0.16.5`

## 结论

这次故障由四段连续机制组成：BrowserOS Neo 连接先失效；该 turn 的模型工具清单没有 Neo；GLM-5.3-Flash 在约 80 万 token 上下文中改为连续调用 CodeGraph，并用 `noop3` 至 `noop460` 生成形式不同、实质无进展的查询；ZCode 的异常保护只发提醒，没有硬停止条件，因此主循环继续执行，直到最后一次 CodeGraph 调用返回 `CONNECTION_CLOSED`。

最后的连接关闭只是终止事件。它没有解释之前 4 小时 28 分钟、468 次成功 CodeGraph 调用为何持续发生。

## 证据来源

- 会话数据库：`C:\Users\datoo\.zcode\cli\db\db.sqlite`，始终用 SQLite `mode=ro` 打开。
- 主日志：`C:\Users\datoo\.zcode\cli\log\zcode-2026-09-09.jsonl`。
- 模型 IO：`C:\Users\datoo\.zcode\cli\rollout\model-io-sess_54ce5ce9-0b0e-4ec0-9a7b-86074c6f6b72.jsonl`。
- 安装包运行时代码：`C:\ZCode\resources\glm\zcode.cjs`。
- 可读的同源 runtime bundle：`C:\ZCode\resources\glm\packages\browser-use-plugin\dist\mcp\server.js`。

## 因果链

### 1. 触发因素：Neo 在 turn 开始前已经不可用

主日志先记录多次 Neo screenshot/tabs `fetch failed`，之后记录：

```text
mcp.server.closed: browseros-neo
Version negotiation probe failed: fetch failed
```

目标 turn 在重连失败之后才开始。本机配置仍包含 `http://127.0.0.1:9211/mcp`，所以不是“没有配置 Neo”。2026-09-09 再检查时 9211 仍无监听：

```text
curl: (7) Failed to connect to 127.0.0.1:9211 after 2047 ms: Could not connect to server
```

### 2. 路由失配：模型知道需要 Neo，但实际拿不到 Neo 工具

目标 turn 的模型请求提供 52 个工具，其中没有 BrowserOS/Neo 工具。第一至第三次 reasoning 都提到要检查 Neo，却改为调用 CodeGraph。之后模型自己写出“Stop emitting explores”，但仍继续生成 CodeGraph 调用。

首个请求输入 799,390 token；末段请求输入 866,736 token。模型输出逐渐缩短，最后只剩工具调用，没有面向用户的正文。

### 3. 失效机制：参数变化绕过完全相同调用检测

ZCode 默认异常配置为：

```json
{
  "modelAnomalyGuard": {
    "maxBudgetWarningsPerTurn": 3,
    "repeatedToolCallWarningThreshold": 3
  }
}
```

`detectRepeatedToolCallWarnings` 使用 `toolName + stableJson(input)` 作为完整签名，只在完全相同输入连续出现 3 次时告警。`noop3`、`noop4`……每次输入字符串不同，因此连续计数每次都重置。

配置 schema 还支持 `toolCallWarningThreshold`，但默认值和用户配置中都没有设置。即使设置，该实现也只注入一条 system reminder；`handleToolCallAnomalyWarnings` 不取消 turn、不禁用工具，也不抛出错误。目标 turn 的日志中没有 `model_anomaly`、`tool_call_budget` 或 `repeated_tool_call` 事件。

### 4. 为何没有自愈：主循环没有硬预算

`runRegularTurnLoop` 的外层是：

```js
while (true) {
  // compact, initialize MCP, request model, execute tools
  if (result === "break") break;
}
```

运行时虽然维护 `modelStepCount` 和 `toolCallCount`，但主循环没有按这两个值停止。模型每次都返回合法的 `finishReason: tool-calls`，所以运行时继续下一次模型请求。Todo 和异常提醒都属于软提示，不能构成运行时止损。

目标 turn 的最终统计：

| 指标 | 数值 |
|---|---:|
| 模型请求 | 466 |
| 工具调用 | 470 |
| CodeGraph explore | 469，其中 468 完成、1 失败 |
| 模型输入 token 合计 | 395,127,567 |
| 最大单次输入 | 866,736 |
| 持续时间 | 约 4.46 小时 |
| 最终错误 | `SdkError / CONNECTION_CLOSED / Connection closed` |

该 turn 没有完成 `regular_turn_loop`，因此没有正常 turn usage/final assistant message；最后一个真实用户输入“继续”之后看不到最终答复。

## 其他 ZCode 日志对比

这台机器的数据库中：

- 30 个 turn 的模型请求数不少于 100，分布在 12 个 session。
- 9 个 turn 不少于 200 次。
- 3 个 turn 不少于 400 次。
- 最大记录为一个 BBWeb2 turn：587 次模型请求、604 次工具调用、约 4.88 小时。

“单 turn 可运行数百次”因此是系统性事实。但长 turn 不等于无进展：抽查 Omnigent 的一个 136 请求 turn，134 次以工具调用结束，132 个工具输入不同，最长相同输入连续次数为 1；它主要执行 Bash、Read、Edit 和 TodoWrite。目标 turn 则把 457 个递增 `noop` 交给同一个 CodeGraph 工具，属于有直接证据的无进展循环。

## rollout 膨胀

目标 rollout 每行保存一次完整模型请求和响应，每行约 12–14 MB。466 次请求把单文件放大到 6,159,982,434 字节，即约 5.74 GiB。当前 rollout 目录总量约 8.03 GiB，其中另外两个大文件约 1.70 GiB 和 0.47 GiB。

这是故障的放大器，不是 Neo 最初失效的原因。现有证据也不足以证明磁盘压力导致最后的 `CONNECTION_CLOSED`。

## 根因与未知项

**故障归因**：

1. 触发因素：Neo MCP 连接和重连失败。
2. 直接失效机制：所需工具不在 turn 工具清单中，模型退化为 CodeGraph 伪查询。
3. 持续放大机制：异常检测只比较完全相同输入且只告警；主循环没有硬工具数、模型步数或无进展预算。
4. 存储放大机制：rollout 为每次请求重复保存巨大上下文。
5. 终止事件：最后一次 CodeGraph 调用发生 `CONNECTION_CLOSED`。

**仍未知**：CodeGraph 连接最后为何关闭。当前日志没有子进程退出码、堆栈或 transport close cause，不能把磁盘、进程崩溃或人工停止中的任何一种写成既定事实。

## 最小修复建议

上游 runtime 需要硬约束，单纯调高提醒次数不足以修复：

1. 在 `runRegularTurnLoop` 顶部检查 `modelStepCount` 和 `toolCallCount`，达到可配置硬上限后持久化失败原因并正常结束 turn。
2. 无进展检测不要只比较完整参数；至少同时统计连续同工具、工具结果摘要是否变化、工作区或任务状态是否变化。
3. 对数字后缀、随机 ID 等易变字段做归一化，使 `noop3` 至 `noop460` 归入同一行为簇。
4. 工具依赖不可用时，在下一次模型请求明确注入连接失败和可用替代路径；若没有替代工具，结束回合并报告阻塞。
5. rollout 改为尺寸上限、轮转或请求消息引用去重，避免每次请求复制近百万 token 上下文。

`modelAnomalyGuard.toolCallWarningThreshold` 可作为临时提醒，但它不是硬停止，不能单独作为根因修复。

## 本次操作边界

本次只读 ZCode 数据库、日志、rollout、配置和安装包代码。没有修改 ZCode 配置、数据库或安装目录，没有删除 8.03 GiB rollout，也没有重启 ZCode/Neo。分析用临时脚本在报告生成后删除。
