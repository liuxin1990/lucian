---
name: java-build-test
description: Java/Maven/Gradle 编译与测试排错。在编译失败、单测失败、需要最小复现命令时使用。
paths:
  - "**/*.java"
  - "**/pom.xml"
  - "**/build.gradle"
  - "**/build.gradle.kts"
  - "**/settings.gradle*"
---

# Java 构建与测试

目标：用最少命令定位失败，少读无关文件。

## 步骤

1. 识别构建工具：根目录有 `pom.xml` → Maven；有 `build.gradle*` → Gradle。
2. 先跑最小命令（见 `references/commands.md`），不要一上来全量 clean install。
3. 根据失败类名/测试名，只打开相关源文件与测试文件。
4. 修完后只复跑失败用例，再视需要跑模块级 `test`。
5. 回复只写：失败原因一句话 + 改了哪些文件 + 用了哪条命令。

## 禁止

- 不要粘贴完整编译日志；只摘关键报错行
- 不要为了“全面检查”扫描整个 monorepo
- 不要无故 `clean` 或删 `.m2`
