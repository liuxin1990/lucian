# 常用最小命令

## Maven

```bash
./mvnw -q -DskipTests compile
./mvnw -q test
./mvnw -q -Dtest=FooTest test
./mvnw -q -pl module-name -am test
```

## Gradle

```bash
./gradlew classes -q
./gradlew test -q
./gradlew test --tests com.example.FooTest -q
./gradlew :module:test -q
```

## 排错顺序

1. 编译错误 → 先 `compile`/`classes`，修 import/类型
2. 单测失败 → 只跑失败类
3. 依赖问题 → 看报错坐标，避免全量刷新 unless 必要
