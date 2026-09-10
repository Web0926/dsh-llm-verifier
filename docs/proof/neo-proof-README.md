# neo 浏览器实时验收证明（2026-09-10）

实例：专属 DSH 3184（DSH_HOME=C:\Users\datoo\.dsh-phase0，approval=never + danger-full-access），浏览器 = BrowserOS neo（BrowserClaw）。

| 文件 | 证明内容 |
|---|---|
| neo-proof-settings-card.png | 设置对话框左侧栏出现独立「LLM Verifier」导航项；卡片含 启用开关、候选生成（答案数量/同时运行/profile=verifier-m3）、评审（方式=指定 DSH 模型评审、minimax-cn/MiniMax-M3、失败处理=转交当前主代理）、验证与限制、高级（折叠态▸）、「检查配置」按钮、revision 页脚 |
| neo-proof-settings-adv-collapsed.png | 「高级」组折叠态（▸）特写视图 |
| neo-proof-settings-adv-expanded.png | 「高级」组展开态（▾）：评审轨迹上限 524288 KiB、产物目录 .dsh-phase0\llm-verifier —— 卡片可展开收缩实锤 |
| neo-proof-conversation.png | 候选任务运行会话（Fix slugify.js test failures，25 次工具调用，MiniMax-M3） |
| neo-proof-verifier-green.png | **Verifier 真实工作证据**：verified_best_of(runId=f68318f6…, candidateCount=2) → candidate-1 score 95 winner / candidate-2 score 65（生成杂散 tmp.txt 违规被扣分）→ status=winner_selected（reviewer minimax-cn/MiniMax-M3, dsh_model 模式）→ apply_verified_winner status=applied → 本地复验 npm test 3 pass / 0 fail / exit 0 |

## 复现方式
1. 打开 http://127.0.0.1:3184/ （token 见实例启动参数）
2. 会话切换：`localStorage["dsh.sessions.current"] = {"sessionId":"session-c8ef7cc6-cbe5-48b1-9e20-0865a17d636c"}` 后刷新（绿色验收会话）
3. 设置卡片：标题栏设置图标 → 左侧「LLM Verifier」
