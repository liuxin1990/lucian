# 轻量示例（按需阅读）

## Controller

```java
/** 用户查询接口 */
@RestController
@RequestMapping("/api/users")
public class UserController {
    /** 按 ID 查询用户 */
    @GetMapping("/{id}")
    public UserResponse get(@PathVariable Long id) {
        return userService.getById(id);
    }
}
```

## Service

```java
/** 用户领域服务 */
@Service
public class UserService {
    /** 按 ID 获取用户，不存在则抛业务异常 */
    @Transactional(readOnly = true)
    public UserResponse getById(Long id) {
        // ...
    }
}
```

以仓库现有代码为准；本文件仅作风格提示。
