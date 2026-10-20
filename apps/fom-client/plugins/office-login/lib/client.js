window.__ModuleLoader__.load({
	id: "@fominfo/dsh-client-ui-login",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom = require("react-dom");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/mode.ts
		/** 本地模式标记的存储键。 */
		const MODE_KEY = "fomworker.mode";
		/** 本地模式标记的值。 */
		const LOCAL_MODE_VALUE = "local";
		/** 内存实现（单测 / 无 localStorage 环境）。 */
		function createMemoryModeStore() {
			const rows = /* @__PURE__ */ new Map();
			return {
				get: (key) => rows.get(key) ?? null,
				set: (key, value) => {
					rows.set(key, value);
				},
				remove: (key) => {
					rows.delete(key);
				}
			};
		}
		/** localStorage 实现；无 `localStorage` 时退化为内存（隐私模式 / SSR）。 */
		function createLocalModeStore() {
			const ls = globalThis.localStorage;
			if (ls === void 0) return createMemoryModeStore();
			return {
				get: (key) => {
					try {
						return ls.getItem(key);
					} catch {
						return null;
					}
				},
				set: (key, value) => {
					try {
						ls.setItem(key, value);
					} catch {}
				},
				remove: (key) => {
					try {
						ls.removeItem(key);
					} catch {}
				}
			};
		}
		/** 读本地模式标记。 */
		function isLocalMode(store) {
			return store.get(MODE_KEY) === LOCAL_MODE_VALUE;
		}
		/** 记下「先本地使用」。 */
		function enterLocalMode(store) {
			store.set(MODE_KEY, LOCAL_MODE_VALUE);
		}
		/** 清掉本地模式标记（登录成功 / 回门禁时调）。 */
		function clearLocalMode(store) {
			store.remove(MODE_KEY);
		}
		/**
		* 判当前该进哪个态。
		*
		* **身份优先**：既有身份又有本地标记时按 `signed`（标记是登录前的选择，登录后应失效）。
		* @param sessionStore 身份存储（`session.ts` 的 `SessionStore`）
		* @param modeStore 模式存储
		* @returns 三态
		*/
		function resolveMode(sessionStore, modeStore) {
			const session = sessionStore.load();
			if (session !== null && session.user !== void 0) return "signed";
			if (isLocalMode(modeStore)) return "local";
			return "gate";
		}
		/** 该不该挡门禁（`gate` 才挡）。 */
		function shouldGate(mode) {
			return mode === "gate";
		}
		/**
		* 从身份里取显示名（账号行用；缺失时退回邮箱、再退回「已登录」）。
		* @param user 身份
		* @returns 一行显示名
		*/
		function displayNameOf(user) {
			const name = (user.displayName ?? "").trim();
			if (name !== "") return name;
			const email = (user.email ?? "").trim();
			if (email !== "") return email;
			return "已登录";
		}
		/** 头像用的首字（中文取首字，英文取首字母大写）。 */
		function avatarInitialOf(user) {
			return ([...displayNameOf(user)][0] ?? "·").toUpperCase();
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
		//#region src/client/login-state.ts
		/**
		* 登录的**可观察状态源**（两个槽位共享）：模式 + 当前身份。
		*
		* 为什么不用 `window.location.reload()` 切态：门禁（`shell.overlay`）与账号行
		* （`sidebar.footer.action`）是**两个独立槽位**，需要看同一份状态 ⇒ 用槽位
		* `inject` 里的 `hooks` 约定（裸 `getSnapshot`/`subscribe` 源），渲染器把它绑成
		* `useMode(selector)` 交给组件（见 `docs/subsystems/slots.md` §Developer-provided injection）。
		*/
		/** 宿主模式标记路由（浏览器把模式写给宿主，供 office-channel 等读取）。 */
		const MODE_ROUTE = "/api/office/login/mode";
		/** 宿主登出路由（清宿主凭据库里的令牌）。 */
		const LOGOUT_ROUTE = "/api/office/login/session";
		/**
		* 通知宿主清令牌（best-effort：失败也照常回门禁，只是宿主侧的令牌可能还在）。
		*
		* 为什么必须有它：退出登录如果只清浏览器身份，**宿主凭据库里的令牌仍然有效** ⇒
		* 通道/上报/模型网关继续用旧令牌连平台，等于「退出没退」。
		*/
		function publishLogout() {
			try {
				fetch(LOGOUT_ROUTE, { method: "DELETE" }).catch(() => {});
			} catch {}
		}
		/**
		* 把模式写给宿主（best-effort：失败不影响本地状态）。
		*
		* 为什么需要它：本地模式标记在 `localStorage`，**宿主插件看不见**；而 `office-channel`
		* 要在启动时判断「用户明确选了不连平台」才能降频、不刷日志（2026-10-19 实测）。
		* @param mode 模式
		*/
		function publishMode(mode) {
			try {
				fetch(MODE_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ mode })
				}).catch(() => {});
			} catch {}
		}
		/**
		* 造登录状态。
		* @param sessionStore 身份存储（`session.ts`）
		* @param modeStore 模式存储
		* @returns 源与动作
		*/
		function createLoginState(sessionStore = createLocalStore(), modeStore = createLocalModeStore()) {
			const read = () => {
				const session = sessionStore.load();
				return {
					mode: resolveMode(sessionStore, modeStore),
					user: session?.user ?? null
				};
			};
			let snapshot = read();
			const listeners = /* @__PURE__ */ new Set();
			/** 重读并通知（只在值真的变了时换引用，避免多余重渲染）。 */
			const refresh = () => {
				const next = read();
				if (next.mode === snapshot.mode && next.user === snapshot.user) return;
				snapshot = next;
				for (const listener of listeners) listener();
			};
			return {
				source: {
					getSnapshot: () => snapshot,
					subscribe: (listener) => {
						listeners.add(listener);
						return () => {
							listeners.delete(listener);
						};
					}
				},
				signedIn: () => {
					clearLocalMode(modeStore);
					refresh();
					publishMode("signed");
				},
				useLocal: () => {
					enterLocalMode(modeStore);
					refresh();
					publishMode("local");
				},
				signOut: () => {
					createSession({ store: sessionStore }).logout();
					clearLocalMode(modeStore);
					refresh();
					publishLogout();
					publishMode("gate");
				},
				requireSignIn: () => {
					clearLocalMode(modeStore);
					refresh();
					publishMode("gate");
				}
			};
		}
		//#endregion
		//#region \0fom-css:F:\deepseek\deepseek harness\apps\fom-client\plugins\office-login\src\client\LoginPage.module.css.mjs
		const css$2 = ".MN7oQq_gate{z-index:100;box-sizing:border-box;background:var(--dsw-alias-bg-base);isolation:isolate;grid-area:1/1/-1/-1;justify-content:center;align-items:center;padding:24px;display:flex;position:fixed;inset:0;overflow:auto}.MN7oQq_shell{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;max-width:880px;box-shadow:0 24px 64px var(--dsw-alias-bg-mask-2);border-radius:16px;grid-template-columns:1.05fr 1fr;display:grid;overflow:hidden}.MN7oQq_brand{color:var(--dsw-alias-label-primary-inverted);background:var(--dsw-alias-brand-primary);flex-direction:column;justify-content:space-between;gap:24px;padding:32px;display:flex}.MN7oQq_brandTop{align-items:center;gap:10px;display:flex}.MN7oQq_mark{color:currentColor;flex:none;width:28px;height:28px}.MN7oQq_brandName{letter-spacing:.2px;font-size:16px;font-weight:600}.MN7oQq_brandBody{flex-direction:column;gap:10px;display:flex}.MN7oQq_slogan{margin:0;font-size:24px;font-weight:600;line-height:1.35}.MN7oQq_sub{opacity:.86;margin:0;font-size:13px}.MN7oQq_points{opacity:.92;flex-direction:column;gap:6px;margin:6px 0 0;padding-left:18px;font-size:12.5px;display:flex}.MN7oQq_brandFoot{opacity:.72;margin:0;font-size:11.5px}.MN7oQq_formPane{box-sizing:border-box;flex-direction:column;gap:14px;padding:36px 32px;display:flex}.MN7oQq_formTitle{margin:0;font-size:20px}.MN7oQq_formHint{color:var(--dsw-alias-label-secondary);margin:0;font-size:12.5px}.MN7oQq_form{flex-direction:column;gap:14px;margin-top:4px;display:flex}.MN7oQq_field{color:var(--dsw-alias-label-secondary);flex-direction:column;gap:6px;font-size:12.5px;display:flex}.MN7oQq_error{color:var(--dsw-alias-state-error-primary);word-break:break-word;margin:0;font-size:12.5px}.MN7oQq_divider{color:var(--dsw-alias-label-tertiary);align-items:center;gap:10px;font-size:11.5px;display:flex}.MN7oQq_divider:before,.MN7oQq_divider:after{content:\"\";background:var(--dsw-alias-border-l2);flex:1;height:1px}.MN7oQq_localRow{flex-direction:column;gap:8px;display:flex}.MN7oQq_localHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11.5px;line-height:1.55}.MN7oQq_muted{color:var(--dsw-alias-label-tertiary);font-size:11.5px}.MN7oQq_userLine{color:var(--dsw-alias-label-primary);font-size:12.5px}.MN7oQq_bindings{flex-direction:column;gap:10px;display:flex}.MN7oQq_bindingList{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}.MN7oQq_bindingRow{word-break:break-all;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px;display:flex}.MN7oQq_errorText{color:var(--dsw-alias-state-error-primary);font-size:12.5px}@media (width<=720px){.MN7oQq_shell{grid-template-columns:1fr;max-width:420px}.MN7oQq_brand{gap:12px;padding:22px 24px}.MN7oQq_slogan{font-size:19px}.MN7oQq_points{display:none}.MN7oQq_formPane{padding:26px 24px}}";
		const tagId$2 = "@fominfo/dsh-client-ui-login/F:\\deepseek\\deepseek harness\\apps\\fom-client\\plugins\\office-login\\src\\client\\LoginPage.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@fominfo/dsh-client-ui-login";
			tag.dataset.fomCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var LoginPage_module_css_default = {
			"bindingList": "MN7oQq_bindingList",
			"bindingRow": "MN7oQq_bindingRow",
			"bindings": "MN7oQq_bindings",
			"brand": "MN7oQq_brand",
			"brandBody": "MN7oQq_brandBody",
			"brandFoot": "MN7oQq_brandFoot",
			"brandName": "MN7oQq_brandName",
			"brandTop": "MN7oQq_brandTop",
			"divider": "MN7oQq_divider",
			"error": "MN7oQq_error",
			"errorText": "MN7oQq_errorText",
			"field": "MN7oQq_field",
			"form": "MN7oQq_form",
			"formHint": "MN7oQq_formHint",
			"formPane": "MN7oQq_formPane",
			"formTitle": "MN7oQq_formTitle",
			"gate": "MN7oQq_gate",
			"localHint": "MN7oQq_localHint",
			"localRow": "MN7oQq_localRow",
			"mark": "MN7oQq_mark",
			"muted": "MN7oQq_muted",
			"points": "MN7oQq_points",
			"shell": "MN7oQq_shell",
			"slogan": "MN7oQq_slogan",
			"sub": "MN7oQq_sub",
			"userLine": "MN7oQq_userLine"
		};
		//#endregion
		//#region src/client/LoginPage.tsx
		/**
		* 登录门禁页（全屏，挂在 `shell.overlay`）。
		*
		* 两条出路：
		* - **登录** ⇒ 走宿主代理 `/api/office/login/session`（令牌不过浏览器），成功后进应用；
		* - **先本地使用** ⇒ 进应用，平台能力不可用（本地能力完整，见设计稿 §1.1）。
		*
		* 视觉：左侧品牌区 + 右侧表单（窄视口堆叠）。样式走 `LoginPage.module.css`，颜色只用
		* `--dsw-alias-*` 令牌，零颜色字面量。
		*/
		/** FomWorker 标记（与侧栏品牌同形；16:16 视图框）。 */
		function Mark() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				className: LoginPage_module_css_default.mark,
				viewBox: "0 0 32 32",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "1",
					y: "1",
					width: "30",
					height: "30",
					rx: "8",
					fill: "currentColor",
					opacity: "0.12"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M10 22V10h3.4l2.6 6.2L18.6 10H22v12h-2.8v-7.4L16.9 21h-1.8l-2.3-6.4V22H10Z",
					fill: "currentColor"
				})]
			});
		}
		/**
		* 登录门禁。
		* @param props.onSignedIn - 登录成功回调（调用方切到 `signed` 态）。
		* @param props.onLocalMode - 选择本地使用（调用方记标记并进应用）。
		* @param props.session - 会话实现（缺省用 localStorage 存身份）。
		* @returns 全屏登录页。
		*/
		function LoginPage({ onSignedIn, onLocalMode, session: injected }) {
			const [session] = (0, react.useState)(() => injected ?? createSession({ store: createLocalStore() }));
			const [email, setEmail] = (0, react.useState)("");
			const [password, setPassword] = (0, react.useState)("");
			const [error, setError] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const canSubmit = email.trim() !== "" && password !== "" && !busy;
			const submit = (0, react.useCallback)(async () => {
				if (!canSubmit) return;
				setBusy(true);
				setError(null);
				try {
					onSignedIn(await session.login({
						method: "email",
						email: email.trim(),
						password
					}));
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setBusy(false);
				}
			}, [
				canSubmit,
				session,
				email,
				password,
				onSignedIn
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: LoginPage_module_css_default.gate,
				role: "dialog",
				"aria-modal": "true",
				"aria-label": "登录 FomWorker",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: LoginPage_module_css_default.shell,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
						className: LoginPage_module_css_default.brand,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: LoginPage_module_css_default.brandTop,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Mark, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: LoginPage_module_css_default.brandName,
									children: "FomWorker"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: LoginPage_module_css_default.brandBody,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
										className: LoginPage_module_css_default.slogan,
										children: "让每个员工都有一位 AI 助手"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: LoginPage_module_css_default.sub,
										children: "企业统一供给，全程可管可查"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
										className: LoginPage_module_css_default.points,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: "本机执行，文件与桌面应用都能用" }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: "会话与待办只存在你自己的电脑上" }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: "登录后解锁派活、审批托管与手机接力" })
										]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: LoginPage_module_css_default.brandFoot,
								children: "企业 AI 中台 · 员工助手"
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: LoginPage_module_css_default.formPane,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: LoginPage_module_css_default.formTitle,
								children: "登录"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: LoginPage_module_css_default.formHint,
								children: "用企业邮箱登录，解锁云端协同能力。"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
								className: LoginPage_module_css_default.form,
								onSubmit: (event) => {
									event.preventDefault();
									submit();
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: LoginPage_module_css_default.field,
										children: ["邮箱", /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
											value: email,
											onChange: (e) => setEmail(e.target.value),
											placeholder: "you@company.com",
											autoComplete: "username",
											disabled: busy,
											autoFocus: true
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: LoginPage_module_css_default.field,
										children: ["密码", /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
											type: "password",
											value: password,
											onChange: (e) => setPassword(e.target.value),
											autoComplete: "current-password",
											disabled: busy
										})]
									}),
									error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: LoginPage_module_css_default.error,
										role: "alert",
										children: error
									}) : null,
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										type: "submit",
										disabled: !canSubmit,
										children: busy ? "登录中…" : "登录"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: LoginPage_module_css_default.divider,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "或者" })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: LoginPage_module_css_default.localRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									onClick: onLocalMode,
									disabled: busy,
									children: "先本地使用"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: LoginPage_module_css_default.localHint,
									children: "不登录也能用：AI 对话、文件、技能、待办都在本机。派活、审批托管、手机接力需要登录。"
								})]
							})
						]
					})]
				})
			});
		}
		//#endregion
		//#region \0fom-css:F:\deepseek\deepseek harness\apps\fom-client\plugins\office-login\src\client\AccountRow.module.css.mjs
		const css$1 = ".otXzNG_row{box-sizing:border-box;width:100%;min-width:0;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:8px;align-items:center;gap:8px;padding:4px 6px;display:flex}.otXzNG_row:hover{background:var(--dsw-alias-bg-layer-2)}.otXzNG_identity{min-width:0;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;flex:1;align-items:center;gap:8px;padding:0;display:flex}.otXzNG_avatar{background:var(--dsw-alias-brand-primary);width:24px;height:24px;color:var(--dsw-alias-label-primary-inverted);user-select:none;border-radius:999px;flex:none;justify-content:center;align-items:center;font-size:11.5px;font-weight:600;line-height:1;display:flex}.otXzNG_avatarLocal{border:1px dashed var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);background:0 0;font-weight:500}.otXzNG_text{flex-direction:column;min-width:0;line-height:1.35;display:flex}.otXzNG_name{text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:500;overflow:hidden}.otXzNG_sub{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:11px;overflow:hidden}";
		const tagId$1 = "@fominfo/dsh-client-ui-login/F:\\deepseek\\deepseek harness\\apps\\fom-client\\plugins\\office-login\\src\\client\\AccountRow.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@fominfo/dsh-client-ui-login";
			tag.dataset.fomCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var AccountRow_module_css_default = {
			"avatar": "otXzNG_avatar",
			"avatarLocal": "otXzNG_avatarLocal",
			"identity": "otXzNG_identity",
			"name": "otXzNG_name",
			"row": "otXzNG_row",
			"sub": "otXzNG_sub",
			"text": "otXzNG_text"
		};
		//#endregion
		//#region src/client/AccountRow.tsx
		/**
		* 底栏账号行（`sidebar.footer.action`，设置之上）。
		*
		* 三态显示（设计稿 §3.4）：
		* - `signed`：头像 + 显示名 + 角色；点开账号 overlay；
		* - `local`：虚线头像 + 「本地模式」+ 「未登录」；点击回登录门禁；
		* - `gate`：不渲染（门禁已盖住全屏）。
		*
		* 折叠侧栏（`wide === false`）只显示头像。
		*/
		/**
		* 账号行。
		* @param props.mode - 当前态
		* @param props.user - 身份（`signed` 时有值）
		* @param props.wide - 侧栏宽态（缺省 true）
		* @returns 一行账号信息
		*/
		function AccountRow({ mode, user, wide = true, onOpenAccount, onSignIn, onSignOut }) {
			if (mode === "gate") return null;
			if (mode === "local" || user === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: AccountRow_module_css_default.row,
				onClick: onSignIn,
				title: "本地模式 · 点此登录",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: `${AccountRow_module_css_default.avatar} ${AccountRow_module_css_default.avatarLocal}`,
					"aria-hidden": "true",
					children: "L"
				}), wide ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: AccountRow_module_css_default.text,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: AccountRow_module_css_default.name,
						children: "本地模式"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: AccountRow_module_css_default.sub,
						children: "未登录 · 点此登录"
					})]
				}) : null]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: AccountRow_module_css_default.row,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: AccountRow_module_css_default.identity,
					onClick: onOpenAccount,
					title: "账号与 IM 绑定",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: AccountRow_module_css_default.avatar,
						"aria-hidden": "true",
						children: avatarInitialOf(user)
					}), wide ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: AccountRow_module_css_default.text,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: AccountRow_module_css_default.name,
							children: displayNameOf(user)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: AccountRow_module_css_default.sub,
							children: user.role ?? "成员"
						})]
					}) : null]
				}), wide ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "ghost",
					size: "sm",
					onClick: onSignOut,
					title: "退出登录",
					children: "退出"
				}) : null]
			});
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
		//#region \0fom-css:F:\deepseek\deepseek harness\apps\fom-client\plugins\office-login\src\client\AccountOverlay.module.css.mjs
		const css = ".F_KR0W_mask{z-index:100;box-sizing:border-box;background:var(--dsw-alias-bg-mask-1);isolation:isolate;grid-area:1/1/-1/-1;justify-content:center;align-items:center;padding:24px;display:flex;position:fixed;inset:0}.F_KR0W_panel{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;max-width:480px;max-height:80vh;box-shadow:0 18px 48px var(--dsw-alias-bg-mask-2);border-radius:14px;flex-direction:column;gap:16px;padding:20px 22px;display:flex;overflow:auto}.F_KR0W_head{align-items:center;gap:10px;display:flex}.F_KR0W_avatar{background:var(--dsw-alias-brand-primary);width:36px;height:36px;color:var(--dsw-alias-label-primary-inverted);user-select:none;border-radius:999px;flex:none;justify-content:center;align-items:center;font-size:15px;font-weight:600;display:flex}.F_KR0W_identity{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}.F_KR0W_name{text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600;overflow:hidden}.F_KR0W_meta{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;overflow:hidden}.F_KR0W_section{border-top:1px solid var(--dsw-alias-border-l2);padding-top:14px}.F_KR0W_foot{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;padding-top:14px;display:flex}";
		const tagId = "@fominfo/dsh-client-ui-login/F:\\deepseek\\deepseek harness\\apps\\fom-client\\plugins\\office-login\\src\\client\\AccountOverlay.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-fom-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.fomPlugin = "@fominfo/dsh-client-ui-login";
			tag.dataset.fomCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var AccountOverlay_module_css_default = {
			"avatar": "F_KR0W_avatar",
			"foot": "F_KR0W_foot",
			"head": "F_KR0W_head",
			"identity": "F_KR0W_identity",
			"mask": "F_KR0W_mask",
			"meta": "F_KR0W_meta",
			"name": "F_KR0W_name",
			"panel": "F_KR0W_panel",
			"section": "F_KR0W_section"
		};
		//#endregion
		//#region src/client/AccountOverlay.tsx
		/**
		* 账号 overlay（`shell.overlay`）：身份 + IM 绑定 + 退出登录。
		*
		* 为什么自建而不是复用内核设置面板（设计稿 §3.3 已核实）：`openSettings` 只作为 owner props
		* 传给 `settings.launcher` 槽位的组件，**不是可注入的服务**；且该槽位是 `single`、已被内核
		* `ui-settings-account` 占用 ⇒ 我们无法接管，只能自建。
		*/
		/**
		* 账号面板。
		* @param props.user - 当前身份
		* @param props.onClose - 关闭
		* @param props.onSignOut - 退出登录
		* @returns 居中卡片 + 遮罩
		*/
		function AccountOverlay({ user, onClose, onSignOut }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: AccountOverlay_module_css_default.mask,
				role: "dialog",
				"aria-modal": "true",
				"aria-label": "账号",
				onClick: (event) => {
					if (event.target === event.currentTarget) onClose();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: AccountOverlay_module_css_default.panel,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
							className: AccountOverlay_module_css_default.head,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: AccountOverlay_module_css_default.avatar,
									"aria-hidden": "true",
									children: avatarInitialOf(user)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: AccountOverlay_module_css_default.identity,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: AccountOverlay_module_css_default.name,
										children: displayNameOf(user)
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: AccountOverlay_module_css_default.meta,
										children: [
											user.email,
											user.role,
											user.tenantId
										].filter((part) => part !== void 0 && part !== "").join(" · ")
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "ghost",
									size: "sm",
									onClick: onClose,
									children: "关闭"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
							className: AccountOverlay_module_css_default.section,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ImBindings, { active: true })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("footer", {
							className: AccountOverlay_module_css_default.foot,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								onClick: onSignOut,
								children: "退出登录"
							})
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* `office-login` 的浏览器半：**登录门禁**（`shell.overlay`）+ **底栏账号行**（`sidebar.footer.action`）。
		*
		* 为什么是门禁而不是内容页（设计稿 §0）：登录是**进入应用的前置**，不是应用里的一个页面 ⇒
		* 用 root 级 `shell.overlay` 盖住整个框架；同时允许**先本地使用**（本地能力完整），标记
		* 持久化到 `fomworker.mode`。
		*
		* 两个槽位看**同一份状态**：经注册 `inject` 的 `hooks` 约定暴露裸可观察源，渲染器绑成
		* `useLogin(selector)` 交给组件（`docs/subsystems/slots.md` §Developer-provided injection）。
		*/
		/** 必需服务：UI 槽位注册表。 */
		const inject = ["slots"];
		/**
		* 门禁组件（`shell.overlay`）：只在 `gate` 态渲染。
		*
		* **为什么要 portal 到 `document.body`**：`shell.overlay` 渲染在 `.frame`（`display:grid` +
		* `overflow:hidden`）内部，是网格子项且受 frame 层叠上下文约束 ⇒ 仅靠 `position:fixed`
		* 仍会让侧栏压在门禁之上（2026-10-19 实测截图）。挂到 body 后不受任何祖先布局影响。
		*
		* @param props.useLogin - 状态选择器
		* @param props.onSignedIn - 登录成功
		* @param props.onLocalMode - 选「先本地使用」
		* @returns 全屏登录页（portal），或 null
		*/
		function LoginGate({ useLogin, onSignedIn, onLocalMode }) {
			if (!shouldGate(useLogin((snapshot) => snapshot.mode))) return null;
			return (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoginPage, {
				onSignedIn,
				onLocalMode
			}), document.body);
		}
		/**
		* 底栏账号行（`sidebar.footer.action`）。
		* @param props.useLogin - 状态选择器
		* @param props.wide - 侧栏宽态
		* @param props.onSignIn - 本地模式回登录
		* @param props.onSignOut - 退出登录
		* @param props.onOpenAccount - 打开账号 overlay
		* @returns 账号行
		*/
		function AccountSlot({ useLogin, wide, onSignIn, onSignOut, onOpenAccount }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountRow, {
				mode: useLogin((snapshot) => snapshot.mode),
				user: useLogin((snapshot) => snapshot.user),
				...wide === void 0 ? {} : { wide },
				onSignIn,
				onSignOut,
				onOpenAccount
			});
		}
		/**
		* 账号 overlay 宿主（`shell.overlay`）：开合是**本组件局部状态**（不属于跨槽位共享事实）。
		* @param props.useLogin - 状态选择器
		* @param props.onSignOut - 退出登录
		* @returns 打开时渲染账号面板，否则 null
		*/
		function AccountHost({ useLogin, onSignOut }) {
			const [open, setOpen] = (0, react.useState)(false);
			const mode = useLogin((snapshot) => snapshot.mode);
			const user = useLogin((snapshot) => snapshot.user);
			useAccountOpenEvent(setOpen);
			if (!open || mode !== "signed" || user === null) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountOverlay, {
				user,
				onClose: () => setOpen(false),
				onSignOut: () => {
					setOpen(false);
					onSignOut();
				}
			});
		}
		/**
		* 账号 overlay 的开合事件名（账号行 → overlay 宿主）。
		*/
		const ACCOUNT_OPEN_EVENT = "fomworker:account-open";
		/**
		* 订阅「打开账号」事件（挂载时注册、卸载时摘除）。
		* @param setOpen 开合设置器
		*/
		function useAccountOpenEvent(setOpen) {
			(0, react.useEffect)(() => {
				const onOpen = () => setOpen(true);
				window.addEventListener(ACCOUNT_OPEN_EVENT, onOpen);
				return () => window.removeEventListener(ACCOUNT_OPEN_EVENT, onOpen);
			}, [setOpen]);
		}
		/**
		* 挂门禁、账号行与账号 overlay。
		* @param ctx - 客户端根上下文。
		*/
		function apply(ctx) {
			const login = createLoginState();
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "office-login-gate",
				inject: () => ({
					hooks: { login: login.source },
					onSignedIn: () => {
						login.signedIn();
					},
					onLocalMode: () => {
						login.useLocal();
					}
				})
			}, LoginGate));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "office-login-account",
				inject: () => ({
					hooks: { login: login.source },
					onSignOut: () => {
						login.signOut();
					}
				})
			}, AccountHost));
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "office-login-account-row",
				inject: () => ({
					hooks: { login: login.source },
					onSignIn: () => {
						login.requireSignIn();
					},
					onSignOut: () => {
						login.signOut();
					},
					onOpenAccount: () => {
						window.dispatchEvent(new CustomEvent(ACCOUNT_OPEN_EVENT));
					}
				})
			}, AccountSlot));
		}
		//#endregion
		exports.ACCOUNT_OPEN_EVENT = ACCOUNT_OPEN_EVENT;
		exports.AccountHost = AccountHost;
		exports.AccountSlot = AccountSlot;
		exports.LoginGate = LoginGate;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
