window.__ModuleLoader__.load({
	id: "@office/billing",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/quota-view.ts
		const ROWS = [
			{
				key: "tokens",
				label: "Token"
			},
			{
				key: "cost",
				label: "金额"
			},
			{
				key: "calls",
				label: "调用次数"
			}
		];
		function asRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
		}
		function num(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : 0;
		}
		/** 限额维：`> 0` 才算设了限（契约：`0` ＝ 未设限）。 */
		function optNum(value) {
			const parsed = num(value);
			return parsed > 0 ? parsed : void 0;
		}
		/**
		* 把宿主响应折成视图。
		* @param payload - `GET /api/office/quota` 的响应体。
		* @returns 配额卡视图（拿不到就 `available:false`，不编造数字）。
		*/
		function quotaView(payload) {
			const record = asRecord(payload);
			const snapshot = asRecord(record?.snapshot);
			if (record?.ok !== true || snapshot === void 0) return {
				available: false,
				period: "",
				rows: [],
				verdict: "unknown",
				note: "未同步（登录后可从平台拉取配额）"
			};
			const limitsRecord = asRecord(snapshot.limits) ?? {};
			const usedRecord = asRecord(snapshot.used) ?? {};
			const maxTokens = optNum(limitsRecord.maxTokens);
			const maxCost = optNum(limitsRecord.maxCost);
			const maxCalls = optNum(limitsRecord.maxCalls);
			const limits = {
				...maxTokens === void 0 ? {} : { maxTokens },
				...maxCost === void 0 ? {} : { maxCost },
				...maxCalls === void 0 ? {} : { maxCalls }
			};
			const used = {
				tokens: num(usedRecord.tokens),
				cost: num(usedRecord.cost),
				calls: num(usedRecord.calls)
			};
			const verdictRecord = asRecord(record.verdict);
			const within = typeof verdictRecord?.within === "boolean" ? verdictRecord.within : void 0;
			const exceeded = new Set((Array.isArray(verdictRecord?.exceeded) ? verdictRecord.exceeded : []).filter((key) => typeof key === "string"));
			const rows = ROWS.map(({ key, label }) => {
				const limit = key === "tokens" ? limits.maxTokens : key === "cost" ? limits.maxCost : limits.maxCalls;
				return {
					key,
					label,
					used: key === "tokens" ? used.tokens : key === "cost" ? used.cost : used.calls,
					...limit === void 0 ? {} : { limit },
					exceeded: exceeded.has(key)
				};
			});
			const verdict = within === void 0 ? "unknown" : within ? "within" : "exceeded";
			return {
				available: true,
				period: typeof snapshot.period === "string" ? snapshot.period : "",
				rows,
				verdict,
				note: verdict === "exceeded" ? "已超限（平台侧为准；本地不阻断）" : verdict === "within" ? "本周期在限内" : "已同步，平台未给裁决"
			};
		}
		//#endregion
		//#region \0fom-css:F:\deepseek\deepseek harness\apps\fom-client\plugins\office-billing\src\client\UsageSection.module.css.mjs
		const css = ".aWd2Yq_page{flex-direction:column;gap:14px;padding:4px 2px 8px;line-height:1.6;display:flex}.aWd2Yq_head{align-items:baseline;gap:10px;display:flex}.aWd2Yq_title{margin:0;font-size:15px;font-weight:600}.aWd2Yq_hint{color:var(--dsw-alias-label-tertiary);font-size:11.5px}.aWd2Yq_empty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12.5px}.aWd2Yq_verdictRow{align-items:center;gap:8px;display:flex}.aWd2Yq_rows{flex-direction:column;gap:12px;margin:0;padding:0;list-style:none;display:flex}.aWd2Yq_row{flex-direction:column;gap:6px;display:flex}.aWd2Yq_rowHead{justify-content:space-between;align-items:baseline;gap:10px;display:flex}.aWd2Yq_label{color:var(--dsw-alias-label-secondary);font-size:12.5px}.aWd2Yq_value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-size:12.5px}.aWd2Yq_valueExceeded{font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-error-primary);font-size:12.5px;font-weight:600}.aWd2Yq_bar,.aWd2Yq_barEmpty{background:var(--dsw-alias-bg-layer-2);border-radius:999px;height:5px;display:block;overflow:hidden}.aWd2Yq_barFill,.aWd2Yq_barFillExceeded{background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;display:block}.aWd2Yq_barFillExceeded{background:var(--dsw-alias-state-error-primary)}.aWd2Yq_actions{border-top:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding-top:12px;display:flex}.aWd2Yq_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12.5px}";
		const tagId = "@office/billing/F:\\deepseek\\deepseek harness\\apps\\fom-client\\plugins\\office-billing\\src\\client\\UsageSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@office/billing";
			tag.dataset.fomCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var UsageSection_module_css_default = {
			"actions": "aWd2Yq_actions",
			"bar": "aWd2Yq_bar",
			"barEmpty": "aWd2Yq_barEmpty",
			"barFill": "aWd2Yq_barFill",
			"barFillExceeded": "aWd2Yq_barFillExceeded",
			"empty": "aWd2Yq_empty",
			"error": "aWd2Yq_error",
			"head": "aWd2Yq_head",
			"hint": "aWd2Yq_hint",
			"label": "aWd2Yq_label",
			"page": "aWd2Yq_page",
			"row": "aWd2Yq_row",
			"rowHead": "aWd2Yq_rowHead",
			"rows": "aWd2Yq_rows",
			"title": "aWd2Yq_title",
			"value": "aWd2Yq_value",
			"valueExceeded": "aWd2Yq_valueExceeded",
			"verdictRow": "aWd2Yq_verdictRow"
		};
		//#endregion
		//#region src/client/UsageSection.tsx
		/**
		* 设置页「用量与配额」。
		*
		* 三个维度（Token / 金额 / 调用次数）各一行：已用 / 限额 + 进度条；顶部是周期与一句裁决。
		* 数据经宿主代理（令牌不过浏览器）；「同步配额」从平台拉一次。
		*/
		/** 宿主配额读路由。 */
		const QUOTA_ROUTE = "/api/office/quota";
		/** 宿主配额同步路由。 */
		const QUOTA_SYNC_ROUTE = "/api/office/quota/sync";
		async function getQuota() {
			try {
				return await (await fetch(QUOTA_ROUTE)).json();
			} catch (error) {
				return {
					ok: false,
					message: String(error?.message ?? error)
				};
			}
		}
		/** 一行的进度（`undefined` ＝ 未设限 ⇒ 不画进度条）。 */
		function ratioOf(row) {
			if (row.limit === void 0 || row.limit <= 0) return void 0;
			return Math.min(1, row.used / row.limit);
		}
		function formatNumber(value) {
			return value.toLocaleString("zh-CN");
		}
		/**
		* 用量与配额设置页。
		* @returns 设置页内容
		*/
		function UsageSection() {
			const [view, setView] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const load = (0, react.useCallback)(async () => {
				const payload = await getQuota();
				setView(quotaView(payload));
				const message = payload?.message;
				if (typeof message === "string" && message !== "") setError(message);
				else setError(null);
			}, []);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			const sync = (0, react.useCallback)(async () => {
				setBusy(true);
				setNote(null);
				setError(null);
				try {
					const res = await fetch(QUOTA_SYNC_ROUTE, { method: "POST" });
					const payload = await res.json();
					if (payload.ok) {
						setNote("已同步");
						await load();
					} else setError(payload.message ?? `同步失败（HTTP ${String(res.status)}）`);
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setBusy(false);
				}
			}, [load]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: UsageSection_module_css_default.page,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: UsageSection_module_css_default.head,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: UsageSection_module_css_default.title,
							children: "用量与配额"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: UsageSection_module_css_default.hint,
							children: view?.available === true && view.period !== "" ? `本周期 ${view.period}` : "还没从平台拉到配额"
						})]
					}),
					view === null || !view.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: UsageSection_module_css_default.empty,
						children: "还没有配额数据。登录后点「同步配额」从平台拉取。"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: UsageSection_module_css_default.verdictRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: view.verdict === "exceeded" ? "danger" : view.verdict === "within" ? "success" : "neutral",
							children: view.note
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: UsageSection_module_css_default.hint,
							children: "以平台为准，本地只展示、不阻断"
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: UsageSection_module_css_default.rows,
						children: view.rows.map((row) => {
							const ratio = ratioOf(row);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								className: UsageSection_module_css_default.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: UsageSection_module_css_default.rowHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: UsageSection_module_css_default.label,
										children: row.label
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: row.exceeded ? UsageSection_module_css_default.valueExceeded : UsageSection_module_css_default.value,
										children: [formatNumber(row.used), row.limit === void 0 ? " / 未设限" : ` / ${formatNumber(row.limit)}`]
									})]
								}), ratio === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: UsageSection_module_css_default.barEmpty,
									"aria-hidden": "true"
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: UsageSection_module_css_default.bar,
									"aria-hidden": "true",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: row.exceeded ? UsageSection_module_css_default.barFillExceeded : UsageSection_module_css_default.barFill,
										style: { width: `${String(Math.round(ratio * 100))}%` }
									})
								})]
							}, row.key);
						})
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: UsageSection_module_css_default.actions,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							disabled: busy,
							onClick: () => void sync(),
							children: busy ? "同步中…" : "同步配额"
						}), note !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: UsageSection_module_css_default.hint,
							children: note
						}) : null]
					}),
					error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: UsageSection_module_css_default.error,
						children: error
					}) : null
				]
			});
		}
		//#endregion
		//#region src/client/index.tsx
		/** 必需服务：UI 槽位注册表。 */
		const inject = ["slots"];
		/**
		* 挂设置页「用量与配额」。
		*
		* `settings.section` 是 `list`，必须带 `id`；`order` 排在账号（-10）之后。
		* @param ctx - 客户端根上下文。
		*/
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "usage",
				order: 10,
				label: () => "用量与配额"
			}, UsageSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
