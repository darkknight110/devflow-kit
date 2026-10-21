# 更新记录

## 1.28.0

- G9 发布前置门禁：`release.requires` 列出的门禁必须各有一条 pass 记录，且记录需比产物更新
- `advance --to released` 自动现跑门禁，`--no-run` 的旧记录因新鲜度被判无效
- `init --with-preflight`：生成 `preflight-gate.sh` 与负向对照，并注册发布要求
- CLI 契约：`--version`、`--doctor`（门禁可信度体检）
- 演示：9 步 light 档真实采集 + 7 秒动图 + 四格故事板
- 自检 72 项；CI 覆盖 Node 20/22 + 每日定时
