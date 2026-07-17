# Cursor 省 Token 模板（Java / Spring）

本仓库提供一套面向 Cursor Agent 的最小配置：短规则 + 按需 Skills + `.cursorignore`。

## 包含内容

| 路径 | 作用 |
|---|---|
| `AGENTS.md` | 项目短地图与命令入口 |
| `.cursor/rules/always-concise.mdc` | 全局极短约束（Always） |
| `.cursor/rules/java-globs.mdc` | 仅触达 Java/构建文件时生效 |
| `.cursor/skills/java-build-test/` | 编译/测试排错 |
| `.cursor/skills/spring-conventions/` | Spring 分层与命名 |
| `.cursor/skills/pr-checklist/` | 提交前检查（仅手动 `/pr-checklist`） |
| `.cursorignore` | 排除构建产物、日志、密钥噪音 |

## 用法

1. 在 Cursor 窗口版打开本项目（或把这些文件拷到你的 Java 仓库根目录）
2. Agent 对话框输入 `/`，应能看到上述三个 Skill
3. 日常：让 Agent 写代码即可（会按 `paths` 自动选用）
4. 提交前：手动输入 `/pr-checklist`
5. 深度审查：用内置 `/review`，不要塞进 Always 规则

## 省 Token 原则

- Always 规则保持极短；长流程放 Skill，细节放 `references/`
- 不用的 MCP 在 Customize 里关掉
- 少开 Max Mode；避免 `/loop`、`/babysit` 当日常习惯
