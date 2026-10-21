# 参与贡献

通用研发工作流（门禁 + 状态机 + 证据）。MIT 许可，欢迎 issue 和 PR。

## 本地跑起来

```bash
git clone https://github.com/darkknight110/devflow-kit.git
cd devflow-kit
curl -fsSL https://raw.githubusercontent.com/darkknight110/devflow-kit/main/install.sh | sh
```

## 提交前必须跑

```bash
npm test && node scripts/selfcheck.mjs && bash examples/verify-all.sh
```

CI 会跑同样的命令；本地绿了再提 PR。

## 约定

- **先有证据，再下结论**：新增检查项要能给出可复核的证据，不靠"感觉"。
- **失败要出声**：不确定就报错或警告，绝不静默放行。
- **诚实边界**：做不到的能力写进文档，不写成"已支持"。
- 改门禁判据请同步 `spec/gates.json` 与 `docs/09-gates-reference.md`；两者漂移会被 SC59 抓出来。

## 提交信息

`<type>(<scope>): <摘要>`，不超过 72 字；一个提交只做一件事。
