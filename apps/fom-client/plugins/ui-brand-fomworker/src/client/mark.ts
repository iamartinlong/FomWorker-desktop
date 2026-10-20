/**
 * FomWorker 品牌标记的**几何与色值**（纯数据，无 React）。
 * 据 `fom-logo.png` 手绘的 SVG 近似；`Brand.tsx` 消费它渲染。⚠️ 待矢量源替换。
 */

/** 品牌色（见 `packages/fom-brand/tokens.css`）。 */
export const BRAND_BLUE = '#038AC6'
export const BRAND_AMBER = '#FCB513'
export const BRAND_INK = '#4E4B47'

/** 标记的 viewBox。 */
export const MARK_VIEWBOX = '0 0 64 64'

/** 蓝色「C/立方」。 */
export const MARK_BLUE = 'M20 20 L36 8 L56 19 L56 33 L38 22 L30 27 L30 52 L16 44 L16 22 Z'
/** 琥珀上右箭头。 */
export const MARK_ARROW = 'M30 16 L40 10 L50 16 L46 19 L40 15.5 L34 19 Z'
/** 琥珀竖条（带尖底）。 */
export const MARK_BAR = 'M42 22 L55 30 L55 50 L48.5 54 L42 50 Z'
