---
name: pr-checklist
description: 提交或开 PR 前的最小检查清单。在准备 commit、push、创建 PR、自测完成后使用。手动优先，避免每轮自动注入。
disable-model-invocation: true
---

# PR / 提交检查（手动 `/pr-checklist`）

只做最小闭环，省上下文。

## 检查项

1. 变更是否只覆盖需求相关文件
2. 能否编译：`./mvnw -q -DskipTests compile` 或 `./gradlew classes -q`
3. 相关测试是否通过（优先单测类，而非全量）
4. 无密钥、无 `application-local`、无大日志进提交
5. commit message 一句说清意图

## 输出格式（严格）

```
状态: 通过 | 需修
改动: 文件1, 文件2
验证: <命令>
风险: <一句或不写>
```

## 禁止

- 不要展开成冗长 review 报告
- 不要主动 `/babysit` 或反复循环
- 需要深度审查时另用 `/review`，不要混在本 Skill 里
