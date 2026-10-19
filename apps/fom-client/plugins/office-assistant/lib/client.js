window.__ModuleLoader__.load({
	id: "@office/assistant",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region \0fom-css:F:\deepseek\deepseek harness\apps\fom-client\ui\src\Textarea.module.css.mjs
		const css$3 = ".OUMTKq_textarea{box-sizing:border-box;resize:vertical;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);width:100%;min-height:96px;color:var(--dsw-alias-label-primary);padding:8px 10px;font-family:inherit;font-size:13px;line-height:20px}.OUMTKq_textarea:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}.OUMTKq_textarea::placeholder{color:var(--dsw-alias-label-tertiary)}";
		const tagId$3 = "@office/assistant/F:\\deepseek\\deepseek harness\\apps\\fom-client\\ui\\src\\Textarea.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId$3) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@office/assistant";
			tag.dataset.fomCss = tagId$3;
			tag.textContent = css$3;
			document.head.appendChild(tag);
		}
		var Textarea_module_css_default = { "textarea": "OUMTKq_textarea" };
		(0, react.forwardRef)(function Textarea({ className, ...rest }, ref) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				ref,
				className: className === void 0 ? Textarea_module_css_default.textarea : `${Textarea_module_css_default.textarea} ${className}`,
				...rest
			});
		});
		//#endregion
		//#region \0fom-css:F:\deepseek\deepseek harness\apps\fom-client\ui\src\Card.module.css.mjs
		const css$2 = ".pdpsDG_card{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:12px;flex-direction:column;gap:8px;padding:14px;display:flex}.pdpsDG_form{border-color:var(--dsw-alias-border-l);background:var(--dsw-alias-bg-overlay)}";
		const tagId$2 = "@office/assistant/F:\\deepseek\\deepseek harness\\apps\\fom-client\\ui\\src\\Card.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@office/assistant";
			tag.dataset.fomCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var Card_module_css_default = {
			"card": "pdpsDG_card",
			"form": "pdpsDG_form"
		};
		//#endregion
		//#region ../../ui/src/Card.tsx
		/**
		* 卡片容器。内核 `ui-primitives` 无通用卡片原子，故在组合层补齐：
		* 只提供表面与内部纵向布局，内容与交互由调用方决定。
		* 样式走 `Card.module.css`（构建期编译成幂等 style 注入）。
		* @param props.variant - 表面（默认 `card`）。
		* @param props.className - 布局放置。
		* @returns 卡片元素。
		*/
		function Card({ variant = "card", className, children }) {
			const cls = variant === "form" ? `${Card_module_css_default.card} ${Card_module_css_default.form}` : Card_module_css_default.card;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: className === void 0 ? cls : `${cls} ${className}`,
				children
			});
		}
		//#endregion
		//#region \0fom-css:F:\deepseek\deepseek harness\apps\fom-client\ui\src\LineTabs.module.css.mjs
		const css$1 = ".HwPzea_tabs{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:flex-end;gap:24px;display:flex}.HwPzea_tab{font:inherit;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;padding:7px 1px 9px;font-size:13px;line-height:20px;position:relative}.HwPzea_tab:hover,.HwPzea_tab[data-active=true]{color:var(--dsw-alias-label-primary)}.HwPzea_tab[data-active=true]:after,.HwPzea_tab:focus-visible:after{background:var(--dsw-alias-state-business-primary);content:\"\";border-radius:2px 2px 0 0;height:2px;position:absolute;bottom:-1px;left:0;right:0}.HwPzea_tab:focus-visible{outline:none}@media (prefers-reduced-motion:reduce){.HwPzea_tab{transition:none}}";
		const tagId$1 = "@office/assistant/F:\\deepseek\\deepseek harness\\apps\\fom-client\\ui\\src\\LineTabs.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@office/assistant";
			tag.dataset.fomCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/items.ts
		/** 到期标记（v1 只用于显示）：未完成且 `dueAt <= now`。 */
		function isOverdue(item, now) {
			return item.status === "open" && item.dueAt !== void 0 && item.dueAt <= now;
		}
		//#endregion
		//#region src/client/items-view.ts
		/**
		* 「我的待办」块的**视图纯逻辑**（不碰 React / fetch，便于单测）。
		*
		* 与 `items.ts` 的分工：那边是数据语义（造/勾/改/排序/清理），这边只做**展示分组**——
		* 哪个进「待办」、哪个进「已完成」、折叠里几条、到期怎么标。
		*/
		/**
		* 分组：未完成进主列表、已完成进折叠区（**保持传入顺序**——顺序由 `sortItems` 定）。
		* @param items 已经排好序的事项
		*/
		function groupItems(items) {
			return {
				open: items.filter((item) => item.status === "open"),
				done: items.filter((item) => item.status === "done")
			};
		}
		/** 一行的副标题：到期/已完成时间（没有就是空串）。 */
		function itemMeta(item, now) {
			if (item.status === "done") return item.doneAt === void 0 ? "已完成" : `已完成 · ${formatDate(item.doneAt)}`;
			if (item.dueAt === void 0) return "";
			return isOverdue(item, now) ? `已过期 · ${formatDate(item.dueAt)}` : `到期 · ${formatDate(item.dueAt)}`;
		}
		/** 本地化时间（`MM-DD HH:mm`；跨年补年份）。 */
		function formatDate(ms, now = Date.now()) {
			const date = new Date(ms);
			if (Number.isNaN(date.getTime())) return "";
			const pad = (value) => String(value).padStart(2, "0");
			const sameYear = date.getFullYear() === new Date(now).getFullYear();
			const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
			return sameYear ? day : `${date.getFullYear()}-${day}`;
		}
		/** 折叠区的标题文案（含条数）。 */
		function doneLabel(count) {
			return `已完成（${count}）`;
		}
		//#endregion
		//#region src/client/local-mode-notice.ts
		/** 本地模式的提示文案（一处定义，面板与测试共用）。 */
		const LOCAL_MODE_NOTICE = {
			title: "本地模式 · 未登录",
			detail: "AI 对话、文件、技能、待办都能用；派活、我的任务、IM 手机接力需要登录平台。"
		};
		/** 宿主模式路由（与 `office-login` 宿主半一致）。 */
		const MODE_ROUTE = "/api/office/login/mode";
		/**
		* 是否该显示本地模式提示。
		* @param mode 宿主返回的模式（`'gate'` / `'local'` / `'signed'`，或未知）
		* @returns 只有 `local` 才提示
		*/
		function shouldShowLocalNotice(mode) {
			return mode === "local";
		}
		/**
		* 从宿主路由的响应体里取模式。
		* @param payload `GET /api/office/login/mode` 的响应
		* @returns 模式字符串，或 `undefined`
		*/
		function modeFromPayload(payload) {
			if (typeof payload !== "object" || payload === null) return void 0;
			const mode = payload.mode;
			return typeof mode === "string" ? mode : void 0;
		}
		//#endregion
		//#region \0fom-css:F:\deepseek\deepseek harness\apps\fom-client\plugins\office-assistant\src\client\AssistantPage.module.css.mjs
		const css = ".qj8JTW_page{box-sizing:border-box;flex-direction:column;gap:12px;width:100%;max-width:720px;padding:18px 20px;line-height:1.6;display:flex}.qj8JTW_title{margin:0;font-size:18px}.qj8JTW_section{align-items:baseline;gap:8px;margin-bottom:6px;font-size:13px;font-weight:600;display:flex}.qj8JTW_sectionHint{color:var(--dsw-alias-label-tertiary);font-size:11.5px;font-weight:400}.qj8JTW_lead{color:var(--dsw-alias-label-secondary);margin:0 0 2px;font-size:12.5px}.qj8JTW_muted{color:var(--dsw-alias-label-tertiary);font-size:11.5px}.qj8JTW_list{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}.qj8JTW_row{justify-content:space-between;align-items:center;gap:10px;font-size:13px;display:flex}.qj8JTW_rowMain{align-items:center;gap:8px;min-width:0;display:flex}.qj8JTW_taskTitle{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.qj8JTW_field{color:var(--dsw-alias-label-secondary);flex-direction:column;gap:4px;font-size:12.5px;display:flex}.qj8JTW_error{color:var(--dsw-alias-state-error-primary);font-size:12.5px}.qj8JTW_actions{gap:8px;display:flex}.qj8JTW_digestHead{align-items:baseline;gap:8px;margin-bottom:6px;display:flex}.qj8JTW_digestLine{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;font-size:12.5px}.qj8JTW_localNotice{border:1px dashed var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);border-radius:10px;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;display:flex}.qj8JTW_localNoticeText{flex-direction:column;gap:2px;min-width:0;font-size:12.5px;display:flex}";
		const tagId = "@office/assistant/F:\\deepseek\\deepseek harness\\apps\\fom-client\\plugins\\office-assistant\\src\\client\\AssistantPage.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@office/assistant";
			tag.dataset.fomCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var AssistantPage_module_css_default = {
			"actions": "qj8JTW_actions",
			"digestHead": "qj8JTW_digestHead",
			"digestLine": "qj8JTW_digestLine",
			"error": "qj8JTW_error",
			"field": "qj8JTW_field",
			"lead": "qj8JTW_lead",
			"list": "qj8JTW_list",
			"localNotice": "qj8JTW_localNotice",
			"localNoticeText": "qj8JTW_localNoticeText",
			"muted": "qj8JTW_muted",
			"page": "qj8JTW_page",
			"row": "qj8JTW_row",
			"rowMain": "qj8JTW_rowMain",
			"section": "qj8JTW_section",
			"sectionHint": "qj8JTW_sectionHint",
			"taskTitle": "qj8JTW_taskTitle",
			"title": "qj8JTW_title"
		};
		//#endregion
		//#region src/client/AssistantPage.tsx
		async function call(url, init) {
			try {
				return await (await fetch(url, init)).json();
			} catch (error) {
				return {
					ok: false,
					message: String(error?.message ?? error)
				};
			}
		}
		const STATUS_LABEL = {
			running: "运行中",
			idle: "已结束",
			failed: "失败"
		};
		const STATUS_TONE = {
			running: "info",
			idle: "success",
			failed: "warning"
		};
		function timeOf(value) {
			if (value === void 0) return "";
			const date = new Date(value);
			return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", {
				hour: "2-digit",
				minute: "2-digit"
			});
		}
		/**
		* 「智能助理」面板：**我的任务 + 派活 + 我的待办**（执行端恒在 PC，D-5）。
		* 待办落本机域 `office_assistant_items`（跨会话/跨重启），与内核「自动化任务」页互不相干。
		*/
		function AssistantPage() {
			const [tasks, setTasks] = (0, react.useState)([]);
			const [text, setText] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [note, setNote] = (0, react.useState)(null);
			const [items, setItems] = (0, react.useState)([]);
			const [digest, setDigest] = (0, react.useState)(null);
			const [digestBusy, setDigestBusy] = (0, react.useState)(false);
			const [digestNote, setDigestNote] = (0, react.useState)(null);
			const [draft, setDraft] = (0, react.useState)("");
			const [showDone, setShowDone] = (0, react.useState)(false);
			const [itemError, setItemError] = (0, react.useState)(null);
			const [itemNote, setItemNote] = (0, react.useState)(null);
			const [localMode, setLocalMode] = (0, react.useState)(false);
			const [noticeDismissed, setNoticeDismissed] = (0, react.useState)(false);
			const refresh = (0, react.useCallback)(async () => {
				const payload = await call("/api/office/tasks");
				if (payload.ok) {
					setTasks(payload.tasks ?? []);
					setError(null);
				} else setError(payload.message ?? "读取任务失败");
			}, []);
			const refreshItems = (0, react.useCallback)(async () => {
				const payload = await call("/api/office/items");
				if (payload.ok) {
					setItems(payload.items ?? []);
					setDigest(payload.digest ?? null);
					setItemError(null);
				} else setItemError(payload.message ?? "读取待办失败");
			}, []);
			(0, react.useEffect)(() => {
				refresh();
				refreshItems();
			}, [refresh, refreshItems]);
			(0, react.useEffect)(() => {
				let alive = true;
				(async () => {
					const payload = await call(MODE_ROUTE);
					if (!alive) return;
					setLocalMode(shouldShowLocalNotice(modeFromPayload(payload)));
				})();
				return () => {
					alive = false;
				};
			}, []);
			const dispatch = (0, react.useCallback)(async () => {
				setBusy(true);
				setError(null);
				setNote(null);
				const payload = await call("/api/office/tasks", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text })
				});
				setBusy(false);
				if (payload.ok) {
					setNote("已派到你的电脑");
					setText("");
					await refresh();
				} else setError(payload.message ?? "派活失败");
			}, [text, refresh]);
			const addItem = (0, react.useCallback)(async () => {
				const payload = await call("/api/office/items", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text: draft })
				});
				if (payload.ok) {
					setDraft("");
					await refreshItems();
				} else setItemError(payload.message ?? "添加失败");
			}, [draft, refreshItems]);
			const toggleItem = (0, react.useCallback)(async (id) => {
				const payload = await call(`/api/office/items?action=toggle&id=${encodeURIComponent(id)}`, { method: "PUT" });
				if (payload.ok) await refreshItems();
				else setItemError(payload.message ?? "勾选失败");
			}, [refreshItems]);
			const removeItem = (0, react.useCallback)(async (id) => {
				const payload = await call(`/api/office/items?id=${encodeURIComponent(id)}`, { method: "DELETE" });
				if (payload.ok) await refreshItems();
				else setItemError(payload.message ?? "删除失败");
			}, [refreshItems]);
			const copyFromSession = (0, react.useCallback)(async () => {
				setItemError(null);
				setItemNote(null);
				const payload = await call("/api/office/items?action=copy-session", { method: "POST" });
				if (!payload.ok) {
					setItemError(payload.message ?? "抄入失败");
					return;
				}
				setItemNote(payload.created === 0 ? "会话里没有新的未完成项" : `已抄入 ${payload.created ?? 0} 条`);
				await refreshItems();
			}, [refreshItems]);
			const generateDigest = (0, react.useCallback)(async () => {
				setDigestBusy(true);
				setDigestNote(null);
				setItemError(null);
				const payload = await call("/api/office/items?action=digest", { method: "POST" });
				setDigestBusy(false);
				if (!payload.ok) {
					setItemError(payload.message ?? "收拢失败");
					return;
				}
				if (payload.digest === null || payload.digest === void 0) {
					setDigestNote(payload.message ?? "今天没有可收拢的事");
					return;
				}
				setDigest(payload.digest);
				setDigestNote("已出今天的简报");
			}, []);
			const { open, done } = groupItems(items);
			const now = Date.now();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: AssistantPage_module_css_default.page,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: AssistantPage_module_css_default.title,
						children: "智能助理"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: AssistantPage_module_css_default.lead,
						children: "看任务、派活、记待办；执行端始终在你自己的电脑上。"
					}),
					localMode && !noticeDismissed ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: AssistantPage_module_css_default.localNotice,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: AssistantPage_module_css_default.localNoticeText,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: LOCAL_MODE_NOTICE.title }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: AssistantPage_module_css_default.muted,
								children: LOCAL_MODE_NOTICE.detail
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							size: "sm",
							onClick: () => setNoticeDismissed(true),
							children: "知道了"
						})]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: AssistantPage_module_css_default.section,
						children: ["我的任务", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: AssistantPage_module_css_default.sectionHint,
							children: "派到你电脑上跑的任务与结果"
						})]
					}), tasks.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: AssistantPage_module_css_default.muted,
						children: "还没有任务。在下面说一句，就派到你的电脑上跑。"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: AssistantPage_module_css_default.list,
						children: tasks.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: AssistantPage_module_css_default.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: AssistantPage_module_css_default.rowMain,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
									tone: STATUS_TONE[task.status],
									children: STATUS_LABEL[task.status]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: AssistantPage_module_css_default.taskTitle,
									children: task.title ?? "（未命名）"
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: AssistantPage_module_css_default.muted,
								children: timeOf(task.updatedAt)
							})]
						}, task.taskId))
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
						variant: "form",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: AssistantPage_module_css_default.section,
								children: ["派活", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: AssistantPage_module_css_default.sectionHint,
									children: "在你的电脑上执行，本机文件与桌面应用都能用"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: AssistantPage_module_css_default.field,
								children: ["说什么", /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
									value: text,
									onChange: (event) => setText(event.target.value),
									placeholder: "例如：把今天的待办汇总成三条"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								disabled: busy || text.trim() === "",
								onClick: () => void dispatch(),
								children: busy ? "派活中…" : "派活"
							}) }),
							note !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: AssistantPage_module_css_default.muted,
								children: note
							}) : null,
							error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: AssistantPage_module_css_default.error,
								children: error
							}) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: AssistantPage_module_css_default.section,
							children: ["我的待办", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: AssistantPage_module_css_default.sectionHint,
								children: "只存在这台电脑上，跨会话、重启都在"
							})]
						}),
						open.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: AssistantPage_module_css_default.muted,
							children: done.length === 0 ? "还没有待办。想到什么就写一条，它只在本机、跨会话都在。" : "没有未完成的。"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: AssistantPage_module_css_default.list,
							children: open.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								className: AssistantPage_module_css_default.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: AssistantPage_module_css_default.rowMain,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: false,
										onChange: () => void toggleItem(item.id),
										"aria-label": "完成"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: AssistantPage_module_css_default.taskTitle,
										children: item.text
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: AssistantPage_module_css_default.rowMain,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: AssistantPage_module_css_default.muted,
										children: itemMeta(item, now)
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "sm",
										onClick: () => void removeItem(item.id),
										children: "删除"
									})]
								})]
							}, item.id))
						}),
						done.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							onClick: () => setShowDone(!showDone),
							children: doneLabel(done.length)
						}), showDone ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: AssistantPage_module_css_default.list,
							children: done.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								className: AssistantPage_module_css_default.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: AssistantPage_module_css_default.rowMain,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: true,
										onChange: () => void toggleItem(item.id),
										"aria-label": "取消完成"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: AssistantPage_module_css_default.taskTitle,
										children: item.text
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: AssistantPage_module_css_default.muted,
									children: itemMeta(item, now)
								})]
							}, item.id))
						}) : null] }) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: AssistantPage_module_css_default.field,
							children: ["加一条", /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								value: draft,
								onChange: (event) => setDraft(event.target.value),
								placeholder: "例如：周三前交周报"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: AssistantPage_module_css_default.actions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								disabled: draft.trim() === "",
								onClick: () => void addItem(),
								children: "添加"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								onClick: () => void copyFromSession(),
								children: "从会话抄进来"
							})]
						}),
						itemNote !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: AssistantPage_module_css_default.muted,
							children: itemNote
						}) : null,
						itemError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: AssistantPage_module_css_default.error,
							children: itemError
						}) : null
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: AssistantPage_module_css_default.section,
							children: ["日终简报", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: AssistantPage_module_css_default.sectionHint,
								children: "把今天做完的和还欠着的收成一条，只在本机"
							})]
						}),
						digest === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: AssistantPage_module_css_default.muted,
							children: "还没有简报。到点会自动出一份，也可以现在出。"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: AssistantPage_module_css_default.digestHead,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
								tone: "info",
								children: digest.date
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: AssistantPage_module_css_default.muted,
								children: [
									digest.doneToday > 0 ? `完成 ${digest.doneToday}` : "今天还没完成",
									digest.openCount > 0 ? ` · 待办 ${digest.openCount}` : " · 已清空",
									digest.overdueCount > 0 ? ` · 逾期 ${digest.overdueCount}` : ""
								]
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: AssistantPage_module_css_default.list,
							children: digest.lines.map((line, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
								className: AssistantPage_module_css_default.digestLine,
								children: line
							}, `${String(index)}-${line}`))
						})] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: AssistantPage_module_css_default.actions,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								disabled: digestBusy,
								onClick: () => void generateDigest(),
								children: digestBusy ? "收拢中…" : "现在收拢"
							})
						}),
						digestNote !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: AssistantPage_module_css_default.muted,
							children: digestNote
						}) : null
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: AssistantPage_module_css_default.muted,
						children: "提醒 / 日程在侧栏「自动化任务」里管理（内核页）。"
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.tsx
		/** 必需服务：UI 槽位注册表。 */
		const inject = ["slots"];
		/** 侧栏图标：智能助理（星芒 + 会话气泡）。 */
		function AssistantIcon() {
			const s = {
				stroke: "currentColor",
				strokeWidth: 1.2,
				fill: "none"
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: 16,
				height: 16,
				viewBox: "0 0 16 16",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M8 1.6 L9.2 5.4 L13 6.6 L9.2 7.8 L8 11.6 L6.8 7.8 L3 6.6 L6.8 5.4 Z",
					...s
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M3.2 11.2 C3.8 12.6 4.9 13.2 6.2 13.2 L11.2 13.2 C12.4 13.2 13.2 12.4 13.2 11.2",
					...s
				})]
			});
		}
		/**
		* 挂「智能助理」面板：`main` 面板（key `office-assistant`）+ `sidebar.panellist` 入口。
		* @param ctx - 客户端根上下文。
		*/
		function apply(ctx) {
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: "office-assistant"
			}, AssistantPage));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: "office-assistant",
				order: 50,
				label: () => "智能助理"
			}, AssistantIcon));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
