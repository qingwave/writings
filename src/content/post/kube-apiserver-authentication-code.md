---
title: kube-apiserver认证源码分析
date: 2020-01-31 16:54:14
tags:
  - k8s
categories:
  - cloud
top: true
cover: true
---

## 简介

kube-apiserver 中与权限相关的主要有三种机制，即认证、鉴权和准入控制。本文主要分析 apiserver 的认证流程。

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

`DefaultBuildHandlerChain`中包含了多种 filter（如认证，链接数检验，RBAC 权限检验等），认证步骤在`WithAuthorization`中，如下：

```go
// WithAuthentication creates an http handler that tries to authenticate the given request as a user, and then
// stores any such user found onto the provided context for the request. If authentication fails or returns an error
// the failed handler is used. On success, "Authorization" header is removed from the request and handler
// is invoked to serve the request.
func WithAuthentication(handler http.Handler, auth authenticator.Request, failed http.Handler, apiAuds authenticator.Audiences) http.Handler {
	if auth == nil {
		klog.Warningf("Authentication is disabled")
		return handler
	}
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		authenticationStart := time.Now()

		if len(apiAuds) > 0 {
			req = req.WithContext(authenticator.WithAudiences(req.Context(), apiAuds))
        }
        // 认证请求
		resp, ok, err := auth.AuthenticateRequest(req)
		if err != nil || !ok {
			if err != nil {
				klog.Errorf("Unable to authenticate the request due to an error: %v", err)
				authenticatedAttemptsCounter.WithLabelValues(errorLabel).Inc()
				authenticationLatency.WithLabelValues(errorLabel).Observe(time.Since(authenticationStart).Seconds())
			} else if !ok {
				authenticatedAttemptsCounter.WithLabelValues(failureLabel).Inc()
				authenticationLatency.WithLabelValues(failureLabel).Observe(time.Since(authenticationStart).Seconds())
			}

			failed.ServeHTTP(w, req)
			return
		}

		if len(apiAuds) > 0 && len(resp.Audiences) > 0 && len(authenticator.Audiences(apiAuds).Intersect(resp.Audiences)) == 0 {
			klog.Errorf("Unable to match the audience: %v , accepted: %v", resp.Audiences, apiAuds)
			failed.ServeHTTP(w, req)
			return
		}

        // authorization header is not required anymore in case of a successful authentication.
        // 认证完则删除header认证信息，exec/log请求将不会携带Authorization，只使用token认证将无法通过
		req.Header.Del("Authorization")

		req = req.WithContext(genericapirequest.WithUser(req.Context(), resp.User))

		authenticatedUserCounter.WithLabelValues(compressUsername(resp.User.GetName())).Inc()
		authenticatedAttemptsCounter.WithLabelValues(successLabel).Inc()
		authenticationLatency.WithLabelValues(successLabel).Observe(time.Since(authenticationStart).Seconds())

		handler.ServeHTTP(w, req)
	})
}
```

`WithAuthentication`调用`AuthenticateRequest`进行认证：

```go
// AuthenticateRequest authenticates the request using a chain of authenticator.Request objects.
func (authHandler *unionAuthRequestHandler) AuthenticateRequest(req *http.Request) (*authenticator.Response, bool, error) {
    var errlist []error
    // 按照Handlers顺序进行认证
    for _, currAuthRequestHandler := range authHandler.Handlers {
        resp, ok, err := currAuthRequestHandler.AuthenticateRequest(req)
        if err != nil {
            if authHandler.FailOnError {
                return resp, ok, err
            }
            errlist = append(errlist, err)
            continue
        }

        // 只要有一个认证成功，则返回
        if ok {
            return resp, ok, err
        }
    }

    return nil, false, utilerrors.NewAggregate(errlist)
}
```

根据认证逻辑，会按照`authHandler.Handlers`顺序进行检验，只要有一个认证成功则返回。`Handlers`的定义在

```go
// New returns a request authenticator that validates credentials using a chain of authenticator.Request objects.
// The entire chain is tried until one succeeds. If all fail, an aggregate error is returned.
func New(authRequestHandlers ...authenticator.Request) authenticator.Request {
	if len(authRequestHandlers) == 1 {
		return authRequestHandlers[0]
	}
	return &unionAuthRequestHandler{Handlers: authRequestHandlers, FailOnError: false}
}
```

