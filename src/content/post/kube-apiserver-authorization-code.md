---
title: kube-apiserver鉴权源码分析
date: 2020-04-23 16:54:14
tags:
  - k8s
  - authorization
categories:
  - cloud
top: true
cover: true
---

## 简介

kube-apiserver 中与权限相关的主要有三种机制，即认证、鉴权和准入控制。上节讲到[认证流程](./kube-apiserver-authentication-code.md)。

认证与授权很容易混淆：

- 认证(Authentication), 负责检查你是谁，识别 user
- 授权(Authorization), 你能做什么，是否允许 User 对资源的操作
- 审计(Audit), 负责记录操作信息，方便后续审查

本文主要分析 apiserver 的 rbac 授权流程。

## 认证流程分析

权限相关代码从`k8s.io/apiserver/pkg/server/config.go`中`DefaultBuildHandlerChain`函数开始执行

```go
func DefaultBuildHandlerChain(apiHandler http.Handler, c *Config) http.Handler {
	handler := genericapifilters.WithAuthorization(apiHandler, c.Authorization.Authorizer, c.Serializer)
	handler = genericfilters.WithMaxInFlightLimit(handler, c.MaxRequestsInFlight, c.MaxMutatingRequestsInFlight, c.LongRunningFunc)
	handler = genericapifilters.WithImpersonation(handler, c.Authorization.Authorizer, c.Serializer)
	handler = genericapifilters.WithAudit(handler, c.AuditBackend, c.AuditPolicyChecker, c.LongRunningFunc)
	failedHandler := genericapifilters.Unauthorized(c.Serializer, c.Authentication.SupportsBasicAuth)
	failedHandler = genericapifilters.WithFailedAuthenticationAudit(failedHandler, c.AuditBackend, c.AuditPolicyChecker)
	handler = genericapifilters.WithAuthentication(handler, c.Authentication.Authenticator, failedHandler, c.Authentication.APIAudiences)
	handler = genericfilters.WithCORS(handler, c.CorsAllowedOriginList, nil, nil, nil, "true")
	handler = genericfilters.WithTimeoutForNonLongRunningRequests(handler, c.LongRunningFunc, c.RequestTimeout)
	handler = genericfilters.WithWaitGroup(handler, c.LongRunningFunc, c.HandlerChainWaitGroup)
	handler = genericapifilters.WithRequestInfo(handler, c.RequestInfoResolver)
	handler = genericfilters.WithPanicRecovery(handler)
	return handler
}
```

`DefaultBuildHandlerChain`中包含了多种 filter（如认证，链接数检验，RBAC 权限检验等），授权步骤在`WithAuthorization`中，如下：

```go
// WithAuthorizationCheck passes all authorized requests on to handler, and returns a forbidden error otherwise.
func WithAuthorization(handler http.Handler, a authorizer.Authorizer, s runtime.NegotiatedSerializer) http.Handler {
	// 检查是否需要权限校验
	if a == nil {
		klog.Warningf("Authorization is disabled")
		return handler
	}
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		ctx := req.Context()
		// 用作审计
		ae := request.AuditEventFrom(ctx)

		// 获取Attribute, 通过reqeust获取到请求的user, resource, verb, 是否为namespace级别的等
		attributes, err := GetAuthorizerAttributes(ctx)
		if err != nil {
			responsewriters.InternalError(w, req, err)
			return
		}
		// 执行认证流程
		authorized, reason, err := a.Authorize(ctx, attributes)
		// an authorizer like RBAC could encounter evaluation errors and still allow the request, so authorizer decision is checked before error here.
		if authorized == authorizer.DecisionAllow {
			audit.LogAnnotation(ae, decisionAnnotationKey, decisionAllow)
			audit.LogAnnotation(ae, reasonAnnotationKey, reason)
			// 校验成功，记录信息，转到下一个handler
			handler.ServeHTTP(w, req)
			return
		}
		if err != nil {
			audit.LogAnnotation(ae, reasonAnnotationKey, reasonError)
			responsewriters.InternalError(w, req, err)
			return
		}

		// 校验失败返回403，注意认证失败返回的是401
		klog.V(4).Infof("Forbidden: %#v, Reason: %q", req.RequestURI, reason)
		audit.LogAnnotation(ae, decisionAnnotationKey, decisionForbid)
		audit.LogAnnotation(ae, reasonAnnotationKey, reason)
		responsewriters.Forbidden(ctx, attributes, w, req, reason, s)
	})
}
```

