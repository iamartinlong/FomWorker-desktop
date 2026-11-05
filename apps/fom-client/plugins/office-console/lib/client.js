window.__ModuleLoader__.load({
	id: "@office/console",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region \0fom-css:F:\deepseek\deepseek harness\apps\fom-client\ui\src\Textarea.module.css.mjs
		const css$3 = ".OUMTKq_textarea{box-sizing:border-box;resize:vertical;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);width:100%;min-height:96px;color:var(--dsw-alias-label-primary);padding:8px 10px;font-family:inherit;font-size:13px;line-height:20px}.OUMTKq_textarea:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}.OUMTKq_textarea::placeholder{color:var(--dsw-alias-label-tertiary)}";
		const tagId$3 = "@office/console/F:\\deepseek\\deepseek harness\\apps\\fom-client\\ui\\src\\Textarea.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId$3) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@office/console";
			tag.dataset.fomCss = tagId$3;
			tag.textContent = css$3;
			document.head.appendChild(tag);
		}
		var Textarea_module_css_default = { "textarea": "OUMTKq_textarea" };
		//#endregion
		//#region ../../ui/src/Textarea.tsx
		/**
		* 多行文本输入。内核 `ui-primitives` 无此原子（`Input` 是单行、`InlineEditor` 是行内短草稿），
		* 故在组合层补齐；样式走 `Textarea.module.css`，与 `Input` 对齐。
		* @param ref - 原生 textarea，供焦点控制。
		* @returns textarea 元素；原生属性透传。
		*/
		const Textarea = (0, react.forwardRef)(function Textarea({ className, ...rest }, ref) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				ref,
				className: className === void 0 ? Textarea_module_css_default.textarea : `${Textarea_module_css_default.textarea} ${className}`,
				...rest
			});
		});
		//#endregion
		//#region \0fom-css:F:\deepseek\deepseek harness\apps\fom-client\ui\src\Card.module.css.mjs
		const css$2 = ".pdpsDG_card{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:12px;flex-direction:column;gap:8px;padding:14px;display:flex}.pdpsDG_form{border-color:var(--dsw-alias-border-l);background:var(--dsw-alias-bg-overlay)}";
		const tagId$2 = "@office/console/F:\\deepseek\\deepseek harness\\apps\\fom-client\\ui\\src\\Card.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@office/console";
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
		const tagId$1 = "@office/console/F:\\deepseek\\deepseek harness\\apps\\fom-client\\ui\\src\\LineTabs.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@office/console";
			tag.dataset.fomCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var LineTabs_module_css_default = {
			"tab": "HwPzea_tab",
			"tabs": "HwPzea_tabs"
		};
		//#endregion
		//#region ../../ui/src/LineTabs.tsx
		/** 走位键（WAI-ARIA tabs 模式）。 */
		function isWalkKey(key) {
			return key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End";
		}
		/**
		* **line 型 tabs**（顶级导航用）。内核 `ui-primitives` 只有分段（`SegmentedTabs`）⇒ 本组合层自建，
		* 样式照内核内部两处本地实现（`ui-conversation/ConversationRoot` 与 `ui-settings-plugins/PluginsSettingsSection`）：
		* **发丝底边 + 2px 下划线**（选中/聚焦），active 色取品牌 `--dsw-alias-state-business-primary`。
		*
		* 层次用法：**line tab（顶级）> segment（视图切换）> pill（筛选）**。
		* @param props.items - 非空有序 tab（`value` 唯一、`id`/`panelId` 唯一）。
		* @param props.value - 选中值（须属于 items）；受控。
		* @param props.onChange - 点击/方向键请求的选中值。
		* @param props.label - 本地化的 tablist 无障碍名。
		* @param props.className - 布局放置；面板由调用方渲染。
		* @returns tablist 元素（不含面板）。
		*/
		function LineTabs({ items, value, onChange, label, className }) {
			const onKeyDown = (event, index) => {
				if (!isWalkKey(event.key)) return;
				event.preventDefault();
				const last = items.length - 1;
				let next;
				switch (event.key) {
					case "ArrowLeft":
						next = index === 0 ? last : index - 1;
						break;
					case "ArrowRight":
						next = index === last ? 0 : index + 1;
						break;
					case "Home":
						next = 0;
						break;
					default:
						next = last;
						break;
				}
				const target = items[next];
				const list = event.currentTarget.parentElement;
				if (target === void 0 || list === null) return;
				list.querySelectorAll("[role=\"tab\"]").item(next).focus();
				onChange(target.value);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				role: "tablist",
				"aria-label": label,
				className: className === void 0 ? LineTabs_module_css_default.tabs : `${LineTabs_module_css_default.tabs} ${className}`,
				children: items.map((item, index) => {
					const active = item.value === value;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						id: item.id,
						type: "button",
						role: "tab",
						"aria-selected": active,
						"aria-controls": item.panelId,
						tabIndex: active ? 0 : -1,
						"data-active": active ? "true" : void 0,
						className: LineTabs_module_css_default.tab,
						onClick: () => {
							if (!active) onChange(item.value);
						},
						onKeyDown: (event) => {
							onKeyDown(event, index);
						},
						children: item.label
					}, item.value);
				})
			});
		}
		//#endregion
		//#region src/client/catalog-view.ts
		/** 按 `kind` 分组（保序）。 */
		function groupByKind(entries) {
			const out = {};
			for (const entry of entries) (out[entry.kind] ??= []).push(entry);
			return out;
		}
		/** 分类去重（保序，剔空）。 */
		function categoriesOf(entries) {
			return [...new Set(entries.map((e) => e.category).filter((c) => c !== void 0 && c !== ""))];
		}
		/** 视图过滤：市场/已安装 + 分类。 */
		function filterEntries(entries, view, category, enabled) {
			let list = [...entries];
			if (view === "installed") list = list.filter((e) => enabled[e.id] === true);
			if (category !== null) list = list.filter((e) => e.category === category);
			return list;
		}
		//#endregion
		//#region src/client/import-check.ts
		/**
		* 导入包的**客户端浅检**（导入对话框里即时反馈用）。
		*
		* ⚠️ **权威校验在宿主**：`office-console/portable.ts` 的 `parsePortable*`（**响亮拒**、逐项报问题）。
		* 这里只做「是不是 JSON / `kind` 对不对 / 必备字段在不在」的**即时**反馈——不把 node 侧规则搬进浏览器；
		* 真正落盘前的把关仍由宿主的 400/500 消息给出（对话框会把它显示出来）。
		*
		* 纯模块（无 React / 无 IO），单测直接调。
		*/
		/** 技能包 `kind`（与宿主 `portable.ts` 同值）。 */
		const SKILL_KIND = "fom-skill";
		/** 专家包 `kind`（与宿主 `portable.ts` 同值）。 */
		const EXPERT_KIND = "fom-expert";
		function asRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
		}
		/**
		* 浅检一份导入文件文本。
		* @param kind - 期望类别（技能 / 专家）。
		* @param text - 文件文本（应为 JSON）。
		* @returns `{ ok, message, name? }`。
		*/
		function checkImportFile(kind, text) {
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch {
				return {
					ok: false,
					message: "不是合法 JSON"
				};
			}
			const record = asRecord(parsed);
			if (record === void 0) return {
				ok: false,
				message: "包不是 JSON 对象"
			};
			const expected = kind === "skill" ? SKILL_KIND : EXPERT_KIND;
			if (record.kind !== expected) return {
				ok: false,
				message: `kind 应为 ${expected}（收到 ${JSON.stringify(record.kind)}）`
			};
			if (record.version !== 1) return {
				ok: false,
				message: `version 应为 1（收到 ${JSON.stringify(record.version)}）`
			};
			if (kind === "skill") {
				const slug = typeof record.slug === "string" ? record.slug : "";
				const name = typeof record.name === "string" ? record.name : "";
				const body = typeof record.body === "string" ? record.body : "";
				if (slug === "" || name === "" || body === "") return {
					ok: false,
					message: "缺字段：slug / name / body 都要有"
				};
				return {
					ok: true,
					message: `格式检查通过：技能 ${slug}`,
					name: slug
				};
			}
			const id = typeof record.id === "string" ? record.id : "";
			const name = typeof record.name === "string" ? record.name : "";
			if (id === "" || name === "") return {
				ok: false,
				message: "缺字段：id / name 都要有"
			};
			return {
				ok: true,
				message: `格式检查通过：专家 ${id}`,
				name: id
			};
		}
		//#endregion
		//#region src/client/validate.ts
		/** slug / id 规则（与宿主同一正则）。 */
		const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
		/** 校验新建技能草稿。 */
		function validateSkillDraft(draft) {
			const errors = {};
			if (draft.slug === "") errors.slug = "必填";
			else if (!ID_PATTERN.test(draft.slug)) errors.slug = "小写字母/数字开头，可含 . _ -";
			if (draft.name === "") errors.name = "必填";
			if (draft.body === "") errors.body = "必填";
			return errors;
		}
		/** 校验新建专家草稿。 */
		function validateExpertDraft(draft) {
			const errors = {};
			if (draft.id === "") errors.id = "必填";
			else if (!ID_PATTERN.test(draft.id)) errors.id = "小写字母/数字开头，可含 . _ -";
			if (draft.name === "") errors.name = "必填";
			return errors;
		}
		/** 是否有错误。 */
		function hasErrors(errors) {
			return Object.keys(errors).length > 0;
		}
		//#endregion
		//#region \0fom-css:F:\deepseek\deepseek harness\apps\fom-client\plugins\office-console\src\client\ConsolePage.module.css.mjs
		const css = ".IziyNa_page{box-sizing:border-box;width:100%;padding:18px 20px;line-height:1.6}.IziyNa_head{flex-wrap:wrap;align-items:baseline;gap:10px;display:flex}.IziyNa_title{margin:0;font-size:18px}.IziyNa_tabs{margin:14px 0}.IziyNa_toolbar{flex-wrap:wrap;align-items:center;gap:12px;margin:14px 0 12px;display:flex}.IziyNa_categories{flex-wrap:wrap;gap:6px;display:flex}.IziyNa_summary{color:var(--dsw-alias-label-tertiary);margin-left:auto;font-size:12.5px}.IziyNa_toolbarActions{align-items:center;gap:8px;margin-left:auto;display:flex}.IziyNa_dialog{width:min(560px,100%);max-height:min(760px,100%)}.IziyNa_form{flex-direction:column;gap:10px;display:flex}.IziyNa_field{flex-direction:column;gap:6px;display:flex}.IziyNa_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px}.IziyNa_field input::placeholder{color:var(--dsw-alias-label-tertiary)}.IziyNa_fieldError{color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:16px}.IziyNa_fileRow{align-items:center;gap:10px;min-width:0;display:flex}.IziyNa_fileName{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;overflow:hidden}.IziyNa_actions{gap:8px;display:flex}.IziyNa_actionsBlock{margin-bottom:12px}.IziyNa_notice{margin:0 0 12px;font-size:13px}.IziyNa_noticeOk{color:var(--dsw-alias-state-success-primary)}.IziyNa_noticeErr{color:var(--dsw-alias-state-error-primary)}.IziyNa_empty{text-align:center;color:var(--dsw-alias-label-tertiary);padding:28px 0;font-size:13px}.IziyNa_grid{grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px;display:grid}.IziyNa_hint{color:var(--dsw-alias-label-tertiary);font-size:11.5px}.IziyNa_muted{color:var(--dsw-alias-label-tertiary);font-size:12.5px}.IziyNa_cardHead{align-items:center;gap:10px;display:flex}.IziyNa_bubble{background:var(--dsw-alias-brand-primary);width:34px;height:34px;color:var(--dsw-alias-label-primary-foreground);border-radius:10px;flex:none;justify-content:center;align-items:center;font-size:15px;font-weight:700;display:inline-flex}.IziyNa_name{flex:1;min-width:0;font-size:14px;font-weight:600}.IziyNa_desc{-webkit-line-clamp:2;min-height:38px;color:var(--dsw-alias-label-secondary);-webkit-box-orient:vertical;font-size:12.5px;line-height:1.55;display:-webkit-box;overflow:hidden}.IziyNa_foot{color:var(--dsw-alias-label-tertiary);align-items:center;gap:8px;margin-top:2px;font-size:11.5px;display:flex}.IziyNa_ref{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}.IziyNa_quota{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:10px;flex-wrap:wrap;align-items:center;gap:12px;margin:12px 0 0;padding:10px 12px;font-size:12.5px;display:flex}.IziyNa_quotaTitle{color:var(--dsw-alias-label-primary);font-weight:600}.IziyNa_quotaItem{white-space:nowrap}.IziyNa_quotaExceeded{white-space:nowrap;color:var(--dsw-alias-state-error-primary)}.IziyNa_quotaActions{align-items:center;gap:8px;margin-left:auto;display:flex}";
		const tagId = "@office/console/F:\\deepseek\\deepseek harness\\apps\\fom-client\\plugins\\office-console\\src\\client\\ConsolePage.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@office/console";
			tag.dataset.fomCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var ConsolePage_module_css_default = {
			"actions": "IziyNa_actions",
			"actionsBlock": "IziyNa_actionsBlock",
			"bubble": "IziyNa_bubble",
			"cardHead": "IziyNa_cardHead",
			"categories": "IziyNa_categories",
			"desc": "IziyNa_desc",
			"dialog": "IziyNa_dialog",
			"empty": "IziyNa_empty",
			"field": "IziyNa_field",
			"fieldError": "IziyNa_fieldError",
			"fieldLabel": "IziyNa_fieldLabel",
			"fileName": "IziyNa_fileName",
			"fileRow": "IziyNa_fileRow",
			"foot": "IziyNa_foot",
			"form": "IziyNa_form",
			"grid": "IziyNa_grid",
			"head": "IziyNa_head",
			"hint": "IziyNa_hint",
			"muted": "IziyNa_muted",
			"name": "IziyNa_name",
			"notice": "IziyNa_notice",
			"noticeErr": "IziyNa_noticeErr",
			"noticeOk": "IziyNa_noticeOk",
			"page": "IziyNa_page",
			"quota": "IziyNa_quota",
			"quotaActions": "IziyNa_quotaActions",
			"quotaExceeded": "IziyNa_quotaExceeded",
			"quotaItem": "IziyNa_quotaItem",
			"quotaTitle": "IziyNa_quotaTitle",
			"ref": "IziyNa_ref",
			"summary": "IziyNa_summary",
			"tabs": "IziyNa_tabs",
			"title": "IziyNa_title",
			"toolbar": "IziyNa_toolbar",
			"toolbarActions": "IziyNa_toolbarActions"
		};
		//#endregion
		//#region src/client/dialogs.tsx
		/**
		* 控制台的三个**对话框**（`ui-primitives` 的 `Modal`）：新建技能 / 新建专家 / 导入（技能或专家）。
		*
		* 口径（见 `前端技术栈与页面实现规范v0.1` §3.9/§3.10）：工具栏行只留**操作按钮**，表单进**对话框**；
		* **关了就卸载**；字段**标签式**（label 在上，placeholder 只留示例）；**提交前做前端必填/格式校验**
		* （`validate.ts`）——不把坏输入打到后端；宿主的**权威**校验失败（400）**显示在对话框里**，不落页面通知。
		*/
		const EMPTY_SKILL = {
			slug: "",
			name: "",
			description: "",
			body: ""
		};
		const EMPTY_EXPERT = {
			id: "",
			name: "",
			description: "",
			personaPrefix: "",
			planMode: false,
			subagent: false
		};
		/** 标签式字段（label 在上、错误在下）。 */
		function Field({ label, error, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: ConsolePage_module_css_default.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ConsolePage_module_css_default.fieldLabel,
						children: label
					}),
					children,
					error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ConsolePage_module_css_default.fieldError,
						children: error
					}) : null
				]
			});
		}
		/** 新建技能对话框。 */
		function CreateSkillDialog({ open, busy, onClose, onSubmit }) {
			const [draft, setDraft] = (0, react.useState)(EMPTY_SKILL);
			const [errors, setErrors] = (0, react.useState)({});
			const [server, setServer] = (0, react.useState)(null);
			const close = () => {
				setDraft(EMPTY_SKILL);
				setErrors({});
				setServer(null);
				onClose();
			};
			const submit = () => {
				setServer(null);
				const found = validateSkillDraft(draft);
				setErrors(found);
				if (hasErrors(found)) return;
				onSubmit(draft).then((result) => {
					if (!result.ok) setServer(result);
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open,
				onClose: close,
				title: "新建技能",
				closeLabel: "关闭",
				className: ConsolePage_module_css_default.dialog,
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					onClick: close,
					children: "取消"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					disabled: busy,
					onClick: submit,
					children: busy ? "创建中…" : "创建"
				})] }),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ConsolePage_module_css_default.form,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "标识 slug（小写字母/数字开头，可含 . _ -）",
							error: errors.slug,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								"data-modal-autofocus": true,
								placeholder: "例：meeting-minutes",
								value: draft.slug,
								onChange: (e) => setDraft({
									...draft,
									slug: e.target.value
								})
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "名称",
							error: errors.name,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								placeholder: "例：会议纪要分发",
								value: draft.name,
								onChange: (e) => setDraft({
									...draft,
									name: e.target.value
								})
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "一句话说明（可选）",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								placeholder: "例：把会议记录整理成结构化纪要",
								value: draft.description,
								onChange: (e) => setDraft({
									...draft,
									description: e.target.value
								})
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "技能正文（SKILL.md 指令）",
							error: errors.body,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Textarea, {
								placeholder: "给模型的指令正文…",
								value: draft.body,
								onChange: (e) => setDraft({
									...draft,
									body: e.target.value
								}),
								rows: 8
							})
						}),
						server !== null && !server.ok ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "danger",
							children: server.message
						}) : null
					]
				})
			});
		}
		/** 新建专家对话框。 */
		function CreateExpertDialog({ open, busy, onClose, onSubmit }) {
			const [draft, setDraft] = (0, react.useState)(EMPTY_EXPERT);
			const [errors, setErrors] = (0, react.useState)({});
			const [server, setServer] = (0, react.useState)(null);
			const close = () => {
				setDraft(EMPTY_EXPERT);
				setErrors({});
				setServer(null);
				onClose();
			};
			const submit = () => {
				setServer(null);
				const found = validateExpertDraft(draft);
				setErrors(found);
				if (hasErrors(found)) return;
				onSubmit(draft).then((result) => {
					if (!result.ok) setServer(result);
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open,
				onClose: close,
				title: "新建专家",
				closeLabel: "关闭",
				className: ConsolePage_module_css_default.dialog,
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					onClick: close,
					children: "取消"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					disabled: busy,
					onClick: submit,
					children: busy ? "创建中…" : "创建"
				})] }),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ConsolePage_module_css_default.form,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "标识 id（小写字母/数字开头，可含 . _ -）",
							error: errors.id,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								"data-modal-autofocus": true,
								placeholder: "例：contract-reviewer",
								value: draft.id,
								onChange: (e) => setDraft({
									...draft,
									id: e.target.value
								})
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "名称",
							error: errors.name,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								placeholder: "例：合同审阅官",
								value: draft.name,
								onChange: (e) => setDraft({
									...draft,
									name: e.target.value
								})
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "一句话说明（可选）",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								placeholder: "例：逐条比对合同条款与法务红线",
								value: draft.description,
								onChange: (e) => setDraft({
									...draft,
									description: e.target.value
								})
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "人设（可选：是谁 + 什么背景 + 擅长什么）",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								placeholder: "例：你是资深法务，擅长合同风险识别",
								value: draft.personaPrefix,
								onChange: (e) => setDraft({
									...draft,
									personaPrefix: e.target.value
								})
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
							checked: draft.planMode,
							label: "开启「规划模式」（plan-mode）",
							onChange: (next) => setDraft({
								...draft,
								planMode: next
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
							checked: draft.subagent,
							label: "开启「子代理委派」（tool-subagent）",
							onChange: (next) => setDraft({
								...draft,
								subagent: next
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ConsolePage_module_css_default.hint,
							children: "提示：也可以直接在对话里说「帮我创建一个专家」，由 AI 引导创建。"
						}),
						server !== null && !server.ok ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "danger",
							children: server.message
						}) : null
					]
				})
			});
		}
		/** 导入对话框（技能 / 专家）：格式说明 + 选文件 + 浅检结果 + 宿主结果。 */
		function ImportDialog({ kind, open, busy, onClose, onImport }) {
			const fileRef = (0, react.useRef)(null);
			const [file, setFile] = (0, react.useState)(null);
			const [check, setCheck] = (0, react.useState)(null);
			const [bundle, setBundle] = (0, react.useState)(null);
			const [server, setServer] = (0, react.useState)(null);
			const close = () => {
				setFile(null);
				setCheck(null);
				setBundle(null);
				setServer(null);
				onClose();
			};
			const pick = (chosen) => {
				setServer(null);
				setFile({
					name: chosen.name,
					size: chosen.size
				});
				chosen.text().then((text) => {
					const result = checkImportFile(kind, text);
					setCheck(result);
					try {
						setBundle(result.ok ? JSON.parse(text) : null);
					} catch {
						setBundle(null);
					}
				}).catch(() => {
					setCheck({
						ok: false,
						message: "读取文件失败"
					});
					setBundle(null);
				});
			};
			const label = kind === "skill" ? "技能" : "专家";
			const expectedKind = kind === "skill" ? "fom-skill" : "fom-expert";
			const fields = kind === "skill" ? "slug / name / body" : "id / name";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open,
				onClose: close,
				title: `导入${label}`,
				closeLabel: "关闭",
				className: ConsolePage_module_css_default.dialog,
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					onClick: close,
					children: "取消"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					disabled: busy || check?.ok !== true,
					onClick: () => {
						onImport(bundle).then((result) => {
							setServer(result);
						});
					},
					children: busy ? "导入中…" : "导入"
				})] }),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ConsolePage_module_css_default.form,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: ConsolePage_module_css_default.hint,
							children: `格式：单文件 JSON —— kind 为 ${expectedKind}、version 为 1，必备字段 ${fields}。`
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							ref: fileRef,
							type: "file",
							accept: "application/json,.json",
							hidden: true,
							onChange: (e) => {
								const chosen = e.target.files?.[0];
								if (chosen !== void 0) pick(chosen);
								e.target.value = "";
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ConsolePage_module_css_default.fileRow,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								onClick: () => fileRef.current?.click(),
								children: "选择文件…"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ConsolePage_module_css_default.fileName,
								children: file === null ? "未选择文件" : `${file.name}（${file.size} B）`
							})]
						}),
						check !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: check.ok ? "success" : "danger",
							children: check.message
						}) : null,
						server !== null && !server.ok ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "danger",
							children: server.message
						}) : null
					]
				})
			});
		}
		//#endregion
		//#region src/client/ConsolePage.tsx
		/** 三个 tab（技能 / 专家 / 连接器）。 */
		const TABS = [
			{
				kind: "skill",
				label: "技能",
				hint: "SKILL.md 能力包"
			},
			{
				kind: "expert",
				label: "专家",
				hint: "角色化 Agent 预设"
			},
			{
				kind: "connector",
				label: "连接器",
				hint: "飞书 / MCP 等外部接入"
			}
		];
		/** 主 tab（line 型，顶级导航）。 */
		const TAB_ITEMS = [
			{
				value: "skill",
				label: "技能",
				id: "office-console-tab-skill",
				panelId: "office-console-panel-skill"
			},
			{
				value: "expert",
				label: "专家",
				id: "office-console-tab-expert",
				panelId: "office-console-panel-expert"
			},
			{
				value: "connector",
				label: "连接器",
				id: "office-console-tab-connector",
				panelId: "office-console-panel-connector"
			}
		];
		/** 每类标签色调（走 `Tag` 的 tone，不写颜色字面量）。 */
		const KIND_TONE = {
			skill: "info",
			expert: "warning",
			connector: "success"
		};
		/** 市场 / 已安装 双态（ui-primitives `SegmentedControl`）。 */
		const VIEW_OPTIONS = [{
			value: "market",
			label: "市场"
		}, {
			value: "installed",
			label: "已安装"
		}];
		async function getJson(url) {
			const res = await fetch(url, { credentials: "same-origin" });
			if (!res.ok) throw new Error("HTTP " + res.status);
			return await res.json();
		}
		async function postAction(body) {
			const res = await fetch("/api/office/console/action", {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			let payload = null;
			try {
				payload = await res.json();
			} catch {}
			return {
				status: res.status,
				payload
			};
		}
		function EntryCard({ entry, enabled, canAct, canExport, onToggle, onConnector, onSkillRemove, onExport }) {
			const installed = enabled;
			const connectorRef = entry.kind === "connector" ? entry.source?.ref : void 0;
			const isConnector = connectorRef !== void 0 && connectorRef !== "";
			const isLocalSkill = entry.kind === "skill" && entry.origin === "local";
			const tab = TABS.find((t) => t.kind === entry.kind);
			const tone = KIND_TONE[entry.kind] ?? "neutral";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ConsolePage_module_css_default.cardHead,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": "true",
							className: ConsolePage_module_css_default.bubble,
							children: entry.icon ?? (tab ? tab.label[0] : "·")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ConsolePage_module_css_default.name,
							children: entry.name
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: entry.origin === "local" ? "neutral" : "quiet",
							children: entry.origin === "local" ? "本地" : "平台"
						}),
						entry.category ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone,
							children: entry.category
						}) : null
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: ConsolePage_module_css_default.desc,
					children: entry.description || "（无描述）"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ConsolePage_module_css_default.foot,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["v", entry.version || "—"] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "·" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ConsolePage_module_css_default.ref,
							children: entry.source ? entry.source.ref || entry.source.kind : "内置"
						}),
						installed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "success",
							children: "已安装"
						}) : null,
						canExport ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							size: "sm",
							onClick: () => onExport(entry),
							children: "导出"
						}) : null,
						canAct ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: installed ? "outline" : "primary",
							onClick: () => isConnector ? onConnector(entry.id, connectorRef ?? "", !installed) : isLocalSkill ? onSkillRemove(entry.id.replace(/^skill:/, "")) : onToggle(entry.id, !enabled),
							children: isConnector ? installed ? "卸载" : "+ 安装" : isLocalSkill ? "删除" : installed ? "管理" : "+ 安装"
						}) : null
					]
				})
			] });
		}
		/** office-console 主面板（三个 tab；顶级 line tabs + 子级 segment + 筛选 pill；新建/导入走对话框）。 */
		function ConsolePage() {
			const [state, setState] = (0, react.useState)({ status: "loading" });
			const [notice, setNotice] = (0, react.useState)(null);
			const [tab, setTab] = (0, react.useState)("skill");
			const [view, setView] = (0, react.useState)("market");
			const [category, setCategory] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [creating, setCreating] = (0, react.useState)(false);
			const [expertCreating, setExpertCreating] = (0, react.useState)(false);
			const [importing, setImporting] = (0, react.useState)(null);
			const load = (0, react.useCallback)(async () => {
				const [catalog, st] = await Promise.all([getJson("/office/catalog"), getJson("/office/console/state")]);
				const role = String(st.operatorRole ?? "");
				const actions = await getJson("/office/console/actions?role=" + encodeURIComponent(role));
				const capabilities = st.capabilities ?? [];
				const decisions = actions.decisions ?? [];
				setState({
					status: "ready",
					entries: catalog.entries ?? [],
					operatorRole: role,
					enabled: Object.fromEntries(capabilities.map((c) => [c.id, c.enabled])),
					decisions: Object.fromEntries(decisions.map((d) => [d.action, d]))
				});
			}, []);
			(0, react.useEffect)(() => {
				let alive = true;
				load().catch((e) => {
					if (alive) setState({
						status: "error",
						error: String(e?.message ?? e)
					});
				});
				return () => {
					alive = false;
				};
			}, [load]);
			const onToggle = (0, react.useCallback)(async (id, on) => {
				setNotice(null);
				const { status, payload } = await postAction({
					action: "capability.toggle",
					payload: {
						id,
						on
					}
				});
				if (status === 200) {
					await load();
					setNotice({
						ok: true,
						text: `${id} → ${on ? "安装/启用" : "停用"}`
					});
				} else if (status === 202) setNotice({
					ok: false,
					text: "需要审批（服务端未批准）"
				});
				else setNotice({
					ok: false,
					text: `失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ""}`
				});
			}, [load]);
			const onConnector = (0, react.useCallback)(async (id, ref, install) => {
				setNotice(null);
				const { status, payload } = await postAction({
					action: install ? "connector.install" : "connector.remove",
					payload: {
						id,
						ref
					}
				});
				if (status === 200) {
					await load();
					setNotice({
						ok: true,
						text: `${id} → ${install ? "已安装" : "已卸载"}`
					});
				} else if (status === 202) setNotice({
					ok: false,
					text: "需要审批（服务端未批准）"
				});
				else setNotice({
					ok: false,
					text: `失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ""}`
				});
			}, [load]);
			const onCreateSkill = (0, react.useCallback)(async (draft) => {
				setNotice(null);
				setBusy(true);
				try {
					const { status, payload } = await postAction({
						action: "skill.create",
						payload: draft
					});
					if (status === 200) {
						setCreating(false);
						await load();
						setNotice({
							ok: true,
							text: `技能 ${draft.slug} 已创建`
						});
						return {
							ok: true,
							message: "已创建"
						};
					}
					return {
						ok: false,
						message: status === 202 ? "需要审批（服务端未批准）" : `失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ""}`
					};
				} finally {
					setBusy(false);
				}
			}, [load]);
			const onSkillRemove = (0, react.useCallback)(async (slug) => {
				setNotice(null);
				const { status, payload } = await postAction({
					action: "skill.remove",
					payload: { slug }
				});
				if (status === 200) {
					await load();
					setNotice({
						ok: true,
						text: `技能 ${slug} 已删除`
					});
				} else if (status === 202) setNotice({
					ok: false,
					text: "需要审批（服务端未批准）"
				});
				else setNotice({
					ok: false,
					text: `失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ""}`
				});
			}, [load]);
			const onCreateExpert = (0, react.useCallback)(async (draft) => {
				setNotice(null);
				setBusy(true);
				try {
					const enable = [draft.planMode ? "plan-mode" : null, draft.subagent ? "tool-subagent" : null].filter((id) => id !== null);
					const { status, payload } = await postAction({
						action: "expert.create",
						payload: {
							id: draft.id,
							name: draft.name,
							description: draft.description,
							persona: draft.personaPrefix === "" ? {} : { prefix: draft.personaPrefix },
							tools: { enable }
						}
					});
					if (status === 200) {
						setExpertCreating(false);
						await load();
						setNotice({
							ok: true,
							text: `专家 ${draft.id} 已创建`
						});
						return {
							ok: true,
							message: "已创建"
						};
					}
					return {
						ok: false,
						message: status === 202 ? "需要审批（服务端未批准）" : `失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ""}`
					};
				} finally {
					setBusy(false);
				}
			}, [load]);
			const onExport = (0, react.useCallback)(async (entry) => {
				setNotice(null);
				const isSkill = entry.kind === "skill";
				const key = entry.id.replace(/^skill:/u, "").replace(/^expert:/u, "");
				const { status, payload } = await postAction({
					action: isSkill ? "skill.export" : "expert.export",
					payload: isSkill ? { slug: key } : { id: key }
				});
				if (status !== 200) {
					setNotice({
						ok: false,
						text: `导出失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ""}`
					});
					return;
				}
				const bundle = payload?.value?.bundle;
				const name = `${isSkill ? "skill" : "expert"}-${key}.json`;
				const url = URL.createObjectURL(new Blob([`${JSON.stringify(bundle, void 0, 2)}\n`], { type: "application/json" }));
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.download = name;
				anchor.click();
				URL.revokeObjectURL(url);
				setNotice({
					ok: true,
					text: `已导出 ${name}`
				});
			}, []);
			/** 导入（宿主权威校验）：成功关对话框；失败把**宿主原话**留在对话框里。 */
			const onImport = (0, react.useCallback)(async (kind, bundle) => {
				setNotice(null);
				setBusy(true);
				try {
					const { status, payload } = await postAction({
						action: `${kind}.import`,
						payload: { bundle }
					});
					if (status === 200) {
						setImporting(null);
						await load();
						setNotice({
							ok: true,
							text: `已导入（${kind === "skill" ? "技能" : "专家"}）`
						});
						return {
							ok: true,
							message: "已导入"
						};
					}
					const message = status === 202 ? "需要审批（服务端未批准）" : `导入失败：HTTP ${status} ${payload ? JSON.stringify(payload) : ""}`;
					setNotice({
						ok: false,
						text: message
					});
					return {
						ok: false,
						message
					};
				} finally {
					setBusy(false);
				}
			}, [load]);
			if (state.status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: ConsolePage_module_css_default.page,
				children: "加载中…"
			});
			if (state.status === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: ConsolePage_module_css_default.page,
				children: ["读取失败：", state.error]
			});
			const byKind = groupByKind(state.entries ?? []);
			const canToggle = !!state.decisions?.["capability.toggle"]?.allowed;
			const active = TABS.find((t) => t.kind === tab) ?? TABS[0];
			const kindList = byKind[active.kind] ?? [];
			const categories = categoriesOf(kindList);
			const list = filterEntries(kindList, view, category, state.enabled ?? {});
			const creatable = active.kind !== "connector" && !!state.decisions?.[active.kind === "skill" ? "skill.create" : "expert.create"]?.allowed;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: ConsolePage_module_css_default.page,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ConsolePage_module_css_default.head,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							className: ConsolePage_module_css_default.title,
							children: "专家 · 技能 · 连接器"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ConsolePage_module_css_default.muted,
							children: `平台能力 · 操作者：${state.operatorRole}${canToggle ? "（可启停）" : "（只读）"}`
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: ConsolePage_module_css_default.tabs,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LineTabs, {
							items: TAB_ITEMS,
							value: tab,
							label: "能力类型",
							onChange: (v) => {
								setTab(v);
								setCategory(null);
								setNotice(null);
							}
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ConsolePage_module_css_default.toolbar,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SegmentedControl, {
								id: "office-console-view",
								value: view,
								options: VIEW_OPTIONS,
								label: "市场 / 已安装",
								onChange: (v) => {
									setView(v);
									setNotice(null);
								}
							}),
							categories.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: ConsolePage_module_css_default.categories,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
									active: category === null,
									onClick: () => setCategory(null),
									children: "全部"
								}), categories.map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
									active: category === c,
									onClick: () => setCategory(c),
									children: c
								}, c))]
							}) : null,
							creatable ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: ConsolePage_module_css_default.toolbarActions,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									size: "sm",
									onClick: () => {
										if (active.kind === "skill") setCreating(true);
										else setExpertCreating(true);
									},
									children: active.kind === "skill" ? "＋ 新建技能" : "＋ 新建专家"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									onClick: () => setImporting(active.kind),
									children: active.kind === "skill" ? "导入技能" : "导入专家"
								})]
							}) : null
						]
					}),
					notice ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: `${ConsolePage_module_css_default.notice} ${notice.ok ? ConsolePage_module_css_default.noticeOk : ConsolePage_module_css_default.noticeErr}`,
						children: notice.text
					}) : null,
					list.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: ConsolePage_module_css_default.empty,
						children: view === "installed" ? `暂无已安装的${active.label}` : `暂无${active.label}`
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: ConsolePage_module_css_default.grid,
						children: list.map((entry) => {
							const connector = entry.kind === "connector" && !!entry.source?.ref;
							const canAct = !!state.decisions?.[connector ? "connector.install" : "capability.toggle"]?.allowed;
							const exportKey = entry.kind === "skill" ? "skill.export" : "expert.export";
							const canExport = entry.origin === "local" && !!state.decisions?.[exportKey]?.allowed;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EntryCard, {
								entry,
								enabled: !!state.enabled?.[entry.id],
								canAct,
								canExport,
								onToggle,
								onConnector,
								onSkillRemove,
								onExport
							}, entry.id);
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreateSkillDialog, {
						open: creating,
						busy,
						onClose: () => setCreating(false),
						onSubmit: onCreateSkill
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreateExpertDialog, {
						open: expertCreating,
						busy,
						onClose: () => setExpertCreating(false),
						onSubmit: onCreateExpert
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ImportDialog, {
						kind: importing ?? "skill",
						open: importing !== null,
						busy,
						onClose: () => setImporting(null),
						onImport: (bundle) => onImport(importing ?? "skill", bundle)
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.tsx
		/** 必需服务：UI 槽位注册表。 */
		const inject = ["slots"];
		/** 侧栏图标：三类资源（技能/专家/连接器）—— 16×16 / 线宽 1.2 / 圆角（对齐 WorkBuddy）。 */
		function ConsoleIcon() {
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
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: 1.6,
						y: 1.6,
						width: 5.2,
						height: 5.2,
						rx: 1.6,
						...s
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: 9.2,
						y: 1.6,
						width: 5.2,
						height: 5.2,
						rx: 1.6,
						...s
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: 1.6,
						y: 9.2,
						width: 5.2,
						height: 5.2,
						rx: 1.6,
						...s
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: 11.8,
						cy: 11.8,
						r: 2.6,
						...s
					})
				]
			});
		}
		/**
		* 挂 office-console 控制台：`main` 面板（key `office-console`）+ `sidebar.panellist` 入口。
		* @param ctx - 客户端根上下文。
		*/
		function apply(ctx) {
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: "office-console"
			}, ConsolePage));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: "office-console",
				order: 98,
				label: () => "专家·技能·连接器"
			}, ConsoleIcon));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
