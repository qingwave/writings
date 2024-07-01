---
title: 'Open Policy Agent vs Casbin'
date: 2022-05-20T06:03:49Z
draft: false
image: https://d33wubrfki0l68.cloudfront.net/b394f524e15a67457b85fdfeed02ff3f2764eb9e/6ac2b/docs/latest/images/opa-service.svg
description: "Golang访问工具库的对比"
tags: ['authorization']
categories: 
- 工具
---

大型项目中基本都包含有复杂的访问控制策略，特别是在一些多租户场景中，例如 Kubernetes 中就支持 RBAC，ABAC 等多种授权类型。在 Golang 中目前比较热门的访问控制框架有[Open Policy Agent](https://www.openpolicyagent.org/)与[Casbin](https://casbin.org/)，本文主要分析其异同与选型策略。

## Open Policy Agent

Open Policy Agent(简称 OPA)是一个开源的策略引擎，托管于 CNCF，通常用来做在微服务、API 网关、Kubernetes、CI/CD 等系统中做策略管理。

OPA 将策略从代码中分离出来，按照官网的说法 OPA 实现了*策略即代码*，通过 Rego 声明式语言实现决策逻辑，当系统需要做出策略时，只需携带请求查询 OPA 即可，OPA 会返回决策结果。
![img](https://d33wubrfki0l68.cloudfront.net/b394f524e15a67457b85fdfeed02ff3f2764eb9e/6ac2b/docs/latest/images/opa-service.svg)

### 那么我们为什么需要 OPA?

大型软件中各个组件都需要进行一些策略控制，比如用户权限校验、创建资源校验、某个时间段允许访问，如果每个组件都需要实现一套策略控制，那么彼此之间会不统一，维护困难。一个自然的想法是能否将这些策略逻辑抽离出来，形成一个单独的服务，同时这个服务可能需要提供各种不同 sdk 来屏蔽语言差异。

OPA 正是解决这个问题，将散落在系统各处的策略进行统一，所有服务直接请求 OPA 即可。通过引入 OPA 可以降低系统耦合性，减少维护复杂度。

### Http API 中使用 OPA 授权

我们在 Gin 实现的 Http 服务中（原生 http 库也类似）引入 OPA 来实现 Http API 授权。示例代码见[https://github.com/qingwave/opa-gin-authz](https://github.com/qingwave/opa-gin-authz)

首先需要实现策略，我们允许所有用户访问非 api 的接口，拒绝未认证用户访问 api 资源，通过 Rego 实现如下：

```rego
package authz

default allow = false

allow {
    input.method == "GET"
	not startswith(input.path, "/api") #如果请求方法为GET并且path不以/api开头则允许
}

allow {
    input.method == "GET"
    input.subject.user != "" #用户名不为空
}
```

在 Gin 中实现 OPA 插件，这里通过嵌入 OPA 到代码中来实现授权，也可以将 OPA 单独部署

```go
func WithOPA(opa *rego.PreparedEvalQuery, logger *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := c.Query("user")
		groups := c.QueryArray("groups")
		input := map[string]interface{}{ //构造OPA输入
			"method": c.Request.Method,
			"path":   c.Request.RequestURI,
			"subject": map[string]interface{}{
				"user":  user,
				"group": groups,
			},
		}

		logger.Info(fmt.Sprintf("start opa middleware %s, %#v", c.Request.URL.String(), input))
		res, err := opa.Eval(context.TODO(), rego.EvalInput(input)) // 验证用户请求
		if err != nil {
			c.JSON(http.StatusInternalServerError, err)
			c.Abort()
			return
		}

		defer logger.Info(fmt.Sprintf("opa result: %v, %#v", res.Allowed(), res))

		if !res.Allowed() {
			c.JSON(http.StatusForbidden, gin.H{
				"msg": "forbidden",
			})
			c.Abort()
			return
		}

		c.Next()
	}
}
```

## Casbin

Casbin 是一个 Golang 实现的开源访问控制框架，支持 RBAC、ACL 等多种访问控制策略，也支持 Golang、Java、JavaScript 等多种语言。

在 Casbin 中, 访问控制模型被抽象为基于 PERM(Policy, Effect, Request, Matcher) 的一个文件。通过定义 PERM 模型来描述资源与用户之间的关系，使用时将具体请求传入 Casbin sdk 即可返回决策结果。

### 为什么需要 Casbin

借助 Casbin 可以轻松实现比如 RBAC 的访问控制，不需要额外的代码。同时引入 Casbin 可以简化表结构，如果我们资源实现 RBAC 策略需要实现：用户表、角色表、操作表、用户角色表、角色操作表，通过 RBAC 实现，我们只需实现基础表即可，关系表由 Casbin 实现。

### Casbin 实现 Http API 访问控制

首先，我们需要实现 Casbin 模式，包含请求与策略格式定义，Matchers 即策略逻辑

```
[request_definition]
r = sub, obj, act

[policy_definition]
p = sub, obj, act

[policy_effect]
e = some(where (p.eft == allow)) #其中一个策略生效则返回True

[matchers]
m = r.sub == p.sub && keyMatch(r.obj, p.obj) && r.act == p.act
```

预定义一些策略，也可以存储到数据库, alice 可以访问所有/api 开头的路径，bob 只能访问/version 路径

```csv
p, alice, /api/*, read
p, bob, /version, write
```

通过各种需要的 sdk 可以轻松接入 Casbin

```go
// 加载模型与策略，也可以存储到数据库
e, err := casbin.NewEnforcer("path/to/model.conf", "path/to/policy.csv")

sub := "alice" // the user that wants to access a resource.
obj := "data1" // the resource that is going to be accessed.
act := "read" // the operation that the user performs on the resource.

ok, err := e.Enforce(sub, obj, act) //判断用户是否有权限
```

## OPA vs Casbin

那么，在项目中我们需要如何选择合适的策略引擎，如果项目授权方式比较简单，首先推荐通过代码实现，不需要引入第三方库。需要确实需要借助额外的框架可以考虑以下几点角度。

<table>
    <tr>
        <td width="20%">对比项</td>
        <td width="40%"> OPA</td>
        <td width="40%">Casbin</td>
    </tr>
    <tr>
        <td width="20%">访问控制策略</td>
        <td width="40%">通过Rego可以实现多种策略</td>
        <td width="40%">原生支持ACL、ABAC、RBAC等多种策略</td>
    </tr>
    <tr>
        <td width="20%">自定义策略</td>
        <td width="40%"> 支持</td>
        <td width="40%">通过自定义函数和Model实现，灵活性一般</td>
    </tr>
    <tr>
        <td width="20%">调整策略复杂度</td>
        <td width="40%">更改/添加Rego逻辑即可</td>
        <td width="40%">如果已存在大量策略数据，需要考虑数据迁移</td>
    </tr>
    <tr>
        <td width="20%"> 存储数据</td>
        <td width="40%">不支持</td>
        <td width="40%">支持存储策略存储到文件或数据库</td>
    </tr>
    <tr>
        <td width="20%">运行方式</td>
        <td width="40%">内嵌、单独部署</td>
        <td width="40%">通常为内嵌</td>
    </tr>
    <tr>
        <td width="20%">sdk支持语言</td>
        <td width="40%">Go、WASM(nodejs)、Python-rego，其他通过Restful API</td>
        <td width="40%">支持Java、Go、Python等多种常用语言</td>
    </tr>
    <tr>
        <td width="20%">策略返回格式</td>
        <td width="40%">Json数据</td>
        <td width="40%">True/False</td>
    </tr>
    <tr>
        <td width="20%">性能</td>
        <td width="40%">评估时间随着策略数据量会增加，支持多节点部署</td>
        <td width="40%">对于HTTP服务评估时间在1ms内</td>
    </tr>
</table>

简而言之，如果系统策略模型固定，可以引入 Casbin 简化授权系统设计。如果策略需要经常调整、扩展，或者微服务系统中多个组件都需要策略控制，使用 OPA 可以将策略实现抽离出来。

## 引用

1. https://www.openpolicyagent.org/docs/latest/
2. https://casbin.org/docs/zh-CN/

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
