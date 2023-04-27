---
title: kubernetes扩展apiserver实现分析
author: qinng
toc: true
tags:
  - k8s
date: 2020-04-24 15:28:16
categories:
  - cloud
---

Kubernetes 提供了丰富的扩展功能，实现自定义资源有两种方式`CRD`与`Aggregation API`。相对于`CRD`，扩展 API 功能更丰富，可以实现单独的存储。今天来聊一聊，k8s 是如是实现扩展 api 的，它与 apiserver 之间又是如何协作的

<!--more-->

## AggregationApiserver 介绍

`Aggregator`类似于一个七层负载均衡，将来自用户的请求拦截转发给其他服务器，并且负责整个 APIServer 的 Discovery 功能。

通过`APIServices`对象关联到某个`Service`来进行请求的转发，其关联的`Service`类型进一步决定了请求转发形式。`Aggregator`包括一个`GenericAPIServer`和维护自身状态的`Controller`。其中 `GenericAPIServer`主要处理`apiregistration.k8s.io`组下的`APIService`资源请求。

主要 controller 包括：

1. apiserviceRegistrationController：负责`APIServices`中资源的注册与删除；
2. availableConditionController：维护`APIServices`的可用状态，包括其引用`Service`是否可用等；
3. autoRegistrationController：用于保持 API 中存在的一组特定的`APIServices`；
4. crdRegistrationController：负责将`CRD GroupVersions`自动注册到`APIServices`中；
5. openAPIAggregationController：将`APIServices`资源的变化同步至提供的`OpenAPI`文档；

在 kube-apiserver 中需要增加以下配置来开启 API Aggregation：

```
--proxy-client-cert-file=/etc/kubernetes/certs/proxy.crt
--proxy-client-key-file=/etc/kubernetes/certs/proxy.key
--requestheader-client-ca-file=/etc/kubernetes/certs/proxy-ca.crt
--requestheader-extra-headers-prefix=X-Remote-Extra-
--requestheader-group-headers=X-Remote-Group
--requestheader-username-headers=X-Remote-User
```

如果 kube-proxy 没有和 API server 运行在同一台主机上，那么需要确保启用了如下 apiserver 标记：

```
--enable-aggregator-routing=true
```

在[apiserver 启动流程](./kube-apiserver-start.md)中，分析了`AggregationApiserver`的初始化流程, 需要了解的可以回去看下。

## AggregationApiserver 认证流程

与自定义资源定义（CRD）不同，除标准的 Kubernetes apiserver 外，Aggregation API 还涉及另一个服务器：扩展 apiserver。Kubernetes apiserver 将需要与您的扩展 apiserver 通信，并且您的扩展 apiserver 也需要与 Kubernetes apiserver 通信。为了确保此通信的安全，Kubernetes apiserver 使用 x509 证书向扩展 apiserver 认证。

AggregationApi 的请求链路如下：

```
defaultHandlerChain->aggregator->aggregation-apiserver->aggregator->user
```

大致流程如下：

1. Kubernetes apiserver：对发出请求的用户身份认证，并对请求的 API 路径执行鉴权。
2. Kubernetes apiserver：将请求转发到扩展 apiserver
3. 扩展 apiserver：认证来自 Kubernetes apiserver 的请求
4. 扩展 apiserver：对来自原始用户的请求鉴权
5. 扩展 apiserver：执行对应操作返回

