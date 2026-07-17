# AGENTS

精简项目地图（保持短；细节放 Skills）。

## 技术栈

- Java 17+ / Spring Boot
- 构建：Maven（`./mvnw`）或 Gradle（`./gradlew`）
- 测试：JUnit 5

## 常用命令

```bash
# Maven
./mvnw -q -DskipTests compile
./mvnw -q test
./mvnw -q -Dtest=ClassNameTest test

# Gradle
./gradlew classes -q
./gradlew test -q
./gradlew test --tests ClassNameTest -q
```

## 约定入口

- 构建/测试失败排查 → Skill `java-build-test`
- Spring 分层与命名 → Skill `spring-conventions`
- 提交前检查 → Skill `pr-checklist`

## 回复原则

- 先改代码，少解释；不要复述整段需求
- 不要主动生成大段文档，除非被要求