授权流程比较清晰，从 request 获取请求信息，进行鉴权，成功进入后续 handler，失败返回 403。

`Authorize`接口有多种实现，通过在 apiserver 配置`--authorization-mode`选择鉴权模式，包括：

- ABAC
- RBAC
- Node, 用于 kubelet 鉴权 exec/logs 等
- AlwaysAllow
- AlwaysDeny
- Webhook， 用于扩展权限，用户可实现 Webhook 与其他权限系统集成

如果选择`AlwaysAllow`,即不做鉴权, 开启后强制不允许匿名用户

```go
// ApplyAuthorization will conditionally modify the authentication options based on the authorization options
func (o *BuiltInAuthenticationOptions) ApplyAuthorization(authorization *BuiltInAuthorizationOptions) {
	if o == nil || authorization == nil || o.Anonymous == nil {
		return
	}

	// authorization ModeAlwaysAllow cannot be combined with AnonymousAuth.
	// in such a case the AnonymousAuth is stomped to false and you get a message
	if o.Anonymous.Allow && sets.NewString(authorization.Modes...).Has(authzmodes.ModeAlwaysAllow) {
		klog.Warningf("AnonymousAuth is not allowed with the AlwaysAllow authorizer. Resetting AnonymousAuth to false. You should use a different authorizer")
		o.Anonymous.Allow = false
	}
}
```

## rbac 鉴权

