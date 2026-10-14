/**
 * 宿主侧入口（占位）。
 *
 * 本插件**只在客户端工作**（一个内嵌看板的 iframe），不注册任何宿主能力：
 * 看板的渲染与数据全在 `devflow board`（本地服务）里，插件不参与。
 * 保留此文件是为了满足插件包需要主入口的约定。
 */
export default function devflowBoardHostPlugin() {
  // 有意为空：不注册模型工具、不注册命令、不申请网络/写权限。
}
