---
title: kube-apiserver启动流程分析
author: qinng
toc: true
tags:
  - k8s
date: 2020-04-24 15:28:16
categories:
  - cloud
---

kube-apiserver 共由 3 个组件构成（Aggregator. KubeAPIServer. APIExtensionServer），这些组件依次通过 Delegation 处理请求：

- Aggregator：暴露的功能类似于一个七层负载均衡，将来自用户的请求拦截转发给其他服务器，并且负责整个 APIServer 的 Discovery 功能；也负责处理 ApiService，注册对应的扩展 api。
- KubeAPIServer ：负责对请求的一些通用处理，认证. 鉴权等，以及处理各个内建资源的 REST 服务；
- APIExtensionServer：主要处理 CustomResourceDefinition（CRD）和 CustomResource（CR）的 REST 请求，也是 Delegation 的最后一环，如果对应 CR 不能被处理的话则会返回 404。

## kube-apiserver 启动流程

Apiserver 通过`Run`方法启动, 主要逻辑为：

1. 调用`CreateServerChain`构建服务调用链并判断是否启动非安全的`httpserver`，`httpserver`链中包含 apiserver 要启动的三个 server，以及为每个 server 注册对应资源的路由；
2. 调用`server.PrepareRun`进行服务运行前的准备，该方法主要完成了健康检查. 存活检查和 OpenAPI 路由的注册工作；
3. 调用`prepared.Run`启动 server；

```go
// Run runs the specified APIServer.  This should never exit.
func Run(completeOptions completedServerRunOptions, stopCh <-chan struct{}) error {
	// To help debugging, immediately log version
	klog.Infof("Version: %+v", version.Get())

  // 创建调用链
	server, err := CreateServerChain(completeOptions, stopCh)
	if err != nil {
		return err
	}

  // 进行一些准备工作， 注册一些hander，执行hook等
	prepared, err := server.PrepareRun()
	if err != nil {
		return err
	}

  // 开始执行
	return prepared.Run(stopCh)
}
```

执行具体的`Run`方法

```go
// Run spawns the secure http server. It only returns if stopCh is closed
// or the secure port cannot be listened on initially.
func (s preparedGenericAPIServer) Run(stopCh <-chan struct{}) error {
	delayedStopCh := make(chan struct{})

	go func() {
		defer close(delayedStopCh)

		<-stopCh

		// As soon as shutdown is initiated, /readyz should start returning failure.
		// This gives the load balancer a window defined by ShutdownDelayDuration to detect that /readyz is red
		// and stop sending traffic to this server.
		// 当终止时，关闭readiness
		close(s.readinessStopCh)

		time.Sleep(s.ShutdownDelayDuration)
	}()

	// 执行非阻塞Run
	// close socket after delayed stopCh
	err := s.NonBlockingRun(delayedStopCh)
	if err != nil {
		return err
	}

	<-stopCh

	// run shutdown hooks directly. This includes deregistering from the kubernetes endpoint in case of kube-apiserver.
	// 关闭前执行一些hook操作
	err = s.RunPreShutdownHooks()
	if err != nil {
		return err
	}

	// wait for the delayed stopCh before closing the handler chain (it rejects everything after Wait has been called).
	<-delayedStopCh

	// 等待所有请求执行完
	// Wait for all requests to finish, which are bounded by the RequestTimeout variable.
	s.HandlerChainWaitGroup.Wait()

	return nil
}
```

执行`NonBlockingRun`
`k8s.io/kubernetes/staging/src/k8s.io/apiserver/pkg/server/genericapiserver.go:351`

```go
func (s preparedGenericAPIServer) NonBlockingRun(stopCh <-chan struct{}) error {
    auditStopCh := make(chan struct{})

    // 1. 判断是否要启动审计日志
    if s.AuditBackend != nil {
        if err := s.AuditBackend.Run(auditStopCh); err != nil {
            return fmt.Errorf("failed to run the audit backend: %v", err)
        }
    }

    // 2. 启动 https server
    internalStopCh := make(chan struct{})
    var stoppedCh <-chan struct{}
    if s.SecureServingInfo != nil && s.Handler != nil {
        var err error
        stoppedCh, err = s.SecureServingInfo.Serve(s.Handler, s.ShutdownTimeout, internalStopCh)
        if err != nil {
            close(internalStopCh)
            close(auditStopCh)
            return err
        }
    }

    go func() {
        <-stopCh
        close(s.readinessStopCh)
        close(internalStopCh)
        if stoppedCh != nil {
            <-stoppedCh
        }
        s.HandlerChainWaitGroup.Wait()
        close(auditStopCh)
    }()

    // 3. 执行 postStartHooks
    s.RunPostStartHooks(stopCh)

    // 4. 向 systemd 发送 ready 信号
    if _, err := systemd.SdNotify(true, "READY=1\n"); err != nil {
        klog.Errorf("Unable to send systemd daemon successful start message: %v\n", err)
    }

    return nil
}
```