如图所示：
[aggregation-apiserver-auth](https://d33wubrfki0l68.cloudfront.net/3c5428678a95c3715894011d8dd4812d2cf229b9/e745c/images/docs/aggregation-api-auth-flow.png)

apiserver 与扩展 apiserver 通过证书认证,

- apiserver 配置`porxy-client`证书(使用 requestheader 根证书签发)，扩展 apiserver 配置`reqeustheader`根证书，如果没配置，会默认从 configmap `kube-system/extension-apiserver-authentication` 去找
- 扩展 apiserver 通过`extension-apiserver-authentication`获取 apiserver 的`client-ca`，生成证书对，apiserver 可以使用`client-ca`验证它
- 由于 apiserver->扩展 apiserver 通过`reqeustheader`方式认证，apiserver 会将接受到的请求经过认证，转换为 header，扩展 apiserver 通过 header 获取用户，再通过 apiserver 接口做权限校验。

有同学有疑问，为什么这里需要做两次认证，两次鉴权。这是由于扩展 apiserveer 是一个单独的服务器，如果接受非 apiserver 的请求也是需要做认证鉴权的。那能不能认证是 apiserver 后就不做鉴权了呢，这得需要 apiserver 在转发请求时加入鉴权信息就行。

## AggregationApiserver 处理流程

### apiserver 处理逻辑

在 apiserver 认证时，认证接受会将认证信息删除, 可参考前面的[apiserver 认证源码分析]

处理逻辑如下：

1. 通过`context`获取 user 信息
2. 构造请求，删除 reqeustheader 信息，通过 user 重新填充
3. 通过`proxyRoundTripper`转发请求

(kube-apiserver-authentication-code.md)
aggregation 的[hander](https://github.com/kubernetes/kubernetes/blob/df9b4e92e84849e2b9fdb5b4849c9c4ebfae8040/staging/src/k8s.io/kube-aggregator/pkg/apiserver/handler_proxy.go#L109)的实现：

```go
// 通过context获取user
	user, ok := genericapirequest.UserFrom(req.Context())
	if !ok {
		proxyError(w, req, "missing user", http.StatusInternalServerError)
		return
  }
  // 构造请求url,通过apiservice配置的service/namespace随机得到某个endpoint后端
  location := &url.URL{}
	location.Scheme = "https"
	rloc, err := r.serviceResolver.ResolveEndpoint(handlingInfo.serviceNamespace, handlingInfo.serviceName, handlingInfo.servicePort)
	if err != nil {
		klog.Errorf("error resolving %s/%s: %v", handlingInfo.serviceNamespace, handlingInfo.serviceName, err)
		proxyError(w, req, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	location.Host = rloc.Host
	location.Path = req.URL.Path
  location.RawQuery = req.URL.Query().Encode()

  // we need to wrap the roundtripper in another roundtripper which will apply the front proxy headers
  // 包裹请求信息，将user信息放到header中
	proxyRoundTripper, upgrade, err := maybeWrapForConnectionUpgrades(handlingInfo.restConfig, handlingInfo.proxyRoundTripper, req)
	if err != nil {
		proxyError(w, req, err.Error(), http.StatusInternalServerError)
		return
	}
  proxyRoundTripper = transport.NewAuthProxyRoundTripper(user.GetName(), user.GetGroups(), user.GetExtra(), proxyRoundTripper)

  // 调用后端
  handler := proxy.NewUpgradeAwareHandler(location, proxyRoundTripper, true, upgrade, &responder{w: w})
	handler.ServeHTTP(w, newReq)
```

根据扩展 apiserver 找到后端时通过 service 获取对应 endpoint 列表，随机选择某个 endpoint、
实现如下：

```go
// ResourceLocation returns a URL to which one can send traffic for the specified service.
func ResolveEndpoint(services listersv1.ServiceLister, endpoints listersv1.EndpointsLister, namespace, id string, port int32) (*url.URL, error) {
	svc, err := services.Services(namespace).Get(id)
	if err != nil {
		return nil, err
	}

	svcPort, err := findServicePort(svc, port)
	if err != nil {
		return nil, err
	}

	switch {
	case svc.Spec.Type == v1.ServiceTypeClusterIP, svc.Spec.Type == v1.ServiceTypeLoadBalancer, svc.Spec.Type == v1.ServiceTypeNodePort:
		// these are fine
	default:
		return nil, fmt.Errorf("unsupported service type %q", svc.Spec.Type)
	}

	eps, err := endpoints.Endpoints(namespace).Get(svc.Name)
	if err != nil {
		return nil, err
	}
	if len(eps.Subsets) == 0 {
		return nil, errors.NewServiceUnavailable(fmt.Sprintf("no endpoints available for service %q", svc.Name))
	}

	// Pick a random Subset to start searching from.
	ssSeed := rand.Intn(len(eps.Subsets))

	// Find a Subset that has the port.
	for ssi := 0; ssi < len(eps.Subsets); ssi++ {
		ss := &eps.Subsets[(ssSeed+ssi)%len(eps.Subsets)]
		if len(ss.Addresses) == 0 {
			continue
		}
		for i := range ss.Ports {
			if ss.Ports[i].Name == svcPort.Name {
				// Pick a random address.
				// 核心，随机选择endpoint
				ip := ss.Addresses[rand.Intn(len(ss.Addresses))].IP
				port := int(ss.Ports[i].Port)
				return &url.URL{
					Scheme: "https",
					Host:   net.JoinHostPort(ip, strconv.Itoa(port)),
				}, nil
			}
		}
	}
	return nil, errors.NewServiceUnavailable(fmt.Sprintf("no endpoints available for service %q", id))
}
```

ProxyRoundTripper 创建在[round_trippers.go](https://github.com/kubernetes/kubernetes/blob/a42e029e6905bee5b9d5489610c4fbe5988eeac6/staging/src/k8s.io/client-go/transport/round_trippers.go#L101)

```go
func NewAuthProxyRoundTripper(username string, groups []string, extra map[string][]string, rt http.RoundTripper) http.RoundTripper {
	return &authProxyRoundTripper{
		username: username,
		groups:   groups,
		extra:    extra,
		rt:       rt,
	}
}

func (rt *authProxyRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
  req = utilnet.CloneRequest(req)
  // 包裹user信息
	SetAuthProxyHeaders(req, rt.username, rt.groups, rt.extra)

	return rt.rt.RoundTrip(req)
}

// SetAuthProxyHeaders stomps the auth proxy header fields.  It mutates its argument.
func SetAuthProxyHeaders(req *http.Request, username string, groups []string, extra map[string][]string) {
  // 清楚原始url的requestheader信息
	req.Header.Del("X-Remote-User")
	req.Header.Del("X-Remote-Group")
	for key := range req.Header {
		if strings.HasPrefix(strings.ToLower(key), strings.ToLower("X-Remote-Extra-")) {
			req.Header.Del(key)
		}
	}

  // 通过user重新填充信息
	req.Header.Set("X-Remote-User", username)
	for _, group := range groups {
		req.Header.Add("X-Remote-Group", group)
	}
	for key, values := range extra {
		for _, value := range values {
			req.Header.Add("X-Remote-Extra-"+headerKeyEscape(key), value)
		}
	}
}


```

### 扩展 apiserver 处理逻辑

下以 metrics-server 为例说明扩展 apiserver 在收到 apiserver 请求后的处理

与 apiserver 初始化相同，metrics-server 也需要初始化生成`genericServer`, 然后注册 apigroup
`pkg/metrics-server/config.go`

```go
func (c Config) Complete() (*MetricsServer, error) {
	informer, err := c.informer()
	if err != nil {
		return nil, err
	}
	kubeletClient, err := c.kubeletClient()
	if err != nil {
		return nil, err
	}
	addressResolver := c.addressResolver()

	// 创建scraper，负责抓取监控数据
	scrape := scraper.NewScraper(informer.Core().V1().Nodes().Lister(), kubeletClient, addressResolver, c.ScrapeTimeout)

	scraper.RegisterScraperMetrics(c.ScrapeTimeout)
	RegisterServerMetrics(c.MetricResolution)

	// 生成genericServer, 包裹有 DefaultBuildHandlerChain
	genericServer, err := c.Apiserver.Complete(informer).New("metrics-server", genericapiserver.NewEmptyDelegate())
	if err != nil {
		return nil, err
	}

	store := storage.NewStorage()
	// 注册api
	if err := api.Install(store, informer.Core().V1(), genericServer); err != nil {
		return nil, err
	}
	return &MetricsServer{
		GenericAPIServer: genericServer,
		storage:          store,
		scraper:          scrape,
		resolution:       c.MetricResolution,
	}, nil
}
```

api 注册代码，通过`Build`生成 apigroup，调用`InstallAPIGroup`进行注册
`pkg/api/install.go`

```go
// InstallStorage builds the metrics for the metrics.k8s.io API, and then installs it into the given API metrics-server.
func Install(metrics MetricsGetter, informers coreinf.Interface, server *genericapiserver.GenericAPIServer) error {
	info := Build(metrics, informers)
	// 注册apigroup
	return server.InstallAPIGroup(&info)
}

// Build constructs APIGroupInfo the metrics.k8s.io API group using the given getters.
func Build(m MetricsGetter, informers coreinf.Interface) genericapiserver.APIGroupInfo {
	apiGroupInfo := genericapiserver.NewDefaultAPIGroupInfo(metrics.GroupName, Scheme, metav1.ParameterCodec, Codecs)

	// 注册metrics相关api
	node := newNodeMetrics(metrics.Resource("nodemetrics"), m, informers.Nodes().Lister())
	pod := newPodMetrics(metrics.Resource("podmetrics"), m, informers.Pods().Lister())
	metricsServerResources := map[string]rest.Storage{
		"nodes": node,
		"pods":  pod,
	}
	apiGroupInfo.VersionedResourcesStorageMap[v1beta1.SchemeGroupVersion.Version] = metricsServerResources

	return apiGroupInfo
}
```

同 apiserver，metrics-server 收到请求后会经过`DefaultBuildHandlerChain`

- 认证，从 apiserver 转发来的请求是`reqeustheader`形式，metrics-server 会使用`requestheader-ca`验证证书
- 鉴权，同 apiserver 一样

> 注意, 如果 apiserver 未配置`proxy-client`证书，metrics-server 认证不通过，即使 apiserver 认证通过，metrics-server 也会认为是匿名用户`system:anonymous`

最后，metrics-server 执行具体逻辑，返回结果。

## 总结

扩容 apiserver 的创建，处理流程与 apiserver 完全一样，可以直接调用 apiserver 的库，扩展 apiserver 直接处理请求，不需要经过 webhook，性能更好，更强大的是完全不使用 etcd，替换成时序数据库或者其他数据库。后续可以分析下 CRD 与扩展 apiserver 的区别以及使用场景。
