/**
 * 「环境受限」失败的**唯一判定来源**（doctor 与门禁/证据层共用）。
 *
 * 为什么必须单一来源：这两层曾各写一份模式列表，随即发生漂移 ——
 * `Failed to load ApplicationContext`（Spring 集成测试因缺 DB/oauth 而失败）
 * 只在其中一层被识别，于是体检说"未验证"、门禁说"失败"，使用者同时收到两个矛盾结论。
 * 这正是本产品要消灭的那类不一致，所以判定逻辑集中在这里。
 */
const PATTERNS = [
  { re: /Operation not permitted|Permission denied|EACCES|EPERM/i, what: '权限/沙箱限制（如 ~/.m2 不可写）' },
  { re: /Could not resolve dependencies|Could not transfer artifact|Connection refused|ETIMEDOUT|ENOTFOUND|Network is unreachable/i, what: '依赖解析/网络不可达' },
  { re: /Failed to load ApplicationContext|未配置 spring\.datasource\.url|Unable to start web server|HttpTimeoutException/i, what: '集成测试所需外部依赖不可用（DB/配置服务等）' },
  { re: /No such file or directory.*(\.m2|maven|jdk|node_modules)/i, what: '本地依赖或工具链缺失' },
  { re: /command not found|not installed|No module named/i, what: '工具未安装' },
];

/** 返回命中的环境类原因（字符串）；无命中返回 null */
export function envFailureReason(raw) {
  const text = String(raw || '');
  for (const { re, what } of PATTERNS) {
    if (re.test(text)) return what;
  }
  return null;
}

/** 布尔便捷形式 */
export function isEnvRestricted(raw) {
  return envFailureReason(raw) !== null;
}
