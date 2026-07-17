---
name: spring-conventions
description: Spring Boot 分层、命名与接口约定。在新增/修改 Controller、Service、Repository、DTO、配置类时使用。
paths:
  - "**/*.java"
  - "**/application*.yml"
  - "**/application*.properties"
---

# Spring 约定（短版）

## 分层

- `controller`：入参校验、调 service、返回 DTO；不写业务规则
- `service`：业务逻辑；事务边界放这里
- `repository`：数据访问；不塞业务分支
- `dto` / `vo` / `entity`：按项目现有命名，不混用新风格

## 命名

- REST：名词复数资源路径，与现有 Controller 一致
- 方法名贴合相邻类；避免无意义 `handle`/`process` 前缀堆砌
- 异常：复用项目已有异常类型与全局处理，不新建一套

## 改动原则

1. 先读同包 1～2 个相邻类，对齐风格再写
2. 注释用中文；每个方法一行功能说明
3. 配置项优先复用现有 `application*.yml` 前缀，不发明新前缀
4. 细节示例见 `references/examples.md`（需要时再读）

## 禁止

- 不要在回复里复述整套架构
- 不要顺手大重构无关类
- 不要新增未使用的 starter/依赖
