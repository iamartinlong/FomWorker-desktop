import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
//#region session.ts
/** base64url 段 → UTF-8 字符串（浏览器/Node 均可用 `atob` + `TextDecoder`）。 */
function b64urlToText(segment) {
	const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
	const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}
/** 解 JWT 载荷（不验签；仅取展示用身份）。 */
function decodeJwtPayload(token) {
	const parts = token.split(".");
	if (parts.length < 2) return null;
	try {
		return JSON.parse(b64urlToText(parts[1]));
	} catch {
		return null;
	}
}
/**
* 从访问令牌解出用户（平台 `/auth/login` 只回 `TokenPair`，身份在 JWT 里：
* `sub` / `tenant_id` / `email` / `role`）。解不出返回 null。**宿主半**用它把 `user` 回给前端。
* @param accessToken - 访问令牌（JWT）。
* @returns `UserInfo` 或 null。
*/
function userFromToken(accessToken) {
	const payload = decodeJwtPayload(accessToken);
	if (payload === null) return null;
	const userId = typeof payload.sub === "string" ? payload.sub : "";
	const tenantId = typeof payload.tenant_id === "string" ? payload.tenant_id : "";
	if (userId === "" && tenantId === "") return null;
	return {
		userId,
		tenantId,
		...typeof payload.email === "string" ? { email: payload.email } : {},
		...typeof payload.role === "string" ? { role: payload.role } : {}
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
/** 按渠道查展示口径；未知渠道回退到原值。 */
function channelInfo(channel) {
	return IM_CHANNELS.find((info) => info.channel === channel);
}
/** 平台返回的数组 → 展示行（缺 `channelLabel`/`idKind` 时按渠道表补齐）。 */
function bindingViews(payload) {
	if (!Array.isArray(payload)) return [];
	const rows = [];
	for (const item of payload) {
		if (item === null || typeof item !== "object") continue;
		const row = item;
		const channel = typeof row.channel === "string" ? row.channel : "";
		const info = channelInfo(channel);
		if (typeof row.id !== "string" || typeof row.openId !== "string") continue;
		rows.push({
			id: row.id,
			channel,
			channelLabel: typeof row.channelLabel === "string" ? row.channelLabel : info?.label ?? channel,
			idKind: typeof row.idKind === "string" ? row.idKind : info?.idKind ?? "id",
			openId: row.openId
		});
	}
	return rows;
}
function json$1(body, status) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" }
	});
}
/**
* 造 IM 绑定路由的处理函数（与接线拆开，便于单测）。
* - `GET` ⇒ `{ ok, bindings }`（平台 `/config/im-bindings`）
* - `POST { channel, openId }` ⇒ `{ ok, binding?/message }`（渠道/标识先本地校验）
* - `DELETE ?id=` ⇒ `{ ok, status }`
* @param deps - 平台地址 / 凭据 / fetch。
* @returns Fetch 处理函数。
*/
function createImBindingsFetch(deps) {
	const doFetch = deps.fetchImpl ?? fetch;
	const token = async () => {
		return (await deps.credentials.resolve?.("FOM_PLATFORM_TOKEN"))?.value ?? "";
	};
	return async (request) => {
		const accessToken = await token();
		if (accessToken === "") return json$1({
			ok: false,
			message: "未登录（先在账号面板登录）"
		}, 401);
		const auth = { authorization: `Bearer ${accessToken}` };
		const method = request.method.toUpperCase();
		if (method === "GET") {
			let res;
			try {
				res = await doFetch(`${deps.platformUrl}/api/config/im-bindings`, { headers: auth });
			} catch (error) {
				return json$1({
					ok: false,
					message: `连不上平台（${deps.platformUrl}）：${String(error?.message ?? error)}`
				}, 200);
			}
			if (!res.ok) return json$1({
				ok: false,
				status: res.status,
				message: await res.text().catch(() => "")
			}, 200);
			return json$1({
				ok: true,
				bindings: bindingViews(await res.json().catch(() => []))
			}, 200);
		}
		if (method === "POST") {
			let body;
			try {
				body = await request.json();
			} catch {
				return json$1({
					ok: false,
					message: "请求体不是 JSON"
				}, 400);
			}
			const channel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
			const openId = typeof body.openId === "string" ? body.openId.trim() : "";
			if (channelInfo(channel) === void 0) return json$1({
				ok: false,
				message: "渠道必须是飞书 / 钉钉 / 企业微信"
			}, 400);
			if (openId === "") return json$1({
				ok: false,
				message: "请填入 IM 用户标识"
			}, 400);
			let res;
			try {
				res = await doFetch(`${deps.platformUrl}/api/config/im-bindings`, {
					method: "POST",
					headers: {
						...auth,
						"content-type": "application/json"
					},
					body: JSON.stringify({
						channel,
						openId
					})
				});
			} catch (error) {
				return json$1({
					ok: false,
					message: `连不上平台（${deps.platformUrl}）：${String(error?.message ?? error)}`
				}, 200);
			}
			if (!res.ok) return json$1({
				ok: false,
				status: res.status,
				message: await res.text().catch(() => "")
			}, 200);
			return json$1({
				ok: true,
				binding: bindingViews([await res.json().catch(() => null)])[0] ?? null
			}, 200);
		}
		if (method === "DELETE") {
			const id = new URL(request.url).searchParams.get("id") ?? "";
			if (id === "") return json$1({
				ok: false,
				message: "缺少 id"
			}, 400);
			let res;
			try {
				res = await doFetch(`${deps.platformUrl}/api/config/im-bindings/${encodeURIComponent(id)}`, {
					method: "DELETE",
					headers: auth
				});
			} catch (error) {
				return json$1({
					ok: false,
					message: `连不上平台（${deps.platformUrl}）：${String(error?.message ?? error)}`
				}, 200);
			}
			if (!res.ok) return json$1({
				ok: false,
				status: res.status,
				message: await res.text().catch(() => "")
			}, 200);
			return json$1({
				ok: true,
				status: res.status
			}, 200);
		}
		return json$1({
			ok: false,
			message: `不支持的请求方法 ${method}`
		}, 405);
	};
}
//#endregion
//#region src/token.ts
/** JWT 的 `exp`（**秒**）；解不出（非 JWT / 无 payload）给 `undefined`。 */
function expiryOf(token) {
	const parts = token.split(".");
	if (parts.length < 2) return void 0;
	try {
		const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
		return typeof payload.exp === "number" ? payload.exp : void 0;
	} catch {
		return;
	}
}
/** 距到期还有多少秒；解不出 `exp` 给 `undefined`（调用方按「不知道 ⇒ 不刷」处理）。 */
function secondsLeft(token, nowSeconds) {
	const exp = expiryOf(token);
	return exp === void 0 ? void 0 : exp - nowSeconds;
}
const read = async (deps, ref) => {
	return (await deps.credentials.resolve?.(ref))?.value ?? "";
};
/**
* 造续期器。
* @param deps 平台地址 / 凭据 / 时钟与 fetch 注入
* @returns 续期器
*/
function createTokenRefresher(deps) {
	const threshold = deps.thresholdSeconds ?? 120;
	const doFetch = deps.fetchImpl ?? fetch;
	const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1e3));
	const report = deps.report ?? (() => {});
	const ensureFresh = async () => {
		const accessToken = await read(deps, deps.accessRef);
		if (accessToken === "") return {
			usable: false,
			refreshed: false,
			needsLogin: true
		};
		const left = secondsLeft(accessToken, now());
		if (left === void 0) return {
			usable: true,
			refreshed: false,
			needsLogin: false
		};
		if (left >= threshold) return {
			usable: true,
			refreshed: false,
			needsLogin: false
		};
		const refreshToken = await read(deps, deps.refreshRef);
		if (refreshToken === "") {
			report("访问令牌快过期，但凭据里没有刷新令牌 ⇒ 需要重新登录");
			return {
				usable: left > 0,
				refreshed: false,
				needsLogin: true
			};
		}
		let response;
		try {
			response = await doFetch(`${deps.platformUrl}/api/auth/token`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ refreshToken })
			});
		} catch (error) {
			report(`刷新令牌时连不上平台（保留旧令牌，稍后重试）：${String(error?.message ?? error)}`);
			return {
				usable: left > 0,
				refreshed: false,
				needsLogin: false
			};
		}
		if (response.status === 401 || response.status === 403) {
			await deps.credentials.unset?.(deps.accessRef);
			await deps.credentials.unset?.(deps.refreshRef);
			report(`刷新令牌被拒（${response.status}）⇒ 已清除本地令牌，需要重新登录`);
			return {
				usable: false,
				refreshed: false,
				needsLogin: true
			};
		}
		if (!response.ok) {
			report(`刷新令牌失败（HTTP ${response.status}），保留旧令牌稍后重试`);
			return {
				usable: left > 0,
				refreshed: false,
				needsLogin: false
			};
		}
		let pair;
		try {
			pair = await response.json();
		} catch {
			return {
				usable: left > 0,
				refreshed: false,
				needsLogin: false
			};
		}
		if (typeof pair.accessToken !== "string" || pair.accessToken === "") {
			report("刷新接口没回 accessToken，保留旧令牌");
			return {
				usable: left > 0,
				refreshed: false,
				needsLogin: false
			};
		}
		await deps.credentials.set(deps.accessRef, pair.accessToken);
		if (typeof pair.refreshToken === "string" && pair.refreshToken !== "") await deps.credentials.set(deps.refreshRef, pair.refreshToken);
		report("平台令牌已自动续期");
		return {
			usable: true,
			refreshed: true,
			needsLogin: false
		};
	};
	return {
		ensureFresh,
		start(everyMs) {
			const timer = setInterval(() => {
				ensureFresh().catch((error) => {
					report(`续期定时器出错（忽略，下次再试）：${String(error?.message ?? error)}`);
				});
			}, everyMs);
			if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref?.();
			return () => clearInterval(timer);
		}
	};
}
//#endregion
//#region src/login-mode.ts
/**
* 「本地模式」标记的**宿主侧落点**。
*
* 为什么需要它：模式选择发生在浏览器（`localStorage['fomworker.mode']`），但**宿主插件
* 看不见 localStorage**。而平台相关插件（`office-channel` 等）需要在启动时判断「用户明确
* 选了不连平台」以避免每 5s 一次的无谓重试与日志噪音（2026-10-19 本地模式实测）。
*
* 通道：浏览器把选择经认证路由 `POST /api/office/login/mode` 写到这里，落一个标记文件
* `$DSH_HOME/office/login-mode.json`（`{ mode: 'local' | 'signed' | 'gate' }`）。
* 宿主插件读同一个文件即可，**不需要跨插件服务依赖**。
*
* 失败一律**保守**：读不到 / 解析不了 ⇒ 当作「非本地模式」（保持原来 `loginRetryMs` 快重试）。
*/
/** 标记文件名。 */
const FILE_NAME = "login-mode.json";
/**
* 标记文件路径（`$DSH_HOME/office/login-mode.json`）。
* @returns 绝对路径
*/
function modeFilePath() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "office", FILE_NAME);
}
/**
* 写入模式标记（原子性不做额外处理：单行小文件，最坏是读到半行 ⇒ 按保守值处理）。
* @param mode 模式
* @param path 可注入路径（单测）
*/
function writeHostMode(mode, path = modeFilePath()) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ mode })}\n`, "utf8");
}
/**
* 读模式标记；读不到 / 坏文件 ⇒ `undefined`（调用方按「非本地模式」处理）。
* @param path 可注入路径（单测）
* @returns 模式，或 `undefined`
*/
function readHostMode(path = modeFilePath()) {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		return parsed.mode === "local" || parsed.mode === "signed" || parsed.mode === "gate" ? parsed.mode : void 0;
	} catch {
		return;
	}
}
//#endregion
//#region src/index.ts
/**
* `office-login` 的 node half（K1 + K2）。
*
* **K1（登录代理）**：浏览器**不直连平台**（平台不开 CORS，见 `交接文档` §7）⇒ 宿主在服务端调
* 平台 `/api/auth/login`，拿到令牌后写**宿主凭据库** `ctx.credentials`（ref `FOM_PLATFORM_TOKEN`），
* **只把 `user` 回给前端**（令牌不过浏览器）。
* **K2**：写 `llm-pi-ai.providers.<id>` = `{ baseURL: <网关>, apiKeyEnv: FOM_PLATFORM_TOKEN }`——客户端即可用平台模型（经网关）。
*
* 通道：认证的共享 `/api` Fetch 路由（`connection.fetch.register`）。只依赖最小 ctx 面。
*/
/** 平台令牌的凭据 ref（模型网关 `apiKeyEnv` 引用同一名）。 */
const PLATFORM_TOKEN_REF = "FOM_PLATFORM_TOKEN";
/** 刷新令牌的凭据 ref（14 天有效；续期器用）。 */
const PLATFORM_REFRESH_REF = "FOM_PLATFORM_REFRESH";
/** 平台网关 provider 的 settings 路由名（`llm-pi-ai.providers.<id>`）。 */
const DEFAULT_PROVIDER_ID = "fom-platform";
/** 平台 API 默认基址（本机 dev；正式由部署/下发配置）。 */
const DEFAULT_PLATFORM_URL = "http://localhost:5028";
/** 登录路由路径（认证的 `/api` 通道）。 */
const SESSION_ROUTE = "/api/office/login/session";
/** 模式标记路由（浏览器 → 宿主；宿主落盘供 `office-channel` 等插件读取）。 */
const MODE_ROUTE = "/api/office/login/mode";
/** 登出路由（清宿主凭据库里的令牌；浏览器侧身份由前端自己清）。 */
const LOGOUT_ROUTE = "/api/office/login/session";
/** 插件名。 */
const name = "office-login";
/** 需要凭据 + 设置服务。 */
const inject = ["credentials", "settings"];
function json(body, status) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" }
	});
}
/**
* 造登录路由的处理函数（与接线拆开，便于单测）。
* `POST { method, email, password }` → 服务端调平台 `/api/auth/login` → 令牌写凭据 + 写 provider → 回 `{ ok, user }`。
* @param deps - 平台地址 / provider / 凭据 / 设置 / fetch。
* @returns Fetch 处理函数。
*/
function createLoginFetch(deps) {
	const doFetch = deps.fetchImpl ?? fetch;
	return async (request) => {
		let login;
		try {
			login = await request.json();
		} catch {
			return json({
				ok: false,
				message: "请求体不是 JSON"
			}, 400);
		}
		let res;
		try {
			res = await doFetch(`${deps.platformUrl}/api/auth/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(login)
			});
		} catch (error) {
			return json({
				ok: false,
				message: `连不上平台（${deps.platformUrl}）：${String(error?.message ?? error)}`
			}, 200);
		}
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			return json({
				ok: false,
				status: res.status,
				message: text
			}, 200);
		}
		const pair = await res.json();
		if (typeof pair.accessToken !== "string" || pair.accessToken === "") return json({
			ok: false,
			message: "平台未返回 accessToken"
		}, 200);
		await deps.credentials.set(PLATFORM_TOKEN_REF, pair.accessToken);
		if (typeof pair.refreshToken === "string" && pair.refreshToken !== "") await deps.credentials.set(PLATFORM_REFRESH_REF, pair.refreshToken);
		const user = userFromToken(pair.accessToken);
		let providerWritten = false;
		let providerError = null;
		if (deps.provider !== void 0) if (deps.settings === void 0) providerError = "settings-unavailable";
		else try {
			await deps.settings.update("llm-pi-ai", { providers: { [deps.providerId]: deps.provider } });
			providerWritten = true;
		} catch (e) {
			providerError = String(e?.message ?? e);
		}
		return json({
			ok: true,
			user,
			provider: providerWritten ? deps.providerId : null,
			providerError
		}, 200);
	};
}
/**
* 挂登录路由：宿主在服务端调平台、写凭据（令牌不过浏览器）；若配了 `provider`，同时写 `llm-pi-ai` provider。
* @param ctx - 插件上下文（最小面）。
* @param config - `platformUrl` / `providerId` / `provider`。
*/
function apply(ctx, config = {}) {
	const providerId = config.providerId ?? "fom-platform";
	const platformUrl = (config.platformUrl ?? "http://localhost:5028").replace(/\/+$/u, "");
	ctx.effect(() => {
		const creds = ctx.credentials ?? ctx.get("credentials");
		if (creds === void 0) return () => {};
		const stop = createTokenRefresher({
			platformUrl,
			credentials: creds,
			accessRef: PLATFORM_TOKEN_REF,
			refreshRef: PLATFORM_REFRESH_REF,
			report: (message) => process.stderr.write(`[office-login] ${(/* @__PURE__ */ new Date()).toISOString()} ${message}\n`)
		}).start(3e4);
		return () => {
			stop();
		};
	}, "office-login: 平台令牌自动续期（15 分钟有效期）");
	ctx.inject(["connection"], (connCtx) => {
		connCtx.effect(() => {
			const conn = connCtx.get("connection");
			if (conn === void 0) return () => {};
			const dispose = conn.fetch.register({
				path: SESSION_ROUTE,
				methods: ["POST", "DELETE"],
				requestBody: "buffered",
				fetch: (request) => {
					const creds = connCtx.credentials ?? connCtx.get("credentials");
					if (creds === void 0) return Promise.resolve(json({
						ok: false,
						message: "凭据服务不可用（credentials）"
					}, 500));
					if (request.method.toUpperCase() === "DELETE") return (async () => {
						try {
							await creds.unset?.(PLATFORM_TOKEN_REF);
							await creds.unset?.(PLATFORM_REFRESH_REF);
							return json({ ok: true }, 200);
						} catch (error) {
							return json({
								ok: false,
								message: String(error?.message ?? error)
							}, 500);
						}
					})();
					return createLoginFetch({
						platformUrl,
						providerId,
						credentials: creds,
						...config.provider === void 0 ? {} : { provider: config.provider },
						...connCtx.get("settings") === void 0 ? {} : { settings: connCtx.get("settings") }
					})(request);
				}
			});
			const disposeBindings = conn.fetch.register({
				path: IM_BINDINGS_ROUTE,
				methods: [
					"GET",
					"POST",
					"DELETE"
				],
				requestBody: "buffered",
				fetch: (request) => {
					const creds = connCtx.credentials ?? connCtx.get("credentials");
					if (creds === void 0) return Promise.resolve(json({
						ok: false,
						message: "凭据服务不可用（credentials）"
					}, 500));
					return createImBindingsFetch({
						platformUrl,
						credentials: creds
					})(request);
				}
			});
			const disposeMode = conn.fetch.register({
				path: MODE_ROUTE,
				methods: ["GET", "POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					if (request.method.toUpperCase() === "GET") return json({
						ok: true,
						mode: readHostMode() ?? null
					}, 200);
					let body;
					try {
						body = await request.json();
					} catch {
						return json({
							ok: false,
							message: "请求体不是 JSON"
						}, 400);
					}
					const mode = body.mode;
					if (mode !== "gate" && mode !== "local" && mode !== "signed") return json({
						ok: false,
						message: "mode 只能是 gate / local / signed"
					}, 400);
					try {
						writeHostMode(mode);
						return json({
							ok: true,
							mode
						}, 200);
					} catch (error) {
						return json({
							ok: false,
							message: String(error?.message ?? error)
						}, 500);
					}
				}
			});
			return () => {
				dispose();
				disposeBindings();
				disposeMode();
			};
		}, "office-login: 登录（宿主代理平台）+ 令牌 + 平台 provider 写路由 + IM 绑定代理 + 模式标记");
	});
}
var src_default = {
	name,
	inject,
	apply
};
//#endregion
export { DEFAULT_PLATFORM_URL, DEFAULT_PROVIDER_ID, LOGOUT_ROUTE, MODE_ROUTE, PLATFORM_REFRESH_REF, PLATFORM_TOKEN_REF, SESSION_ROUTE, apply, createLoginFetch, src_default as default, inject, name };
