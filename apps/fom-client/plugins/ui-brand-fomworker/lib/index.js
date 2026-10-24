//#region src/index.ts
/**
* FomWorker 品牌插件，node half（空座）。
* 浏览器半部经 exports["./client"] 发布；node 侧只给 Loader 一个 host 行。
*/
/** Host plugin body —— 本包只贡献浏览器展示。 */
function apply() {}
//#endregion
export { apply };