## 调用链分析

上一节简单分析了 Apiserver 的启动流程，通过初始化各种配置，封装调用链，启动 Server。这节主要分析调用链。

初始化阶段, 通过`CreateServerChain`创建调用链， 代码在[server.go](https://github.com/kubernetes/kubernetes/blob/1d057da2f73118893b5cc27c15d59ff03beb271e/cmd/kube-apiserver/app/server.go#L169)

```go
// CreateServerChain creates the apiservers connected via delegation.
func CreateServerChain(completedOptions completedServerRunOptions, stopCh <-chan struct{}) (*aggregatorapiserver.APIAggregator, error) {
  // nodetunneler与node通信，proxy实现代理功能，转发请求给其他apiservice
  // apiserver到cluster的通信可以通过三种方法
  // apiserver到kubelet的endpoint，用于logs功能，exec功能，port-forward功能
  // HTTP连接，即使可以用HTTPS也不做任何其他校验，并不安全
  // ssh tunnel，不推荐使用

  nodeTunneler, proxyTransport, err := CreateNodeDialer(completedOptions)
    // 1. 为 kubeAPIServer 创建配置
    kubeAPIServerConfig, insecureServingInfo, serviceResolver, pluginInitializer, admissionPostStartHook, err :=                                         CreateKubeAPIServerConfig(completedOptions, nodeTunneler, proxyTransport)
    if err != nil {
        return nil, err
    }

    // 2. 判断是否配置了 APIExtensionsServer，创建 apiExtensionsConfig
    apiExtensionsConfig, err := createAPIExtensionsConfig(*kubeAPIServerConfig.GenericConfig, kubeAPIServerConfig.ExtraConfig.VersionedInformers,        pluginInitializer, completedOptions.ServerRunOptions, completedOptions.MasterCount,vc
        serviceResolver, webhook.NewDefaultAuthenticationInfoResolverWrapper(proxyTransport, kubeAPIServerConfig.GenericConfig.LoopbackClientConfig))
    if err != nil {
        return nil, err
    }

    // 3. 初始化 APIExtensionsServer, 通过一个空的delegate初始化
    apiExtensionsServer, err := createAPIExtensionsServer(apiExtensionsConfig, genericapiserver.NewEmptyDelegate())
    if err != nil {
        return nil, err
    }

    // 4. 初始化 KubeAPIServer
    kubeAPIServer, err := CreateKubeAPIServer(kubeAPIServerConfig, apiExtensionsServer.GenericAPIServer, admissionPostStartHook)
    if err != nil {
        return nil, err
    }

    // 5. 创建 AggregatorConfig
    aggregatorConfig, err := createAggregatorConfig(*kubeAPIServerConfig.GenericConfig, completedOptions.ServerRunOptions, kubeAPIServerConfig.          ExtraConfig.VersionedInformers, serviceResolver, proxyTransport, pluginInitializer)
    if err != nil {
        return nil, err
    }

    // 6. 初始化 AggregatorServer
    aggregatorServer, err := createAggregatorServer(aggregatorConfig, kubeAPIServer.GenericAPIServer, apiExtensionsServer.Informers)
    if err != nil {
        return nil, err
    }

    // 7. 判断是否启动非安全端口的 http server
    if insecureServingInfo != nil {
        insecureHandlerChain := kubeserver.BuildInsecureHandlerChain(aggregatorServer.GenericAPIServer.UnprotectedHandler(), kubeAPIServerConfig.GenericConfig)
        if err := insecureServingInfo.Serve(insecureHandlerChain, kubeAPIServerConfig.GenericConfig.RequestTimeout, stopCh); err != nil {
            return nil, err
        }
    }
    return aggregatorServer, nil
}
```

创建过程主要有以下步骤：

1. 根据配置构造 apiserver 的配置，调用方法`CreateKubeAPIServerConfig`
2. 根据配置构造扩展的 apiserver 的配置，调用方法为`createAPIExtensionsConfig`
3. 创建 server，包括扩展的 apiserver 和原生的 apiserver，调用方法为`createAPIExtensionsServer`和`CreateKubeAPIServer`。主要就是将各个 handler 的路由方法注册到 Container 中去，完全遵循 go-restful 的设计模式，即将处理方法注册到 Route 中去，同一个根路径下的 Route 注册到 WebService 中去，WebService 注册到 Container 中，Container 负责分发。访问的过程为`Container-->WebService-->Route`
4. 聚合 server 的配置和和创建。主要就是将原生的 apiserver 和扩展的 apiserver 的访问进行整合，添加后续的一些处理接口。调用方法为`createAggregatorConfig`和`createAggregatorServer`
5. 创建完成，返回配置的 server 信息

以上几个步骤，最核心的就是 apiserver 如何创建，即如何按照 go-restful 的模式，添加路由和相应的处理方法。

### 配置初始化

先看 apiserver 配置的创建`CreateKubeAPIServerConfig->buildGenericConfig->genericapiserver.NewConfig`

```go
// BuildGenericConfig takes the master server options and produces the genericapiserver.Config associated with it
func buildGenericConfig(
	s *options.ServerRunOptions,
	proxyTransport *http.Transport,
) (
	genericConfig *genericapiserver.Config,
	versionedInformers clientgoinformers.SharedInformerFactory,
	insecureServingInfo *genericapiserver.DeprecatedInsecureServingInfo,
	serviceResolver aggregatorapiserver.ServiceResolver,
	pluginInitializers []admission.PluginInitializer,
	admissionPostStartHook genericapiserver.PostStartHookFunc,
	storageFactory *serverstorage.DefaultStorageFactory,
	lastErr error,
) {
	// 创建genericConfig,其中包括DefaultBuildHandlerChain，一系列认证授权的中间件
	genericConfig = genericapiserver.NewConfig(legacyscheme.Codecs)
	genericConfig.MergedResourceConfig = master.DefaultAPIResourceConfigSource()

	// 初始化各种配置
	if lastErr = s.GenericServerRunOptions.ApplyTo(genericConfig); lastErr != nil {
		return
	}
	// ...

	genericConfig.OpenAPIConfig = genericapiserver.DefaultOpenAPIConfig(generatedopenapi.GetOpenAPIDefinitions, openapinamer.NewDefinitionNamer(legacyscheme.Scheme, extensionsapiserver.Scheme, aggregatorscheme.Scheme))
	genericConfig.OpenAPIConfig.Info.Title = "Kubernetes"
	// 长连接请求
	genericConfig.LongRunningFunc = filters.BasicLongRunningRequestCheck(
		sets.NewString("watch", "proxy"),
		sets.NewString("attach", "exec", "proxy", "log", "portforward"),
	)

	kubeVersion := version.Get()
	genericConfig.Version = &kubeVersion

	// 初始化storageFactory， 用来连接etcd
	storageFactoryConfig := kubeapiserver.NewStorageFactoryConfig()
	storageFactoryConfig.APIResourceConfig = genericConfig.MergedResourceConfig
	completedStorageFactoryConfig, err := storageFactoryConfig.Complete(s.Etcd)
	if err != nil {
		lastErr = err
		return
	}
	storageFactory, lastErr = completedStorageFactoryConfig.New()
	if lastErr != nil {
		return
	}
	if genericConfig.EgressSelector != nil {
		storageFactory.StorageConfig.Transport.EgressLookup = genericConfig.EgressSelector.Lookup
	}
	if lastErr = s.Etcd.ApplyWithStorageFactoryTo(storageFactory, genericConfig); lastErr != nil {
		return
	}

	// Use protobufs for self-communication.
	// Since not every generic apiserver has to support protobufs, we
	// cannot default to it in generic apiserver and need to explicitly
	// set it in kube-apiserver.
	// 内部使用protobufs通信
	genericConfig.LoopbackClientConfig.ContentConfig.ContentType = "application/vnd.kubernetes.protobuf"
	// Disable compression for self-communication, since we are going to be
	// on a fast local network
	genericConfig.LoopbackClientConfig.DisableCompression = true

	// clientset初始化
	kubeClientConfig := genericConfig.LoopbackClientConfig
	clientgoExternalClient, err := clientgoclientset.NewForConfig(kubeClientConfig)
	if err != nil {
		lastErr = fmt.Errorf("failed to create real external clientset: %v", err)
		return
	}
	versionedInformers = clientgoinformers.NewSharedInformerFactory(clientgoExternalClient, 10*time.Minute)

	// 初始化认证实例，支持多种认证方式：requestheader,token, tls等
	genericConfig.Authentication.Authenticator, genericConfig.OpenAPIConfig.SecurityDefinitions, err = BuildAuthenticator(s, genericConfig.EgressSelector, clientgoExternalClient, versionedInformers)
	if err != nil {
		lastErr = fmt.Errorf("invalid authentication config: %v", err)
		return
	}

	// 初始化鉴权配置
	genericConfig.Authorization.Authorizer, genericConfig.RuleResolver, err = BuildAuthorizer(s, genericConfig.EgressSelector, versionedInformers)
	if err != nil {
		lastErr = fmt.Errorf("invalid authorization config: %v", err)
		return
	}
	if !sets.NewString(s.Authorization.Modes...).Has(modes.ModeRBAC) {
		genericConfig.DisabledPostStartHooks.Insert(rbacrest.PostStartHookName)
	}

	// 初始化admission webhook的配置
	admissionConfig := &kubeapiserveradmission.Config{
		ExternalInformers:    versionedInformers,
		LoopbackClientConfig: genericConfig.LoopbackClientConfig,
		CloudConfigFile:      s.CloudProvider.CloudConfigFile,
	}
	serviceResolver = buildServiceResolver(s.EnableAggregatorRouting, genericConfig.LoopbackClientConfig.Host, versionedInformers)

	authInfoResolverWrapper := webhook.NewDefaultAuthenticationInfoResolverWrapper(proxyTransport, genericConfig.EgressSelector, genericConfig.LoopbackClientConfig)

	lastErr = s.Audit.ApplyTo(
		genericConfig,
		genericConfig.LoopbackClientConfig,
		versionedInformers,
		serveroptions.NewProcessInfo("kube-apiserver", "kube-system"),
		&serveroptions.WebhookOptions{
			AuthInfoResolverWrapper: authInfoResolverWrapper,
			ServiceResolver:         serviceResolver,
		},
	)
	if lastErr != nil {
		return
	}

	// 初始化注入插件
	pluginInitializers, admissionPostStartHook, err = admissionConfig.New(proxyTransport, genericConfig.EgressSelector, serviceResolver)
	if err != nil {
		lastErr = fmt.Errorf("failed to create admission plugin initializer: %v", err)
		return
	}

	err = s.Admission.ApplyTo(
		genericConfig,
		versionedInformers,
		kubeClientConfig,
		feature.DefaultFeatureGate,
		pluginInitializers...)
	if err != nil {
		lastErr = fmt.Errorf("failed to initialize admission: %v", err)
	}

	if utilfeature.DefaultFeatureGate.Enabled(genericfeatures.APIPriorityAndFairness) && s.GenericServerRunOptions.EnablePriorityAndFairness {
		genericConfig.FlowControl = BuildPriorityAndFairness(s, clientgoExternalClient, versionedInformers)
	}

	return
}
```

### APIExtensionsServer 初始化

`APIExtensionsServer`最先初始化，在调用链的末尾, 处理 CR、CRD 相关资源.

其中包含的 controller 以及功能如下所示：

1. openapiController：将 crd 资源的变化同步至提供的 OpenAPI 文档，可通过访问 /openapi/v2 进行查看；
2. crdController：负责将 crd 信息注册到 apiVersions 和 apiResources 中，两者的信息可通过 $ kubectl api-versions 和 $ kubectl api-resources 查看；
3. namingController：检查 crd obj 中是否有命名冲突，可在 crd .status.conditions 中查看；
4. establishingController：检查 crd 是否处于正常状态，可在 crd .status.conditions 中查看；
5. nonStructuralSchemaController：检查 crd obj 结构是否正常，可在 crd .status.conditions 中查看；
6. apiApprovalController：检查 crd 是否遵循 kubernetes API 声明策略，可在 crd .status.conditions 中查看；
7. finalizingController：类似于 finalizes 的功能，与 CRs 的删除有关；

`createAPIExtensionsServer`调用`apiextensionsConfig.Complete().New(delegateAPIServer)`

`k8s.io/kubernetes/staging/src/k8s.io/apiextensions-apiserver/pkg/apiserver/apiserver.go:132`

```go
/ New returns a new instance of CustomResourceDefinitions from the given config.
func (c completedConfig) New(delegationTarget genericapiserver.DelegationTarget) (*CustomResourceDefinitions, error) {
	// 初始化 genericServer
	genericServer, err := c.GenericConfig.New("apiextensions-apiserver", delegationTarget)
	if err != nil {
		return nil, err
	}

	s := &CustomResourceDefinitions{
		GenericAPIServer: genericServer,
	}

	// 初始化apigroup, 即需要暴露的api，这里extension apiserver只注册了cr于crd相关的
	apiResourceConfig := c.GenericConfig.MergedResourceConfig
	apiGroupInfo := genericapiserver.NewDefaultAPIGroupInfo(apiextensions.GroupName, Scheme, metav1.ParameterCodec, Codecs)
	if apiResourceConfig.VersionEnabled(v1beta1.SchemeGroupVersion) {
		storage := map[string]rest.Storage{}
		// customresourcedefinitions
		customResourceDefintionStorage := customresourcedefinition.NewREST(Scheme, c.GenericConfig.RESTOptionsGetter)
		storage["customresourcedefinitions"] = customResourceDefintionStorage
		storage["customresourcedefinitions/status"] = customresourcedefinition.NewStatusREST(Scheme, customResourceDefintionStorage)

		apiGroupInfo.VersionedResourcesStorageMap[v1beta1.SchemeGroupVersion.Version] = storage
	}
	if apiResourceConfig.VersionEnabled(v1.SchemeGroupVersion) {
		storage := map[string]rest.Storage{}
		// customresourcedefinitions
		customResourceDefintionStorage := customresourcedefinition.NewREST(Scheme, c.GenericConfig.RESTOptionsGetter)
		storage["customresourcedefinitions"] = customResourceDefintionStorage
		storage["customresourcedefinitions/status"] = customresourcedefinition.NewStatusREST(Scheme, customResourceDefintionStorage)

		apiGroupInfo.VersionedResourcesStorageMap[v1.SchemeGroupVersion.Version] = storage
	}

	// 注册apigroup
	if err := s.GenericAPIServer.InstallAPIGroup(&apiGroupInfo); err != nil {
		return nil, err
	}

	// clientset创建
	crdClient, err := clientset.NewForConfig(s.GenericAPIServer.LoopbackClientConfig)
	if err != nil {
		// it's really bad that this is leaking here, but until we can fix the test (which I'm pretty sure isn't even testing what it wants to test),
		// we need to be able to move forward
		return nil, fmt.Errorf("failed to create clientset: %v", err)
	}
	s.Informers = externalinformers.NewSharedInformerFactory(crdClient, 5*time.Minute)

	// 创建各种handler
	delegateHandler := delegationTarget.UnprotectedHandler()
	if delegateHandler == nil {
		delegateHandler = http.NotFoundHandler()
	}

	versionDiscoveryHandler := &versionDiscoveryHandler{
		discovery: map[schema.GroupVersion]*discovery.APIVersionHandler{},
		delegate:  delegateHandler,
	}
	groupDiscoveryHandler := &groupDiscoveryHandler{
		discovery: map[string]*discovery.APIGroupHandler{},
		delegate:  delegateHandler,
	}
	establishingController := establish.NewEstablishingController(s.Informers.Apiextensions().V1().CustomResourceDefinitions(), crdClient.ApiextensionsV1())
	crdHandler, err := NewCustomResourceDefinitionHandler(
		versionDiscoveryHandler,
		groupDiscoveryHandler,
		s.Informers.Apiextensions().V1().CustomResourceDefinitions(),
		delegateHandler,
		c.ExtraConfig.CRDRESTOptionsGetter,
		c.GenericConfig.AdmissionControl,
		establishingController,
		c.ExtraConfig.ServiceResolver,
		c.ExtraConfig.AuthResolverWrapper,
		c.ExtraConfig.MasterCount,
		s.GenericAPIServer.Authorizer,
		c.GenericConfig.RequestTimeout,
		time.Duration(c.GenericConfig.MinRequestTimeout)*time.Second,
		apiGroupInfo.StaticOpenAPISpec,
		c.GenericConfig.MaxRequestBodyBytes,
	)
	if err != nil {
		return nil, err
	}
	s.GenericAPIServer.Handler.NonGoRestfulMux.Handle("/apis", crdHandler)
	s.GenericAPIServer.Handler.NonGoRestfulMux.HandlePrefix("/apis/", crdHandler)

	discoveryController := NewDiscoveryController(s.Informers.Apiextensions().V1().CustomResourceDefinitions(), versionDiscoveryHandler, groupDiscoveryHandler)
	namingController := status.NewNamingConditionController(s.Informers.Apiextensions().V1().CustomResourceDefinitions(), crdClient.ApiextensionsV1())
	nonStructuralSchemaController := nonstructuralschema.NewConditionController(s.Informers.Apiextensions().V1().CustomResourceDefinitions(), crdClient.ApiextensionsV1())
	apiApprovalController := apiapproval.NewKubernetesAPIApprovalPolicyConformantConditionController(s.Informers.Apiextensions().V1().CustomResourceDefinitions(), crdClient.ApiextensionsV1())
	finalizingController := finalizer.NewCRDFinalizer(
		s.Informers.Apiextensions().V1().CustomResourceDefinitions(),
		crdClient.ApiextensionsV1(),
		crdHandler,
	)
	openapiController := openapicontroller.NewController(s.Informers.Apiextensions().V1().CustomResourceDefinitions())

	// 加入到启动hook中
	s.GenericAPIServer.AddPostStartHookOrDie("start-apiextensions-informers", func(context genericapiserver.PostStartHookContext) error {
		s.Informers.Start(context.StopCh)
		return nil
	})
	s.GenericAPIServer.AddPostStartHookOrDie("start-apiextensions-controllers", func(context genericapiserver.PostStartHookContext) error {
		// OpenAPIVersionedService and StaticOpenAPISpec are populated in generic apiserver PrepareRun().
		// Together they serve the /openapi/v2 endpoint on a generic apiserver. A generic apiserver may
		// choose to not enable OpenAPI by having null openAPIConfig, and thus OpenAPIVersionedService
		// and StaticOpenAPISpec are both null. In that case we don't run the CRD OpenAPI controller.
		if s.GenericAPIServer.OpenAPIVersionedService != nil && s.GenericAPIServer.StaticOpenAPISpec != nil {
			go openapiController.Run(s.GenericAPIServer.StaticOpenAPISpec, s.GenericAPIServer.OpenAPIVersionedService, context.StopCh)
		}

		go namingController.Run(context.StopCh)
		go establishingController.Run(context.StopCh)
		go nonStructuralSchemaController.Run(5, context.StopCh)
		go apiApprovalController.Run(5, context.StopCh)
		go finalizingController.Run(5, context.StopCh)

		discoverySyncedCh := make(chan struct{})
		go discoveryController.Run(context.StopCh, discoverySyncedCh)
		select {
		case <-context.StopCh:
		case <-discoverySyncedCh:
		}

		return nil
	})
	// we don't want to report healthy until we can handle all CRDs that have already been registered.  Waiting for the informer
	// to sync makes sure that the lister will be valid before we begin.  There may still be races for CRDs added after startup,
	// but we won't go healthy until we can handle the ones already present.
	s.GenericAPIServer.AddPostStartHookOrDie("crd-informer-synced", func(context genericapiserver.PostStartHookContext) error {
		return wait.PollImmediateUntil(100*time.Millisecond, func() (bool, error) {
			return s.Informers.Apiextensions().V1().CustomResourceDefinitions().Informer().HasSynced(), nil
		}, context.StopCh)
	})

	return s, nil
}
```

`c.GenericConfig.New`来初始化`genericapiserver`,包裹一些默认链，创建 handler

```go
func (c completedConfig) New(name string, delegationTarget DelegationTarget) (*GenericAPIServer, error) {
	if c.Serializer == nil {
		return nil, fmt.Errorf("Genericapiserver.New() called with config.Serializer == nil")
	}
	if c.LoopbackClientConfig == nil {
		return nil, fmt.Errorf("Genericapiserver.New() called with config.LoopbackClientConfig == nil")
	}
	if c.EquivalentResourceRegistry == nil {
		return nil, fmt.Errorf("Genericapiserver.New() called with config.EquivalentResourceRegistry == nil")
	}

	// 包裹了DefaultBuildHandlerChain
	handlerChainBuilder := func(handler http.Handler) http.Handler {
		return c.BuildHandlerChainFunc(handler, c.Config)
	}
	// 创建apiserverhandler
	apiServerHandler := NewAPIServerHandler(name, c.Serializer, handlerChainBuilder, delegationTarget.UnprotectedHandler())

	...

	return s, nil
}
```

`APIServerHandler`包含多种`http.Handler`类型，包括`go-restful`以及`non-go-restful`，以及在以上两者之间选择的`Director`对象，`go-restful`用于处理已经注册的 handler，`non-go-restful用来处理不存在的handler，API URI处理的选择过程为：`FullHandlerChain-> Director ->{GoRestfulContainer， NonGoRestfulMux}`。
`NewAPIServerHandler`

```
func NewAPIServerHandler(name string, s runtime.NegotiatedSerializer, handlerChainBuilder HandlerChainBuilderFn, notFoundHandler http.Handler) *APIServerHandler {
	// non-go-restful路由
	nonGoRestfulMux := mux.NewPathRecorderMux(name)
	if notFoundHandler != nil {
		nonGoRestfulMux.NotFoundHandler(notFoundHandler)
	}

	// go-resetful路由
	gorestfulContainer := restful.NewContainer()
	gorestfulContainer.ServeMux = http.NewServeMux()
	gorestfulContainer.Router(restful.CurlyRouter{}) // e.g. for proxy/{kind}/{name}/{*}
	gorestfulContainer.RecoverHandler(func(panicReason interface{}, httpWriter http.ResponseWriter) {
		logStackOnRecover(s, panicReason, httpWriter)
	})
	gorestfulContainer.ServiceErrorHandler(func(serviceErr restful.ServiceError, request *restful.Request, response *restful.Response) {
		serviceErrorHandler(s, serviceErr, request, response)
	})

	// 选择器, 根据path选择是否执行go-restful，注册过的path执行go-restful
	director := director{
		name:               name,
		goRestfulContainer: gorestfulContainer,
		nonGoRestfulMux:    nonGoRestfulMux,
	}

	return &APIServerHandler{
		FullHandlerChain:   handlerChainBuilder(director),
		GoRestfulContainer: gorestfulContainer,
		NonGoRestfulMux:    nonGoRestfulMux,
		Director:           director,
	}
}
```

以上是`APIExtensionsServer`的初始化流程，初始化 Server, 调用`s.GenericAPIServer.InstallAPIGroup`注册 api。此方法的调用链非常深，主要是为了将需要暴露的`API Resource`注册到 server 中，以便能通过 http 接口进行 resource 的 REST 操作，其他几种 server 在初始化时也都会执行对应的 `InstallAPI`方法。

### KubeAPIServer 初始化

KubeAPIServer 主要是提供对 API Resource 的操作请求，为 kubernetes 中众多 API 注册路由信息，暴露 RESTful API 并且对外提供 kubernetes service，使集群中以及集群外的服务都可以通过 RESTful API 操作 kubernetes 中的资源。

与`APIExtensionsServer`，`KubeAPIServer`初始化流程如下

1. `CreateKubeAPIServer`调用`kubeAPIServerConfig.Complete().New`来初始化
2. `New`函数创建默认的`apigroup`(pod,deployment 等内部资源), 调用`InstallAPIs`注册
3. 启动相关 controller, 加入到`poststarthook`

### AggregatorServer 初始化

`Aggregator`通过`APIServices`对象关联到某个`Service`来进行请求的转发，其关联的`Service`类型进一步决定了请求转发形式。`Aggregator`包括一个`GenericAPIServer`和维护自身状态的`Controller`。其中 `GenericAPIServer`主要处理`apiregistration.k8s.io`组下的`APIService`资源请求。

`Aggregator`除了处理资源请求外还包含几个 controller：

1. apiserviceRegistrationController：负责`APIServices`中资源的注册与删除；
2. availableConditionController：维护`APIServices`的可用状态，包括其引用`Service`是否可用等；
3. autoRegistrationController：用于保持 API 中存在的一组特定的`APIServices`；
4. crdRegistrationController：负责将`CRD GroupVersions`自动注册到`APIServices`中；
5. openAPIAggregationController：将`APIServices`资源的变化同步至提供的`OpenAPI`文档；
   kubernetes 中的一些附加组件，比如 metrics-server 就是通过 Aggregator 的方式进行扩展的，实际环境中可以通过使用 apiserver-builder 工具轻松以 Aggregator 的扩展方式创建自定义资源。

初始化 AggregatorServer 的主要逻辑为：

1. 调用`aggregatorConfig.Complete().NewWithDelegate`创建`aggregatorServer`
2. 初始化`crdRegistrationController`和`autoRegistrationController`，`crdRegistrationController`负责注册 CRD，`autoRegistrationController`负责将 CRD 对应的 APIServices 自动注册到 apiserver 中，CRD 创建后可通过`$ kubectl get apiservices`查看是否注册到 apiservices 中
3. 将`autoRegistrationController`和`crdRegistrationController`加入到 PostStartHook 中

首先，初始化配置`createAggregatorConfig`

```go
func createAggregatorConfig(
	kubeAPIServerConfig genericapiserver.Config,
	commandOptions *options.ServerRunOptions,
	externalInformers kubeexternalinformers.SharedInformerFactory,
	serviceResolver aggregatorapiserver.ServiceResolver,
	proxyTransport *http.Transport,
	pluginInitializers []admission.PluginInitializer,
) (*aggregatorapiserver.Config, error) {
	// make a shallow copy to let us twiddle a few things
	// most of the config actually remains the same.  We only need to mess with a couple items related to the particulars of the aggregator
	genericConfig := kubeAPIServerConfig
	genericConfig.PostStartHooks = map[string]genericapiserver.PostStartHookConfigEntry{}
	genericConfig.RESTOptionsGetter = nil

	// override genericConfig.AdmissionControl with kube-aggregator's scheme,
	// because aggregator apiserver should use its own scheme to convert its own resources.
	// 取消admission的配置，aggregator自行处理请求，不需要admissions
	err := commandOptions.Admission.ApplyTo(
		&genericConfig,
		externalInformers,
		genericConfig.LoopbackClientConfig,
		feature.DefaultFeatureGate,
		pluginInitializers...)
	if err != nil {
		return nil, err
	}

	// copy the etcd options so we don't mutate originals.
	etcdOptions := *commandOptions.Etcd
	etcdOptions.StorageConfig.Paging = utilfeature.DefaultFeatureGate.Enabled(features.APIListChunking)
	etcdOptions.StorageConfig.Codec = aggregatorscheme.Codecs.LegacyCodec(v1beta1.SchemeGroupVersion, v1.SchemeGroupVersion)
	etcdOptions.StorageConfig.EncodeVersioner = runtime.NewMultiGroupVersioner(v1beta1.SchemeGroupVersion, schema.GroupKind{Group: v1beta1.GroupName})
	genericConfig.RESTOptionsGetter = &genericoptions.SimpleRestOptionsFactory{Options: etcdOptions}

	// override MergedResourceConfig with aggregator defaults and registry
	if err := commandOptions.APIEnablement.ApplyTo(
		&genericConfig,
		aggregatorapiserver.DefaultAPIResourceConfigSource(),
		aggregatorscheme.Scheme); err != nil {
		return nil, err
	}

	// 配置proxy证书，用于apiserver与扩展服务的通信，使用requestheader证书签发
	var certBytes, keyBytes []byte
	if len(commandOptions.ProxyClientCertFile) > 0 && len(commandOptions.ProxyClientKeyFile) > 0 {
		certBytes, err = ioutil.ReadFile(commandOptions.ProxyClientCertFile)
		if err != nil {
			return nil, err
		}
		keyBytes, err = ioutil.ReadFile(commandOptions.ProxyClientKeyFile)
		if err != nil {
			return nil, err
		}
	}

	aggregatorConfig := &aggregatorapiserver.Config{
		GenericConfig: &genericapiserver.RecommendedConfig{
			Config:                genericConfig,
			SharedInformerFactory: externalInformers,
		},
		ExtraConfig: aggregatorapiserver.ExtraConfig{
			ProxyClientCert: certBytes,
			ProxyClientKey:  keyBytes,
			ServiceResolver: serviceResolver,
			// 代理请求的具体实现
			ProxyTransport:  proxyTransport,
		},
	}

	// we need to clear the poststarthooks so we don't add them multiple times to all the servers (that fails)
	// 加入PostStartHook
	aggregatorConfig.GenericConfig.PostStartHooks = map[string]genericapiserver.PostStartHookConfigEntry{}

	return aggregatorConfig, nil
}
```

`createAggregatorServer`初始化`Aggregator`

```go
func createAggregatorServer(aggregatorConfig *aggregatorapiserver.Config, delegateAPIServer genericapiserver.DelegationTarget, apiExtensionInformers apiextensionsinformers.SharedInformerFactory) (*aggregatorapiserver.APIAggregator, error) {
	// 初始化配置，与前面流程相同
	aggregatorServer, err := aggregatorConfig.Complete().NewWithDelegate(delegateAPIServer)
	if err != nil {
		return nil, err
	}

	// 创建auto-registration controller
	apiRegistrationClient, err := apiregistrationclient.NewForConfig(aggregatorConfig.GenericConfig.LoopbackClientConfig)
	if err != nil {
		return nil, err
	}
	autoRegistrationController := autoregister.NewAutoRegisterController(aggregatorServer.APIRegistrationInformers.Apiregistration().V1().APIServices(), apiRegistrationClient)
	apiServices := apiServicesToRegister(delegateAPIServer, autoRegistrationController)
	crdRegistrationController := crdregistration.NewCRDRegistrationController(
		apiExtensionInformers.Apiextensions().V1().CustomResourceDefinitions(),
		autoRegistrationController)

	err = aggregatorServer.GenericAPIServer.AddPostStartHook("kube-apiserver-autoregistration", func(context genericapiserver.PostStartHookContext) error {
		// 启动controller
		go crdRegistrationController.Run(5, context.StopCh)
		go func() {
			// let the CRD controller process the initial set of CRDs before starting the autoregistration controller.
			// this prevents the autoregistration controller's initial sync from deleting APIServices for CRDs that still exist.
			// we only need to do this if CRDs are enabled on this server.  We can't use discovery because we are the source for discovery.
			if aggregatorConfig.GenericConfig.MergedResourceConfig.AnyVersionForGroupEnabled("apiextensions.k8s.io") {
				crdRegistrationController.WaitForInitialSync()
			}
			autoRegistrationController.Run(5, context.StopCh)
		}()
		return nil
	})
	if err != nil {
		return nil, err
	}

	err = aggregatorServer.GenericAPIServer.AddBootSequenceHealthChecks(
		makeAPIServiceAvailableHealthCheck(
			"autoregister-completion",
			apiServices,
			aggregatorServer.APIRegistrationInformers.Apiregistration().V1().APIServices(),
		),
	)
	if err != nil {
		return nil, err
	}

	return aggregatorServer, nil
}
```

至此，启动步骤以前分析完了，三个组件的流量大体时一样的，通过`Complete().New()`初始化配置，创建所需的 controller, 调用`InstallAPIGroup`注册`apigroup`。

## 请求分析

上面我们分析了 apiserver 的调用链，大体如下
`DefaultHandlerChain->{handler/crdhandler/proxy}->admission->validation->etcd`

1. 请求进入时，会经过`defaultchain`做一些认证鉴权工作
2. 然后通过`route`执行对应的 handler，如果为 aggration api, 将直接转发请求到对应 service
3. handler 处理完，经过 admission 与 validation，做一些修改和检查，用户在这部分可以自定义 webhook
4. 最后存入 etcd

## 总结

本文大体对 apiserver 的启动流程，以及初始化过程做了分析，由于 apiserver 实现复杂，中间一些细节没涉及到，还需要对着代码研究研究。

## 参考

- https://juejin.im/post/5c934e5a5188252d7c216981
- https://blog.tianfeiyu.com/2020/02/24/kube_apiserver/