rbac 是常用的鉴权方式，实现`Authorize`接口, 代码在[rbac.go](https://github.com/kubernetes/kubernetes/blob/92eb072989eba22236d034b56cc2bf159dfb4915/plugin/pkg/auth/authorizer/rbac/rbac.go#L75)

```go
func (r *RBACAuthorizer) Authorize(ctx context.Context, requestAttributes authorizer.Attributes) (authorizer.Decision, string, error) {
	ruleCheckingVisitor := &authorizingVisitor{requestAttributes: requestAttributes}
	// 调用VisitRulesFor来检查是否用权限
	r.authorizationRuleResolver.VisitRulesFor(requestAttributes.GetUser(), requestAttributes.GetNamespace(), ruleCheckingVisitor.visit)
	if ruleCheckingVisitor.allowed {
		// 成功直接返回
		return authorizer.DecisionAllow, ruleCheckingVisitor.reason, nil
	}

	// 失败，打印日志返回失败原因
	// Build a detailed log of the denial.
	// Make the whole block conditional so we don't do a lot of string-building we won't use.
	if klog.V(5) {
		var operation string
		if requestAttributes.IsResourceRequest() {
			b := &bytes.Buffer{}
			b.WriteString(`"`)
			b.WriteString(requestAttributes.GetVerb())
			b.WriteString(`" resource "`)
			b.WriteString(requestAttributes.GetResource())
			if len(requestAttributes.GetAPIGroup()) > 0 {
				b.WriteString(`.`)
				b.WriteString(requestAttributes.GetAPIGroup())
			}
			if len(requestAttributes.GetSubresource()) > 0 {
				b.WriteString(`/`)
				b.WriteString(requestAttributes.GetSubresource())
			}
			b.WriteString(`"`)
			if len(requestAttributes.GetName()) > 0 {
				b.WriteString(` named "`)
				b.WriteString(requestAttributes.GetName())
				b.WriteString(`"`)
			}
			operation = b.String()
		} else {
			operation = fmt.Sprintf("%q nonResourceURL %q", requestAttributes.GetVerb(), requestAttributes.GetPath())
		}

		var scope string
		if ns := requestAttributes.GetNamespace(); len(ns) > 0 {
			scope = fmt.Sprintf("in namespace %q", ns)
		} else {
			scope = "cluster-wide"
		}

		klog.Infof("RBAC DENY: user %q groups %q cannot %s %s", requestAttributes.GetUser().GetName(), requestAttributes.GetUser().GetGroups(), operation, scope)
	}

	reason := ""
	if len(ruleCheckingVisitor.errors) > 0 {
		reason = fmt.Sprintf("RBAC: %v", utilerrors.NewAggregate(ruleCheckingVisitor.errors))
	}
	return authorizer.DecisionNoOpinion, reason, nil
}
```

`Authorize`调用了`VisitRulesFor`来处理具体鉴权操作, 代码在[rule.go](https://github.com/kubernetes/kubernetes/blob/81e9f21f832f88422f1ccf5b8aa90de7cf822132/pkg/registry/rbac/validation/rule.go#L178)

```go
func (r *DefaultRuleResolver) VisitRulesFor(user user.Info, namespace string, visitor func(source fmt.Stringer, rule *rbacv1.PolicyRule, err error) bool) {
	// 获取所有clusterrolebinding
	if clusterRoleBindings, err := r.clusterRoleBindingLister.ListClusterRoleBindings(); err != nil {
		if !visitor(nil, nil, err) {
			return
		}
	} else {
		sourceDescriber := &clusterRoleBindingDescriber{}
		// 遍历clusterrolebing
		for _, clusterRoleBinding := range clusterRoleBindings {
			// 检查是否有对应的user
			subjectIndex, applies := appliesTo(user, clusterRoleBinding.Subjects, "")
			if !applies {
				continue
			}
			// 如果user存在于subject, 获取对应的rules即clusterrole
			rules, err := r.GetRoleReferenceRules(clusterRoleBinding.RoleRef, "")
			if err != nil {
				if !visitor(nil, nil, err) {
					return
				}
				continue
			}
			sourceDescriber.binding = clusterRoleBinding
			sourceDescriber.subject = &clusterRoleBinding.Subjects[subjectIndex]
			for i := range rules {
				// 调用visitor判断是否需要进入下一步鉴权
				if !visitor(sourceDescriber, &rules[i], nil) {
					return
				}
			}
		}
	}

	// clusterrole遍历完还没有鉴权成功，接着遍历所在namespace的role，流程同上
	if len(namespace) > 0 {
		if roleBindings, err := r.roleBindingLister.ListRoleBindings(namespace); err != nil {
			if !visitor(nil, nil, err) {
				return
			}
		} else {
			sourceDescriber := &roleBindingDescriber{}
			for _, roleBinding := range roleBindings {
				subjectIndex, applies := appliesTo(user, roleBinding.Subjects, namespace)
				if !applies {
					continue
				}
				rules, err := r.GetRoleReferenceRules(roleBinding.RoleRef, namespace)
				if err != nil {
					if !visitor(nil, nil, err) {
						return
					}
					continue
				}
				sourceDescriber.binding = roleBinding
				sourceDescriber.subject = &roleBinding.Subjects[subjectIndex]
				for i := range rules {
					if !visitor(sourceDescriber, &rules[i], nil) {
						return
					}
				}
			}
		}
	}
}
```

`visit`函数, 用来判断是否认证成功，成功返回`false`, 不需要进行下一步鉴权

```go
func (v *authorizingVisitor) visit(source fmt.Stringer, rule *rbacv1.PolicyRule, err error) bool {
	if rule != nil && RuleAllows(v.requestAttributes, rule) {
		// allowed用来表示是否认证成功
		v.allowed = true
		v.reason = fmt.Sprintf("RBAC: allowed by %s", source.String())
		return false
	}
	if err != nil {
		v.errors = append(v.errors, err)
	}
	return true
}
```

rbac 的鉴权流程如下:

1. 通过`Request`获取`Attribute`包括用户，资源和对应的操作
2. `Authorize`调用`VisitRulesFor`进行具体的鉴权
3. 获取所有的 ClusterRoleBindings，并对其进行遍历操作
4. 根据请求 User 信息，判断该是否被绑定在该 ClusterRoleBinding 中
5. 若在将通过函数`GetRoleReferenceRules()`获取绑定的 Role 所控制的访问的资源
6. 将 Role 所控制的访问的资源，与从 API 请求中提取出的资源进行比对，若比对成功，即为 API 请求的调用者有权访问相关资源
7. 遍历 ClusterRoleBinding 中，都没有获得鉴权成功的操作，将会判断提取出的信息中是否包括了 namespace 的信息，若包括了，将会获取该 namespace 下的所有 RoleBindings，类似 ClusterRoleBindings
8. 若在遍历了所有 CluterRoleBindings，及该 namespace 下的所有 RoleBingdings 之后，仍没有对资源比对成功，则可判断该 API 请求的调用者没有权限访问相关资源, 鉴权失败

## 总结

本文结合 RBAC 分析了 Kubernetes 的鉴权流程，整体这部分比较代码清晰。RBAC 是 Kubernetes 比较推荐的鉴权方式，了解完整个流程后，居然所有请求都会先遍历一遍 ClusterRoleBindings，这样实现起来比较简单，但随着规模和用户的扩大，这部分是否会有性能问题，需不需要实现能够快速鉴权的方式。