最初的定义在`k8s.io/kubernetes/pkg/kubeapiserver/authenticator/config.go`中：

```go
// New returns an authenticator.Request or an error that supports the standard
// Kubernetes authentication mechanisms.
func (config Config) New() (authenticator.Request, *spec.SecurityDefinitions, error) {
	var authenticators []authenticator.Request
	var tokenAuthenticators []authenticator.Token
	securityDefinitions := spec.SecurityDefinitions{}

	// front-proxy, BasicAuth methods, local first, then remote
	// Add the front proxy authenticator if requested
	if config.RequestHeaderConfig != nil {
		requestHeaderAuthenticator := headerrequest.NewDynamicVerifyOptionsSecure(
			config.RequestHeaderConfig.CAContentProvider.VerifyOptions,
			config.RequestHeaderConfig.AllowedClientNames,
			config.RequestHeaderConfig.UsernameHeaders,
			config.RequestHeaderConfig.GroupHeaders,
			config.RequestHeaderConfig.ExtraHeaderPrefixes,
		)
		authenticators = append(authenticators, authenticator.WrapAudienceAgnosticRequest(config.APIAudiences, requestHeaderAuthenticator))
	}

	// basic auth
	if len(config.BasicAuthFile) > 0 {
		basicAuth, err := newAuthenticatorFromBasicAuthFile(config.BasicAuthFile)
		if err != nil {
			return nil, nil, err
		}
		authenticators = append(authenticators, authenticator.WrapAudienceAgnosticRequest(config.APIAudiences, basicAuth))

		securityDefinitions["HTTPBasic"] = &spec.SecurityScheme{
			SecuritySchemeProps: spec.SecuritySchemeProps{
				Type:        "basic",
				Description: "HTTP Basic authentication",
			},
		}
	}

	// X509 methods
	if config.ClientCAContentProvider != nil {
		certAuth := x509.NewDynamic(config.ClientCAContentProvider.VerifyOptions, x509.CommonNameUserConversion)
		authenticators = append(authenticators, certAuth)
	}

	// Bearer token methods, local first, then remote
	if len(config.TokenAuthFile) > 0 {
		tokenAuth, err := newAuthenticatorFromTokenFile(config.TokenAuthFile)
		if err != nil {
			return nil, nil, err
		}
		tokenAuthenticators = append(tokenAuthenticators, authenticator.WrapAudienceAgnosticToken(config.APIAudiences, tokenAuth))
	}
	if len(config.ServiceAccountKeyFiles) > 0 {
		serviceAccountAuth, err := newLegacyServiceAccountAuthenticator(config.ServiceAccountKeyFiles, config.ServiceAccountLookup, config.APIAudiences, config.ServiceAccountTokenGetter)
		if err != nil {
			return nil, nil, err
		}
		tokenAuthenticators = append(tokenAuthenticators, serviceAccountAuth)
	}
	if utilfeature.DefaultFeatureGate.Enabled(features.TokenRequest) && config.ServiceAccountIssuer != "" {
		serviceAccountAuth, err := newServiceAccountAuthenticator(config.ServiceAccountIssuer, config.ServiceAccountKeyFiles, config.APIAudiences, config.ServiceAccountTokenGetter)
		if err != nil {
			return nil, nil, err
		}
		tokenAuthenticators = append(tokenAuthenticators, serviceAccountAuth)
	}
	if config.BootstrapToken {
		if config.BootstrapTokenAuthenticator != nil {
			// TODO: This can sometimes be nil because of
			tokenAuthenticators = append(tokenAuthenticators, authenticator.WrapAudienceAgnosticToken(config.APIAudiences, config.BootstrapTokenAuthenticator))
		}
	}
	// NOTE(ericchiang): Keep the OpenID Connect after Service Accounts.
	//
	// Because both plugins verify JWTs whichever comes first in the union experiences
	// cache misses for all requests using the other. While the service account plugin
	// simply returns an error, the OpenID Connect plugin may query the provider to
	// update the keys, causing performance hits.
	if len(config.OIDCIssuerURL) > 0 && len(config.OIDCClientID) > 0 {
		oidcAuth, err := newAuthenticatorFromOIDCIssuerURL(oidc.Options{
			IssuerURL:            config.OIDCIssuerURL,
			ClientID:             config.OIDCClientID,
			APIAudiences:         config.APIAudiences,
			CAFile:               config.OIDCCAFile,
			UsernameClaim:        config.OIDCUsernameClaim,
			UsernamePrefix:       config.OIDCUsernamePrefix,
			GroupsClaim:          config.OIDCGroupsClaim,
			GroupsPrefix:         config.OIDCGroupsPrefix,
			SupportedSigningAlgs: config.OIDCSigningAlgs,
			RequiredClaims:       config.OIDCRequiredClaims,
		})
		if err != nil {
			return nil, nil, err
		}
		tokenAuthenticators = append(tokenAuthenticators, oidcAuth)
	}
	if len(config.WebhookTokenAuthnConfigFile) > 0 {
		webhookTokenAuth, err := newWebhookTokenAuthenticator(config.WebhookTokenAuthnConfigFile, config.WebhookTokenAuthnVersion, config.WebhookTokenAuthnCacheTTL, config.APIAudiences)
		if err != nil {
			return nil, nil, err
		}
		tokenAuthenticators = append(tokenAuthenticators, webhookTokenAuth)
	}

	if len(tokenAuthenticators) > 0 {
		// Union the token authenticators
		tokenAuth := tokenunion.New(tokenAuthenticators...)
		// Optionally cache authentication results
		if config.TokenSuccessCacheTTL > 0 || config.TokenFailureCacheTTL > 0 {
			tokenAuth = tokencache.New(tokenAuth, true, config.TokenSuccessCacheTTL, config.TokenFailureCacheTTL)
		}
		authenticators = append(authenticators, bearertoken.New(tokenAuth), websocket.NewProtocolAuthenticator(tokenAuth))
		securityDefinitions["BearerToken"] = &spec.SecurityScheme{
			SecuritySchemeProps: spec.SecuritySchemeProps{
				Type:        "apiKey",
				Name:        "authorization",
				In:          "header",
				Description: "Bearer Token authentication",
			},
		}
	}

	if len(authenticators) == 0 {
		if config.Anonymous {
			return anonymous.NewAuthenticator(), &securityDefinitions, nil
		}
		return nil, &securityDefinitions, nil
	}

	authenticator := union.New(authenticators...)

	authenticator = group.NewAuthenticatedGroupAdder(authenticator)

	if config.Anonymous {
		// If the authenticator chain returns an error, return an error (don't consider a bad bearer token
		// or invalid username/password combination anonymous).
		authenticator = union.NewFailOnError(authenticator, anonymous.NewAuthenticator())
	}

	return authenticator, &securityDefinitions, nil
}
```

认证顺序即代码执行顺序:

1. Request header, RequestHeader 认证，需配置`--requestheader-username-headers`
2. Basic auth, 账号密码认证，通过文件`--basic-auth-file=SOMEFILE`配置对应用户
3. X509, 证书认证
4. Static token, 通过文件`--token-auth-file=SOMEFILE`匹配用户
5. ServiceAccout token, 一般用于认证 Pod
6. Bootstrap token, 用于集群初始化阶段，通过配置`--experimental-bootstrap-token-auth`启用
7. OpenID Connect token, OAuth2 认证
8. Webhook token, 通过 webhook 认证 token，需配置`--authentication-token-webhook-config-file`
9. Cache auth, 通过 cache 认证
10. Anonymous， 以上认证未通过则返回匿名用户

## 总结

Apiserver 的认证方式有多种，通过源码分析每次请求都会安装固定的认证顺序执行，高 qps 下认证配置势必会影响 Apiserver 的响应延迟，需要根据集群的实际情况配置合理的认证方式。

目前在我们的线上系统，主要通过 RequestHeader(认证普通用户)，基本认证(个别系统组件)，X509（认证 kubelet），ServieceAccout（认证 Pod）进行认证，仅供参考。
