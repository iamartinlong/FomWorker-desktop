window.__ModuleLoader__.load({
	id: "@fominfo/dsh-client-ui-login",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region \0fom-css:F:\deepseek\deepseek harness\apps\fom-client\ui\src\Textarea.module.css.mjs
		const css$3 = ".OUMTKq_textarea{box-sizing:border-box;resize:vertical;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);width:100%;min-height:96px;color:var(--dsw-alias-label-primary);padding:8px 10px;font-family:inherit;font-size:13px;line-height:20px}.OUMTKq_textarea:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}.OUMTKq_textarea::placeholder{color:var(--dsw-alias-label-tertiary)}";
		const tagId$3 = "@fominfo/dsh-client-ui-login/F:\\deepseek\\deepseek harness\\apps\\fom-client\\ui\\src\\Textarea.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId$3) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@fominfo/dsh-client-ui-login";
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
		const tagId$2 = "@fominfo/dsh-client-ui-login/F:\\deepseek\\deepseek harness\\apps\\fom-client\\ui\\src\\Card.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@fominfo/dsh-client-ui-login";
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
		const tagId$1 = "@fominfo/dsh-client-ui-login/F:\\deepseek\\deepseek harness\\apps\\fom-client\\ui\\src\\LineTabs.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@fominfo/dsh-client-ui-login";
			tag.dataset.fomCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		/** 内存存储（单测 / 无 localStorage 环境）。 */
		function createMemoryStore() {
			let current = null;
			return {
				load: () => current,
				save: (session) => {
					current = session;
				},
				clear: () => {
					current = null;
				}
			};
		}
		/** localStorage 存储（浏览器）；无 `localStorage` 时退化为内存。 */
		function createLocalStore(key = "fomworker.session") {
			const ls = globalThis.localStorage;
			if (ls === void 0) return createMemoryStore();
			return {
				load: () => {
					try {
						const raw = ls.getItem(key);
						return raw === null ? null : JSON.parse(raw);
					} catch {
						return null;
					}
				},
				save: (session) => {
					try {
						ls.setItem(key, JSON.stringify(session));
					} catch {}
				},
				clear: () => {
					try {
						ls.removeItem(key);
					} catch {}
				}
			};
		}
		/**
		* 造登录会话（浏览器侧）。
		* @param deps - 宿主登录路由 + 存储 + 可注入 fetch。
		* @returns `OfficeSession`。
		*/
		function createSession(deps) {
			const doFetch = deps.fetchImpl ?? fetch;
			const url = deps.sessionUrl ?? "/api/office/login/session";
			return {
				async login(request) {
					const res = await doFetch(url, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(request)
					});
					if (!res.ok) throw new Error(`登录失败：HTTP ${res.status}`);
					const payload = await res.json();
					if (payload.ok !== true || payload.user === void 0) throw new Error(payload.message !== void 0 && payload.message !== "" ? payload.message : `登录失败：HTTP ${payload.status ?? "?"}`);
					deps.store.save({ user: payload.user });
					return payload.user;
				},
				logout() {
					deps.store.clear();
				},
				current() {
					return deps.store.load();
				}
			};
		}
		//#endregion
		//#region src/bindings.ts
		/**
		* `office-login` —— IM 绑定（宿主代理，纯逻辑可测）。
		*
		* 浏览器**不直连平台**（平台不开 CORS）⇒ 浏览器调宿主的 `/api/office/im-bindings`，
		* 宿主带平台令牌（`ctx.credentials` 的 `FOM_PLATFORM_TOKEN`，**令牌不过浏览器**）转发到
		* 平台 `/config/im-bindings`。
		*
		* 渠道口径与平台 `Domain/Im/ImChannels`、契约 `ImBinding.channel` 同集（飞书 / 钉钉 / 企业微信）。
		*/
		/** 宿主的 IM 绑定路由（`GET` 列表 / `POST` 绑定 / `DELETE ?id=` 解绑）。 */
		const IM_BINDINGS_ROUTE = "/api/office/im-bindings";
		/** 三个渠道（顺序即表单里分段的顺序）。 */
		const IM_CHANNELS = [
			{
				channel: "feishu",
				label: "飞书",
				idKind: "open_id",
				placeholder: "ou_…",
				hint: "飞书开放平台「事件订阅」或消息事件的 sender.sender_id.open_id（按应用分配）"
			},
			{
				channel: "dingtalk",
				label: "钉钉",
				idKind: "userid",
				placeholder: "成员 userid",
				hint: "钉钉管理后台 → 通讯录 → 成员详情里的「用户 ID」（企业内唯一）"
			},
			{
				channel: "wecom",
				label: "企业微信",
				idKind: "userid",
				placeholder: "成员 userid",
				hint: "企微管理后台 → 通讯录 → 成员详情里的「账号」（成员 userid）"
			}
		];
		//#endregion
		//#region \0fom-css:F:\deepseek\deepseek harness\apps\fom-client\plugins\office-login\src\client\LoginPage.module.css.mjs
		const css = ".MN7oQq_page{box-sizing:border-box;width:100%;max-width:420px;padding:18px 20px;line-height:1.6}.MN7oQq_title{margin:0 0 12px;font-size:18px}.MN7oQq_field{color:var(--dsw-alias-label-secondary);flex-direction:column;gap:4px;font-size:12.5px;display:flex}.MN7oQq_muted{color:var(--dsw-alias-label-tertiary);font-size:11.5px}.MN7oQq_userLine{font-size:13px}.MN7oQq_error{color:var(--dsw-alias-state-error-primary);margin:10px 0 0;font-size:12.5px}.MN7oQq_bindings{flex-direction:column;gap:8px;margin-top:14px;display:flex}.MN7oQq_bindingList{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}.MN7oQq_bindingRow{word-break:break-all;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px;display:flex}.MN7oQq_errorText{color:var(--dsw-alias-state-error-primary);font-size:12.5px}";
		const tagId = "@fominfo/dsh-client-ui-login/F:\\deepseek\\deepseek harness\\apps\\fom-client\\plugins\\office-login\\src\\client\\LoginPage.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@fominfo/dsh-client-ui-login";
			tag.dataset.fomCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var LoginPage_module_css_default = {
			"bindingList": "MN7oQq_bindingList",
			"bindingRow": "MN7oQq_bindingRow",
			"bindings": "MN7oQq_bindings",
			"error": "MN7oQq_error",
			"errorText": "MN7oQq_errorText",
			"field": "MN7oQq_field",
			"muted": "MN7oQq_muted",
			"page": "MN7oQq_page",
			"title": "MN7oQq_title",
			"userLine": "MN7oQq_userLine"
		};
		//#endregion
		//#region src/client/ImBindings.tsx
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
		/**
		* IM 绑定（飞书 / 钉钉 / 企业微信）：列我的、绑一个、解绑。
		* 全程走**宿主代理** `/api/office/im-bindings`（令牌不过浏览器）。
		*/
		function ImBindings({ active }) {
			const [rows, setRows] = (0, react.useState)([]);
			const [channel, setChannel] = (0, react.useState)("feishu");
			const [openId, setOpenId] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [note, setNote] = (0, react.useState)(null);
			const refresh = (0, react.useCallback)(async () => {
				const payload = await call(IM_BINDINGS_ROUTE);
				if (payload.ok) {
					setRows(payload.bindings ?? []);
					setError(null);
				} else setError(payload.message ?? "读取绑定失败");
			}, []);
			(0, react.useEffect)(() => {
				if (active) refresh();
			}, [active, refresh]);
			const info = IM_CHANNELS.find((item) => item.channel === channel) ?? IM_CHANNELS[0];
			const bind = (0, react.useCallback)(async () => {
				setBusy(true);
				setError(null);
				setNote(null);
				const payload = await call(IM_BINDINGS_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						channel,
						openId
					})
				});
				setBusy(false);
				if (payload.ok) {
					setNote("已绑定");
					setOpenId("");
					await refresh();
				} else setError(payload.message ?? "绑定失败");
			}, [
				channel,
				openId,
				refresh
			]);
			const unbind = (0, react.useCallback)(async (id) => {
				setError(null);
				setNote(null);
				const payload = await call(`${IM_BINDINGS_ROUTE}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
				if (payload.ok) {
					setNote("已解绑");
					await refresh();
				} else setError(payload.message ?? "解绑失败");
			}, [refresh]);
			if (!active) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: LoginPage_module_css_default.bindings,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: LoginPage_module_css_default.userLine,
						children: ["IM 绑定", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: LoginPage_module_css_default.muted,
							children: "　消息会转到本机 agent（绑定后发消息即可）"
						})]
					}),
					rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: LoginPage_module_css_default.muted,
						children: "还没有绑定。"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: LoginPage_module_css_default.bindingList,
						children: rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: LoginPage_module_css_default.bindingRow,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: row.channelLabel }),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: LoginPage_module_css_default.muted,
									children: row.idKind
								}),
								" ",
								row.openId
							] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								onClick: () => void unbind(row.id),
								children: "解绑"
							})]
						}, row.id))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SegmentedControl, {
						id: "im-channel",
						label: "IM 渠道",
						value: channel,
						options: IM_CHANNELS.map((item) => ({
							value: item.channel,
							label: item.label
						})),
						onChange: setChannel
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: LoginPage_module_css_default.field,
						children: [`${info.label} ${info.idKind}`, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
							value: openId,
							onChange: (event) => setOpenId(event.target.value),
							placeholder: info.placeholder
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: LoginPage_module_css_default.muted,
						children: info.hint
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "primary",
						size: "sm",
						disabled: busy || openId.trim() === "",
						onClick: () => void bind(),
						children: busy ? "绑定中…" : "绑定"
					}) }),
					note !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: LoginPage_module_css_default.muted,
						children: note
					}) : null,
					error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: LoginPage_module_css_default.errorText,
						children: error
					}) : null
				]
			});
		}
		//#endregion
		//#region src/client/LoginPage.tsx
		/** 登录 / 账号面板（对着 C1 `/auth/login`；登录经**宿主代理**，见 `session.ts`）。样式走 `LoginPage.module.css`。 */
		function LoginPage() {
			const [session] = (0, react.useState)(() => createSession({ store: createLocalStore() }));
			const [user, setUser] = (0, react.useState)(null);
			const [email, setEmail] = (0, react.useState)("");
			const [password, setPassword] = (0, react.useState)("");
			const [error, setError] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				setUser(session.current()?.user ?? null);
			}, [session]);
			const submit = (0, react.useCallback)(async () => {
				setBusy(true);
				setError(null);
				try {
					setUser(await session.login({
						method: "email",
						email,
						password
					}));
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setBusy(false);
				}
			}, [
				session,
				email,
				password
			]);
			const logout = (0, react.useCallback)(() => {
				session.logout();
				setUser(null);
			}, [session]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: LoginPage_module_css_default.page,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: LoginPage_module_css_default.title,
						children: "登录 · FomWorker"
					}),
					user !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: LoginPage_module_css_default.userLine,
						children: [
							"已登录：",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: user.displayName || user.email || user.userId }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: LoginPage_module_css_default.muted,
								children: `（租户 ${user.tenantId}${user.role ? " · " + user.role : ""}）`
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "outline",
						size: "sm",
						onClick: logout,
						children: "退出登录"
					}) })] }) : null,
					user !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ImBindings, { active: user !== null }) }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
						variant: "form",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: LoginPage_module_css_default.field,
								children: ["邮箱", /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
									value: email,
									onChange: (e) => setEmail(e.target.value),
									placeholder: "you@company.com",
									autoComplete: "username"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: LoginPage_module_css_default.field,
								children: ["密码", /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
									type: "password",
									value: password,
									onChange: (e) => setPassword(e.target.value),
									autoComplete: "current-password"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								disabled: busy,
								onClick: submit,
								children: busy ? "登录中…" : "登录"
							}) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: LoginPage_module_css_default.muted,
								children: "登录经宿主代理（平台地址由宿主配置，契约 /auth/login）"
							})
						]
					}),
					error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: LoginPage_module_css_default.error,
						children: error
					}) : null
				]
			});
		}
		//#endregion
		//#region src/client/index.tsx
		/** 必需服务：UI 槽位注册表。 */
		const inject = ["slots"];
		/** 侧栏图标：登录/账号（16×16 / 线宽 1.2）。 */
		function LoginIcon() {
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
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: 8,
					cy: 5.4,
					r: 2.8,
					...s
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M2.8 13.6 C3.4 10.8 5.4 9.6 8 9.6 C10.6 9.6 12.6 10.8 13.2 13.6",
					...s
				})]
			});
		}
		/**
		* 挂登录面板：`main` 面板（key `office-login`）+ `sidebar.panellist` 入口。
		* @param ctx - 客户端根上下文。
		*/
		function apply(ctx) {
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: "office-login"
			}, LoginPage));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: "office-login",
				order: 97,
				label: () => "登录"
			}, LoginIcon));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
