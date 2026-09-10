// DSH web client module for the llm-verifier plugin settings card.
// Hand-written against the host's client module contract (see dshmarket/client/client.js
// for the reference pattern): one __ModuleLoader__ factory, React via host require,
// card registered into the `settings.plugin.item` slot keyed by the settings namespace.
// ponytail: per-field writes save immediately through settingsScope.set (revision-fenced
// by the host); a draft/confirm model is only worth it once users complain about
// multi-field edits racing each other.
window.__ModuleLoader__.load({ id: "dsh-llm-verifier", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	let react = require("react");

	const NS = "llm-verifier";
	const name = "llm-verifier";
	const inject = ["slots", "settingsScope"];

	const REVIEW_MODES = [
		["parent_agent", "当前主代理评审"],
		["dsh_model", "指定 DSH 模型评审"],
		["deepseek_verifier", "DeepSeek Verifier (logprobs)"],
	];
	const EFFORTS = [["low", "low"], ["high", "high"], ["max", "max"]];

	function apply(ctx) {
		ctx.inject(["settingsScope"], (scoped) => {
			const scope = scoped.settingsScope.bind({ namespace: NS });
			scoped.slots.inject("settings.plugin.item", () => scoped.slots.register({
				name: "settings.plugin.item",
				key: NS,
				inject: () => ({})
			}, () => react.createElement(SettingsCard, { scope })));
			// top-level settings section: 「LLM Verifier」 appears in the settings
			// dialog's left navigation, rendering the same card directly.
			scoped.slots.inject("settings.section", () => scoped.slots.register({
				name: "settings.section",
				id: "llm-verifier",
				order: 45,
				label: () => "LLM Verifier",
				inject: () => ({})
			}, () => react.createElement(SettingsSection, { scope })));
		});
	}

	function SettingsSection({ scope }) {
		return react.createElement(
			"div",
			{ style: { padding: "4px 0" } },
			react.createElement("div", { style: { fontWeight: 600, fontSize: 15, marginBottom: 8 } }, "LLM Verifier · 多候选验证与评审"),
			react.createElement(SettingsCard, { scope })
		);
	}

	const styles = {
		root: { display: "flex", flexDirection: "column", gap: 4, padding: "4px 0", maxWidth: 720 },
		title: { fontWeight: 600 },
		hint: { opacity: 0.7, fontSize: 12, marginBottom: 6 },
		group: { border: "1px solid var(--dsh-border, rgba(127,127,127,.35))", borderRadius: 6, padding: "8px 10px", margin: "6px 0" },
		groupTitle: { fontWeight: 600, fontSize: 13, margin: "2px 0 6px", cursor: "pointer", userSelect: "none" },
		titleRow: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" },
		chevron: { fontSize: 10, opacity: 0.7 },
		row: { display: "flex", alignItems: "center", gap: 8, margin: "6px 0", flexWrap: "wrap" },
		label: { minWidth: 150, display: "inline-block" },
		number: { width: 88 },
		text: { width: 260 },
		textarea: { width: "100%", minHeight: 56, fontFamily: "monospace", fontSize: 12 },
		mark: { opacity: 0.65, fontSize: 11 },
		error: { color: "var(--dsh-danger, #b42318)", fontSize: 12, margin: "4px 0", whiteSpace: "pre-wrap" },
		check: { fontSize: 12, margin: "4px 0", whiteSpace: "pre-wrap" },
		status: { opacity: 0.6, fontSize: 12, marginTop: 6 },
		button: { margin: "6px 6px 0 0" }
	};

	function msToMinutes(ms) {
		return Math.round((Number(ms) || 0) / 60000);
	}
	function minutesToMs(minutes) {
		return Math.max(1, Math.round(Number(minutes) || 0)) * 60000;
	}
	function collapsedSummary(v) {
		if (!v) return "";
		const mode = { parent_agent: "当前主代理评审", dsh_model: "DSH 模型评审", deepseek_verifier: "DeepSeek Verifier" }[v.reviewMode] || v.reviewMode;
		return v.enabled === false ? "已停用" : v.defaultCandidateCount + " 个候选 · " + mode + " · 点击展开配置";
	}

	function Group({ title, children, defaultOpen }) {
		const [open, setOpen] = react.useState(defaultOpen !== false);
		return react.createElement(
			"div",
			{ style: styles.group },
			react.createElement("div", {
				style: styles.groupTitle,
				onClick: () => setOpen(!open)
			}, (open ? "▾ " : "▸ ") + title),
			open ? children : null
		);
	}

	const pendingWrites = {};
	function debouncedSet(scope, field, value, delay) {
		clearTimeout(pendingWrites[field]);
		pendingWrites[field] = setTimeout(() => { void scope.set(field, value); }, delay ?? 300);
	}

	function SettingsCard({ scope }) {
		const [open, setOpen] = react.useState(true);
		const [snap, setSnap] = react.useState(() => scope.getSnapshot());
		react.useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
		const [error, setError] = react.useState(null);
		const [checkResult, setCheckResult] = react.useState(null);
		const set = async (field, value) => {
			try {
				setError(null);
				await scope.set(field, value);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		};

		if (snap.status === "loading") {
			return react.createElement("div", { style: styles.root }, "读取中…");
		}
		if (snap.status !== "ready" || snap.value === undefined) {
			return react.createElement("div", { style: styles.root }, "设置命名空间在此实例上不可用。");
		}

		const v = snap.value;
		const user = snap.user ?? {};
		const isOverridden = (key) => Object.prototype.hasOwnProperty.call(user, key);
		const numberInput = (key, min, max, step) => react.createElement("input", {
			type: "number", min, max, step: step ?? 1, value: v[key], style: styles.number,
			onChange: (event) => {
				const parsed = Number(event.target.value);
				if (Number.isFinite(parsed) && parsed >= min && parsed <= max) debouncedSet(scope, key, parsed);
			}
		});
		const select = (key, options) => react.createElement(
			"select",
			{ value: String(v[key]), onChange: (event) => void set(key, event.target.value) },
			options.map(([value, label]) => react.createElement("option", { key: value, value }, label))
		);
		const row = (key, labelText, control) => react.createElement(
			"label",
			{ key, style: styles.row },
			react.createElement("span", { style: styles.label }, labelText + (isOverridden(key) ? " *" : "")),
			control
		);
		const textField = (key, labelText, placeholder) => row(key, labelText, react.createElement("input", {
			type: "text", value: String(v[key] ?? ""), placeholder, style: styles.text,
			onChange: (event) => void set(key, event.target.value)
		}));
		const minutesField = (key, labelText, minMinutes) => row(key, labelText + "（分钟）", react.createElement("input", {
			type: "number", min: minMinutes, step: 1, value: msToMinutes(v[key]), style: styles.number,
			onChange: (event) => {
				if (event.target.value === "") return;
				void set(key, minutesToMs(event.target.value));
			}
		}));

		const runChecks = () => {
			const problems = [];
			if (!Number.isInteger(v.defaultCandidateCount) || v.defaultCandidateCount < 1 || v.defaultCandidateCount > 5) {
				problems.push("答案数量必须是 1-5 的整数。");
			}
			if (!Number.isInteger(v.maxConcurrentCandidates) || v.maxConcurrentCandidates < 1 || v.maxConcurrentCandidates > 5) {
				problems.push("同时运行数量必须是 1-5 的整数。");
			}
			if (String(v.candidateProfile).trim() === "") problems.push("执行配置不能为空。");
			if (v.runTimeoutMs < Math.max(v.candidateTimeoutMs, v.validationTimeoutMs)) {
				problems.push("全流程时限不得小于单候选时限或单命令时限。");
			}
			if (v.reviewerTimeoutMs > v.runTimeoutMs) problems.push("评审时限不得超过全流程时限。");
			if (v.reviewMode === "dsh_model") {
				if (String(v.reviewerProvider).trim() === "" || String(v.reviewerModel).trim() === "") {
					problems.push("指定 DSH 模型评审需要同时填写评审供应商与评审模型。");
				}
			}
			if (v.reviewMode === "deepseek_verifier" && !/^deepseek-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(String(v.verifierModel))) {
				problems.push("DeepSeek Verifier 评审要求模型 ID 以 deepseek- 开头。");
			}
			if (v.validationMode === "configured" && (!Array.isArray(v.validationCommands) || v.validationCommands.length === 0)) {
				problems.push("验证方式为“使用配置命令”时至少需要一条命令。");
			}
			setCheckResult(problems.length === 0 ? "检查通过：未发现配置冲突。" : "发现 " + problems.length + " 个问题：\n· " + problems.join("\n· "));
		};

		const titleRow = react.createElement("div", {
			style: styles.titleRow,
			onClick: () => setOpen(!open)
		}, react.createElement("span", { style: styles.chevron }, open ? "▾" : "▸"), react.createElement("span", null, "LLM Verifier · 多候选验证与评审"));
		if (!open) {
			return react.createElement(
				"div",
				{ style: styles.root },
				titleRow,
				react.createElement("div", { style: styles.hint }, collapsedSummary(v))
			);
		}
		return react.createElement(
			"div",
			{ style: styles.root },
			titleRow,
			react.createElement("div", { style: styles.hint }, "带 * 的字段为用户自定义值；修改即时保存，下次运行生效，进行中的任务使用启动时的配置。"),
			row("enabled", "启用多候选工具", react.createElement("input", {
				type: "checkbox", checked: v.enabled === true,
				onChange: (event) => void set("enabled", event.target.checked)
			})),

			react.createElement(Group, { key: "gen", title: "候选生成" },
			react.createElement("div", null,
				row("defaultCandidateCount", "答案数量 (1-5)", numberInput("defaultCandidateCount", 1, 5)),
				row("maxConcurrentCandidates", "同时运行 (1-5)", numberInput("maxConcurrentCandidates", 1, 5)),
				textField("candidateProfile", "执行配置 profile", "headless")
			)),
			react.createElement(Group, { key: "review", title: "评审" },
			react.createElement("div", null,
				row("reviewMode", "评审方式", select("reviewMode", REVIEW_MODES)),
				v.reviewMode === "dsh_model" ? [
					textField("reviewerProvider", "评审供应商", "例如 minimax-cn"),
					textField("reviewerModel", "评审模型", "例如 MiniMax-M3"),
					textField("reviewerReasoningEffort", "评审推理强度（留空为默认）", "low / high / max"),
					row("reviewerMaxTokens", "评审输出上限 (tokens)", numberInput("reviewerMaxTokens", 256, 32768, 256))
				] : [],
				v.reviewMode === "deepseek_verifier" ? [
					textField("credentialRef", "凭据引用名", "DEEPSEEK_API_KEY"),
					textField("verifierModel", "Verifier 模型", "deepseek-v4-flash"),
					row("nEvaluations", "每项重复评估次数", numberInput("nEvaluations", 1, 4)),
					row("maxVerifierWorkers", "比较请求并发", numberInput("maxVerifierWorkers", 1, 16)),
					row("verifierEffort", "比较推理强度", select("verifierEffort", EFFORTS)),
					row("verifierMaxTokens", "Verifier 输出预算", numberInput("verifierMaxTokens", 1024, 131072, 1024))
				] : [],
				row("reviewSingleEligible", "单一合格答案仍需评审", react.createElement("input", {
					type: "checkbox", checked: v.reviewSingleEligible === true,
					onChange: (event) => void set("reviewSingleEligible", event.target.checked)
				})),
				row("reviewFailurePolicy", "评审失败处理", select("reviewFailurePolicy", [
					["stop", "停止并保留报告"],
					["parent_agent", "转交当前主代理"]
				])),
				minutesField("reviewerTimeoutMs", "评审时限", 1)
			)),

			react.createElement(Group, { key: "valid", title: "验证与限制" },
			react.createElement("div", null,
				row("validationMode", "验证方式", select("validationMode", [
					["auto", "自动检测"],
					["configured", "使用配置命令"]
				])),
				row("validationCommands", "验证命令（每行一条）", react.createElement("textarea", {
					style: styles.textarea,
					value: Array.isArray(v.validationCommands) ? v.validationCommands.join("\n") : "",
					onChange: (event) => {
						const commands = event.target.value.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
						debouncedSet(scope, "validationCommands", commands, 500);
					}
				})),
				minutesField("candidateTimeoutMs", "单候选时限", 1),
				minutesField("validationTimeoutMs", "单命令时限", 1),
				minutesField("runTimeoutMs", "全流程时限", 1)
			)),

			react.createElement(Group, { key: "adv", title: "高级", defaultOpen: false },
			react.createElement("div", null,
				row("maxVerifierTraceBytes", "评审轨迹上限 (KiB)", numberInput("maxVerifierTraceBytes", 1, 2048, 1)),
				textField("stateDirectory", "产物目录", "$DSH_HOME/llm-verifier")
			)),

			react.createElement(
				"div",
				null,
				react.createElement("button", { type: "button", style: styles.button, onClick: runChecks }, "检查配置")
			),
			checkResult === null ? null : react.createElement("div", { style: styles.check }, checkResult),
			error === null ? null : react.createElement("div", { style: styles.error, role: "alert" }, "保存失败：" + error),
			react.createElement(
				"div",
				{ style: styles.status },
				(snap.writable ? "已连接宿主设置文档" : "此实例的设置文档不可写") +
				" · revision " + (snap.revision ?? "-") +
				" · 生效时机：下次运行"
			)
		);
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
} });
