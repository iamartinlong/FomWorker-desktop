window.__ModuleLoader__.load({
	id: "@fominfo/dsh-client-ui-brand-fomworker",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/mark.ts
		/**
		* FomWorker 品牌标记的**几何与色值**（纯数据，无 React）。
		* 据 `fom-logo.png` 手绘的 SVG 近似；`Brand.tsx` 消费它渲染。⚠️ 待矢量源替换。
		*/
		/** 品牌色（见 `packages/fom-brand/tokens.css`）。 */
		const BRAND_BLUE = "#038AC6";
		const BRAND_AMBER = "#FCB513";
		const BRAND_INK = "#4E4B47";
		/** 标记的 viewBox。 */
		const MARK_VIEWBOX = "0 0 64 64";
		/** 蓝色「C/立方」。 */
		const MARK_BLUE = "M20 20 L36 8 L56 19 L56 33 L38 22 L30 27 L30 52 L16 44 L16 22 Z";
		/** 琥珀上右箭头。 */
		const MARK_ARROW = "M30 16 L40 10 L50 16 L46 19 L40 15.5 L34 19 Z";
		/** 琥珀竖条（带尖底）。 */
		const MARK_BAR = "M42 22 L55 30 L55 50 L48.5 54 L42 50 Z";
		//#endregion
		//#region src/client/Brand.ts
		/**
		* FomWorker 品牌标记（据 `fom-logo.png` 手绘的 SVG 近似）。
		* 组成：蓝色「C/立方」+ 琥珀上右箭头 + 琥珀竖条。⚠️ 近似版；拿到矢量源后应替换。
		*/
		function mark(size, className) {
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: MARK_VIEWBOX,
				className,
				"aria-hidden": "true"
			}, (0, react.createElement)("path", {
				key: "blue",
				d: MARK_BLUE,
				fill: BRAND_BLUE
			}), (0, react.createElement)("path", {
				key: "arrow",
				d: MARK_ARROW,
				fill: BRAND_AMBER
			}), (0, react.createElement)("path", {
				key: "bar",
				d: MARK_BAR,
				fill: BRAND_AMBER
			}));
		}
		/**
		* 侧栏 logo（占 `sidebar.brand.mark`）。
		* @param props.size - 请求的方形边长（px）。
		*/
		function FomMark({ size }) {
			return mark(size);
		}
		/** 侧栏名称（占 `sidebar.brand.name`）。品牌墨色文字，非产品文案。 */
		function FomName() {
			return (0, react.createElement)("span", { style: {
				fontWeight: 700,
				letterSpacing: "0.01em",
				color: BRAND_INK,
				fontSize: 15
			} }, "FomWorker");
		}
		/**
		* 聊天页 hero 标志（占 `conversation.hero.brand.mark`）。阶段1 静态。
		* @param props.size - 请求的方形边长（px）。
		* @param props.className - 宿主类（保留周边几何）。
		*/
		function FomHeroMark({ size, className }) {
			return mark(size, className);
		}
		//#endregion
		//#region src/client/index.ts
		/** 必需服务：UI 槽位注册表。 */
		const inject = ["slots"];
		/**
		* 占 FomWorker 品牌槽位（侧栏 logo/名称 + 聊天页 hero）。
		* 用声明感知的 ctx.slots.inject，顺序无关、随 fiber 回滚、HMR 安全。
		* 不照抄官方 ui-brand-official 的 official-profile 门控——本包无条件注册。
		* @param ctx - 客户端根上下文。
		*/
		function apply(ctx) {
			ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", function* () {
				yield ctx.slots.register({ name: "sidebar.brand.mark" }, FomMark);
				yield ctx.slots.register({ name: "sidebar.brand.name" }, FomName);
			}));
			ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark" }, FomHeroMark));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
