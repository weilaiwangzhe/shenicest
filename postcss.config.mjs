// 项目不使用 postcss/tailwind。
// 此空配置用于屏蔽向上查找时误加载 D:\postcss.config.mjs（其他项目的 tailwind 配置）。
/** @type {import('postcss-load-config').Config} */
export default {
  plugins: {},
};
