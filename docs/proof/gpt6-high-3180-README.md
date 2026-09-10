# GPT 6 high 正式实例验收（2026-09-11）

用户明确指定 GPT 6 / high，DeepSeek 专用 logprobs 路线不再作为本次交付条件。

## 配置与真实执行

- 实例：`http://127.0.0.1:3180/`，Codex 内置浏览器。
- 原生设置：`reviewMode=dsh_model`、`reviewerProvider=oc-gpt6-high`、`reviewerModel=gpt-6-astra`、`reviewerReasoningEffort=high`，revision 2。
- 供应商复用本机既有 GPT 6 路线，原生模型目录明确支持 high；设置刷新后读回一致。未改变其他实例。
- 候选生成继续使用 `verifier-m3`；本次更换的是独立评审者，候选模型与评审模型分别记录。
- 独立测试目录：`G:/zcode-project/llm-verify/e2e-gpt6-high-20260911`，初始 `node --test` 为 0 pass / 3 fail。
- DSH 会话：`session-d14240ab-a939-40b6-aae3-f9c54aea5468`，页面标题“GPT 6 high 插件真实验收 2026-09-11”。
- Run：`ea2b7b4d-483f-499e-a7dd-5792415d213f`。
- 2 个候选实际执行且验证通过。`result.review` 记录 `provider=oc-gpt6-high`、`model=gpt-6-astra`、耗时 13829 ms，分数分别为 95、95，同分按候选编号选择 candidate-1。
- `resolvedConfig.reviewerReasoningEffort=high`；会话 `modelSelection.lastUsed` 同样记录 GPT 6 high。这里的 high 证明客户端请求配置，不宣称能独立证明供应商内部推理过程。
- 结果为 `winner_selected`，应用为 `applied / validationStatus=passed`，仅修改 `slugify.js`。独立复测 `node --test` 得到 3 pass / 0 fail / exit 0。
- `verifierRequestCount=0`，没有调用 DeepSeek 专用评审。

原始 manifest、report、apply-result 和日志保留于 `C:/Users/datoo/.dsh/llm-verifier/runs/ea2b7b4d-483f-499e-a7dd-5792415d213f/`。截图：[内置浏览器结果](gpt6-high-3180-acceptance.png)。

## 报告显示修复

本轮发现旧报告模板无条件显示默认 `deepseek-v4-flash`，即使真实路线为 `dsh_model`。原始验收报告保留原样；模型身份以 manifest 的 `result.review` 为准。

修复后新报告从评审回执读取供应商和模型，单列配置的推理强度；只有实际发生 DeepSeek 请求时才显示其模型及比较次数。新增回归测试使用与配置不同的回执标识，证明报告取自回执且不泄漏未使用的 DeepSeek 默认值。定向测试 1/1、类型检查、构建、差异检查通过；模拟回归不替代上面的真实模型证据。

修复包 `dsh-llm-verifier-0.2.0-gpt6-report.tgz` 已通过 DSH 原生插件安装入口安装。安装副本 `lib/core.js` 与构建 SHA-256 同为 `806410779e3fbce58ac47bdbd76267e7175a61cd7c2eaaf3a46723db600cd212`。

重载前原生 session/list 返回 159 个会话、0 个运行中。Servy 重启回执成功，3180 唯一监听 PID 为 40988，认证 HTTP 200，插件 inventory 为 enabled/active。旧报告不会因升级被改写；没有为仅修正文案重复收费型评审。
