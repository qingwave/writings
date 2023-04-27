---
title: 深入了解kubebuilder
author: qinng
toc: true
comments: true
tags:
  - k8s
date: 2021-08-23 00:25:53
categories:
  - cloud
---

前文[快速实现一个 Kubernetes Operator](./how-to-write-a-k8s-operator)介绍了`kubebuilder`工具，快速实现了一个`Operator`。今天我们深入水下，探寻`kubebuilder`究竟是如何工作的。

<!--more-->

## 普通开发流程

如果不借助任何`Operator`脚手架，我们是如何实现`Operator`的？大体分为一下几步：

- CRD 定义
- Controller 开发，编写逻辑
- 测试部署

### API 定义

首先通过[k8s.io/code-generator](https://github.com/kubernetes/code-generator)项目生成 API 相关代码，定义相关字段。

### Controller 实现

实现 Controller 以官方提供的[sample-controller](https://github.com/kubernetes/sample-controller)为例，如图所示
![custom-controller](https://github.com/kubernetes/sample-controller/raw/master/docs/images/client-go-controller-interaction.jpeg)

主要分为以下几步：

初始化`client`配置

```go
  //通过master/kubeconfig建立client config
  cfg, err := clientcmd.BuildConfigFromFlags(masterURL, kubeconfig)
	if err != nil {
		klog.Fatalf("Error building kubeconfig: %s", err.Error())
	}

  // kubernetes client
	kubeClient, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		klog.Fatalf("Error building kubernetes clientset: %s", err.Error())
	}

  // crd client
	exampleClient, err := clientset.NewForConfig(cfg)
	if err != nil {
		klog.Fatalf("Error building example clientset: %s", err.Error())
	}
```

初始化 Informer 并启动

```go
  //k8s sharedInformer
  kubeInformerFactory := kubeinformers.NewSharedInformerFactory(kubeClient, time.Second*30)
  // crd sharedInformer
	exampleInformerFactory := informers.NewSharedInformerFactory(exampleClient, time.Second*30)

  // 初始化controller，传入informer, 注册了Deployment与Foo Informers
	controller := NewController(kubeClient, exampleClient,
		kubeInformerFactory.Apps().V1().Deployments(),
		exampleInformerFactory.Samplecontroller().V1alpha1().Foos())
  //启动Informer
	kubeInformerFactory.Start(stopCh)
	exampleInformerFactory.Start(stopCh)
```

最后启动`Controller`

```go
  if err = controller.Run(2, stopCh); err != nil {
		klog.Fatalf("Error running controller: %s", err.Error())
	}
```

在`Controller`的实现中，通过`NewController`来初始化：

```go
func NewController(
	kubeclientset kubernetes.Interface,
	sampleclientset clientset.Interface,
	deploymentInformer appsinformers.DeploymentInformer,
	fooInformer informers.FooInformer) *Controller {

	// Create event broadcaster
	utilruntime.Must(samplescheme.AddToScheme(scheme.Scheme))
	klog.V(4).Info("Creating event broadcaster")
	eventBroadcaster := record.NewBroadcaster()
	eventBroadcaster.StartStructuredLogging(0)
	eventBroadcaster.StartRecordingToSink(&typedcorev1.EventSinkImpl{Interface: kubeclientset.CoreV1().Events("")})
	recorder := eventBroadcaster.NewRecorder(scheme.Scheme, corev1.EventSource{Component: controllerAgentName})

	controller := &Controller{
		kubeclientset:     kubeclientset,
		sampleclientset:   sampleclientset,
		deploymentsLister: deploymentInformer.Lister(), //只读cache
		deploymentsSynced: deploymentInformer.Informer().HasSynced, //调用Informer()会注册informer到共享informer中
		foosLister:        fooInformer.Lister(),
		foosSynced:        fooInformer.Informer().HasSynced,
		workqueue:         workqueue.NewNamedRateLimitingQueue(workqueue.DefaultControllerRateLimiter(), "Foos"), // 初始化工作队列
		recorder:          recorder,
	}

	klog.Info("Setting up event handlers")
	// 添加回调事件
	fooInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: controller.enqueueFoo,
		UpdateFunc: func(old, new interface{}) {
			controller.enqueueFoo(new)
		},
	})

	deploymentInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: controller.handleObject,
		UpdateFunc: func(old, new interface{}) {
			newDepl := new.(*appsv1.Deployment)
			oldDepl := old.(*appsv1.Deployment)
			if newDepl.ResourceVersion == oldDepl.ResourceVersion {
				// Periodic resync will send update events for all known Deployments.
				// Two different versions of the same Deployment will always have different RVs.
				return
			}
			controller.handleObject(new)
		},
		DeleteFunc: controller.handleObject,
	})

	return controller
}
```

`Controller`启动则是典型的 k8s 工作流，通过控制循环不断从工作队列获取对象进行处理，使其达到期望状态

```go
func (c *Controller) Run(workers int, stopCh <-chan struct{}) error {
	defer utilruntime.HandleCrash()
	defer c.workqueue.ShutDown()

	// 等待cache同步
	klog.Info("Waiting for informer caches to sync")
	if ok := cache.WaitForCacheSync(stopCh, c.deploymentsSynced, c.foosSynced); !ok {
		return fmt.Errorf("failed to wait for caches to sync")
	}

	// 启动worker,每个worker一个goroutine
	for i := 0; i < workers; i++ {
		go wait.Until(c.runWorker, time.Second, stopCh)
	}
  // 等待退出信号
	<-stopCh
	return nil
}

// worker就是一个循环不断调用processNextWorkItem
func (c *Controller) runWorker() {
	for c.processNextWorkItem() {
	}
}

func (c *Controller) processNextWorkItem() bool {
	// 从工作队列获取对象
	obj, shutdown := c.workqueue.Get()

	if shutdown {
		return false
	}

	// We wrap this block in a func so we can defer c.workqueue.Done.
	err := func(obj interface{}) error {
		defer c.workqueue.Done(obj)
		var key string
		var ok bool

		if key, ok = obj.(string); !ok {
			c.workqueue.Forget(obj)
			utilruntime.HandleError(fmt.Errorf("expected string in workqueue but got %#v", obj))
			return nil
		}
		// 进行处理，核心逻辑
		if err := c.syncHandler(key); err != nil {
			// 处理失败再次加入队列
			c.workqueue.AddRateLimited(key)
			return fmt.Errorf("error syncing '%s': %s, requeuing", key, err.Error())
		}
		// 处理成功不入队
		c.workqueue.Forget(obj)
		klog.Infof("Successfully synced '%s'", key)
		return nil
	}(obj)

	if err != nil {
		utilruntime.HandleError(err)
		return true
	}

	return true
}
```

## Operator 模式

在`Operator`模式下，用户只需要实现`Reconcile`(调谐)即`sample-controller`中的`syncHandler`，其他步骤`kubebuilder`已经帮我们实现了。那我们来一探究竟，`kubebuilder`是怎么一步步触发`Reconcile`逻辑。

以[mygame](https://github.com/qingwave/mygame)为例，通常使用`kubebuilder`生成的主文件如下：

```go
var (
	// 用来解析kubernetes对象
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	// 添加自定义对象到scheme
	utilruntime.Must(myappv1.AddToScheme(scheme))
	//+kubebuilder:scaffold:scheme
}

func main() {
	// ...
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))
	// 初始化controller manager
	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                 scheme,
		MetricsBindAddress:     metricsAddr,
		Port:                   9443,
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       "7bc453ad.qingwave.github.io",
	})
	if err != nil {
		setupLog.Error(err, "unable to start manager")
		os.Exit(1)
	}
	// 初始化Reconciler
	if err = (&controllers.GameReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "Game")
		os.Exit(1)
	}
	// 初始化Webhook
	if enableWebhook {
		if err = (&myappv1.Game{}).SetupWebhookWithManager(mgr); err != nil {
			setupLog.Error(err, "unable to create webhook", "webhook", "Game")
			os.Exit(1)
		}
	}
	//+kubebuilder:scaffold:builder

	// 启动manager
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "problem running manager")
		os.Exit(1)
	}
}
```

`kubebuilder`封装了`controller-runtime`，在主文件中主要初始了`controller-manager`,以及我们填充的`Reconciler`与`Webhook`，最后启动`manager`。

分别来看下每个流程。

### Manager 初始化

代码如下：

```go
func New(config *rest.Config, options Options) (Manager, error) {
	// 设置默认配置
	options = setOptionsDefaults(options)
	// cluster初始化
	cluster, err := cluster.New(config, func(clusterOptions *cluster.Options) {
		clusterOptions.Scheme = options.Scheme
		clusterOptions.MapperProvider = options.MapperProvider
		clusterOptions.Logger = options.Logger
		clusterOptions.SyncPeriod = options.SyncPeriod
		clusterOptions.Namespace = options.Namespace
		clusterOptions.NewCache = options.NewCache
		clusterOptions.ClientBuilder = options.ClientBuilder
		clusterOptions.ClientDisableCacheFor = options.ClientDisableCacheFor
		clusterOptions.DryRunClient = options.DryRunClient
		clusterOptions.EventBroadcaster = options.EventBroadcaster
	})
	if err != nil {
		return nil, err
	}
	// event recorder初始化
	recorderProvider, err := options.newRecorderProvider(config, cluster.GetScheme(), options.Logger.WithName("events"), options.makeBroadcaster)
	if err != nil {
		return nil, err
	}

	// 选主的资源锁配置
	leaderConfig := options.LeaderElectionConfig
	if leaderConfig == nil {
		leaderConfig = rest.CopyConfig(config)
	}
	resourceLock, err := options.newResourceLock(leaderConfig, recorderProvider, leaderelection.Options{
		LeaderElection:             options.LeaderElection,
		LeaderElectionResourceLock: options.LeaderElectionResourceLock,
		LeaderElectionID:           options.LeaderElectionID,
		LeaderElectionNamespace:    options.LeaderElectionNamespace,
	})
	if err != nil {
		return nil, err
	}

	// ...

	return &controllerManager{
		cluster:                 cluster,
		recorderProvider:        recorderProvider,
		resourceLock:            resourceLock,
		metricsListener:         metricsListener,
		metricsExtraHandlers:    metricsExtraHandlers,
		logger:                  options.Logger,
		elected:                 make(chan struct{}),
		port:                    options.Port,
		host:                    options.Host,
		certDir:                 options.CertDir,
		leaseDuration:           *options.LeaseDuration,
		renewDeadline:           *options.RenewDeadline,
		retryPeriod:             *options.RetryPeriod,
		healthProbeListener:     healthProbeListener,
		readinessEndpointName:   options.ReadinessEndpointName,
		livenessEndpointName:    options.LivenessEndpointName,
		gracefulShutdownTimeout: *options.GracefulShutdownTimeout,
		internalProceduresStop:  make(chan struct{}),
		leaderElectionStopped:   make(chan struct{}),
	}, nil
```

在`New`中主要初始化了各种配置端口、选主信息、`eventRecorder`，最重要的是初始了`Cluster`。`Cluster`用来访问 k8s，初始化代码如下：

```go
// New constructs a brand new cluster
func New(config *rest.Config, opts ...Option) (Cluster, error) {
	if config == nil {
		return nil, errors.New("must specify Config")
	}

	options := Options{}
	for _, opt := range opts {
		opt(&options)
	}
	options = setOptionsDefaults(options)

	// Create the mapper provider
	mapper, err := options.MapperProvider(config)
	if err != nil {
		options.Logger.Error(err, "Failed to get API Group-Resources")
		return nil, err
	}

	// Create the cache for the cached read client and registering informers
	cache, err := options.NewCache(config, cache.Options{Scheme: options.Scheme, Mapper: mapper, Resync: options.SyncPeriod, Namespace: options.Namespace})
	if err != nil {
		return nil, err
	}

	clientOptions := client.Options{Scheme: options.Scheme, Mapper: mapper}

	apiReader, err := client.New(config, clientOptions)
	if err != nil {
		return nil, err
	}

	writeObj, err := options.ClientBuilder.
		WithUncached(options.ClientDisableCacheFor...).
		Build(cache, config, clientOptions)
	if err != nil {
		return nil, err
	}

	if options.DryRunClient {
		writeObj = client.NewDryRunClient(writeObj)
	}

	recorderProvider, err := options.newRecorderProvider(config, options.Scheme, options.Logger.WithName("events"), options.makeBroadcaster)
	if err != nil {
		return nil, err
	}

	return &cluster{
		config:           config,
		scheme:           options.Scheme,
		cache:            cache,
		fieldIndexes:     cache,
		client:           writeObj,
		apiReader:        apiReader,
		recorderProvider: recorderProvider,
		mapper:           mapper,
		logger:           options.Logger,
	}, nil
}
```

这里主要创建了`cache`与读写`client`

### Cache 初始化

创建`cache`代码：

```go
// New initializes and returns a new Cache.
func New(config *rest.Config, opts Options) (Cache, error) {
	opts, err := defaultOpts(config, opts)
	if err != nil {
		return nil, err
	}
	im := internal.NewInformersMap(config, opts.Scheme, opts.Mapper, *opts.Resync, opts.Namespace)
	return &informerCache{InformersMap: im}, nil
}
```

`New`中调用了`NewInformersMap`来创建`infermer map`，分为`structured`、`unstructured`与`metadata`

```go
func NewInformersMap(config *rest.Config,
	scheme *runtime.Scheme,
	mapper meta.RESTMapper,
	resync time.Duration,
	namespace string) *InformersMap {

	return &InformersMap{
		structured:   newStructuredInformersMap(config, scheme, mapper, resync, namespace),
		unstructured: newUnstructuredInformersMap(config, scheme, mapper, resync, namespace),
		metadata:     newMetadataInformersMap(config, scheme, mapper, resync, namespace),

		Scheme: scheme,
	}
}
```

最终都是调用`newSpecificInformersMap`

```go
// newStructuredInformersMap creates a new InformersMap for structured objects.
func newStructuredInformersMap(config *rest.Config, scheme *runtime.Scheme, mapper meta.RESTMapper, resync time.Duration, namespace string) *specificInformersMap {
	return newSpecificInformersMap(config, scheme, mapper, resync, namespace, createStructuredListWatch)
}

func newSpecificInformersMap(config *rest.Config,
	scheme *runtime.Scheme,
	mapper meta.RESTMapper,
	resync time.Duration,
	namespace string,
	createListWatcher createListWatcherFunc) *specificInformersMap {
	ip := &specificInformersMap{
		config:            config,
		Scheme:            scheme,
		mapper:            mapper,
		informersByGVK:    make(map[schema.GroupVersionKind]*MapEntry),
		codecs:            serializer.NewCodecFactory(scheme),
		paramCodec:        runtime.NewParameterCodec(scheme),
		resync:            resync,
		startWait:         make(chan struct{}),
		createListWatcher: createListWatcher,
		namespace:         namespace,
	}
	return ip
}

func createStructuredListWatch(gvk schema.GroupVersionKind, ip *specificInformersMap) (*cache.ListWatch, error) {
	// Kubernetes APIs work against Resources, not GroupVersionKinds.  Map the
	// groupVersionKind to the Resource API we will use.
	mapping, err := ip.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return nil, err
	}

	client, err := apiutil.RESTClientForGVK(gvk, false, ip.config, ip.codecs)
	if err != nil {
		return nil, err
	}
	listGVK := gvk.GroupVersion().WithKind(gvk.Kind + "List")
	listObj, err := ip.Scheme.New(listGVK)
	if err != nil {
		return nil, err
	}

	// TODO: the functions that make use of this ListWatch should be adapted to
	//  pass in their own contexts instead of relying on this fixed one here.
	ctx := context.TODO()
	// Create a new ListWatch for the obj
	return &cache.ListWatch{
		ListFunc: func(opts metav1.ListOptions) (runtime.Object, error) {
			res := listObj.DeepCopyObject()
			isNamespaceScoped := ip.namespace != "" && mapping.Scope.Name() != meta.RESTScopeNameRoot
			err := client.Get().NamespaceIfScoped(ip.namespace, isNamespaceScoped).Resource(mapping.Resource.Resource).VersionedParams(&opts, ip.paramCodec).Do(ctx).Into(res)
			return res, err
		},
		// Setup the watch function
		WatchFunc: func(opts metav1.ListOptions) (watch.Interface, error) {
			// Watch needs to be set to true separately
			opts.Watch = true
			isNamespaceScoped := ip.namespace != "" && mapping.Scope.Name() != meta.RESTScopeNameRoot
			return client.Get().NamespaceIfScoped(ip.namespace, isNamespaceScoped).Resource(mapping.Resource.Resource).VersionedParams(&opts, ip.paramCodec).Watch(ctx)
		},
	}, nil
}
```

在`newSpecificInformersMap`中通过`informersByGVK`来记录`schema`中每个`GVK`对象与`informer`的对应关系，使用时可根据`GVK`得到`informer`再去`List`/`Get`。

`newSpecificInformersMap`中的`createListWatcher`来初始化`ListWatch`对象。

### Client 初始化

client 这里有多种类型，`apiReader`直接从`apiserver`读取对象，`writeObj`可以从`apiserver`或者`cache`中读取数据。

```go
	apiReader, err := client.New(config, clientOptions)
	if err != nil {
		return nil, err
	}

func New(config *rest.Config, options Options) (Client, error) {
	if config == nil {
		return nil, fmt.Errorf("must provide non-nil rest.Config to client.New")
	}

	// Init a scheme if none provided
	if options.Scheme == nil {
		options.Scheme = scheme.Scheme
	}

	// Init a Mapper if none provided
	if options.Mapper == nil {
		var err error
		options.Mapper, err = apiutil.NewDynamicRESTMapper(config)
		if err != nil {
			return nil, err
		}
	}

	// 从cache中读取
	clientcache := &clientCache{
		config: config,
		scheme: options.Scheme,
		mapper: options.Mapper,
		codecs: serializer.NewCodecFactory(options.Scheme),

		structuredResourceByType:   make(map[schema.GroupVersionKind]*resourceMeta),
		unstructuredResourceByType: make(map[schema.GroupVersionKind]*resourceMeta),
	}

	rawMetaClient, err := metadata.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("unable to construct metadata-only client for use as part of client: %w", err)
	}

	c := &client{
		typedClient: typedClient{
			cache:      clientcache,
			paramCodec: runtime.NewParameterCodec(options.Scheme),
		},
		unstructuredClient: unstructuredClient{
			cache:      clientcache,
			paramCodec: noConversionParamCodec{},
		},
		metadataClient: metadataClient{
			client:     rawMetaClient,
			restMapper: options.Mapper,
		},
		scheme: options.Scheme,
		mapper: options.Mapper,
	}

	return c, nil
}
```

`writeObj`实现了读写分离的`Client`，写直连`apiserver`，读获取在`cache`中则直接读取`cache`，否则通过`clientset`。

```go
writeObj, err := options.ClientBuilder.
		WithUncached(options.ClientDisableCacheFor...).
		Build(cache, config, clientOptions)
	if err != nil {
		return nil, err
	}

func (n *newClientBuilder) Build(cache cache.Cache, config *rest.Config, options client.Options) (client.Client, error) {
	// Create the Client for Write operations.
	c, err := client.New(config, options)
	if err != nil {
		return nil, err
	}

	return client.NewDelegatingClient(client.NewDelegatingClientInput{
		CacheReader:     cache,
		Client:          c,
		UncachedObjects: n.uncached,
	})
}

// 读写分离client
func NewDelegatingClient(in NewDelegatingClientInput) (Client, error) {
	uncachedGVKs := map[schema.GroupVersionKind]struct{}{}
	for _, obj := range in.UncachedObjects {
		gvk, err := apiutil.GVKForObject(obj, in.Client.Scheme())
		if err != nil {
			return nil, err
		}
		uncachedGVKs[gvk] = struct{}{}
	}

	return &delegatingClient{
		scheme: in.Client.Scheme(),
		mapper: in.Client.RESTMapper(),
		Reader: &delegatingReader{
			CacheReader:       in.CacheReader,
			ClientReader:      in.Client,
			scheme:            in.Client.Scheme(),
			uncachedGVKs:      uncachedGVKs,
			cacheUnstructured: in.CacheUnstructured,
		},
		Writer:       in.Client,
		StatusClient: in.Client,
	}, nil
}

// Get retrieves an obj for a given object key from the Kubernetes Cluster.
func (d *delegatingReader) Get(ctx context.Context, key ObjectKey, obj Object) error {
	//根据是否cached选择client
	if isUncached, err := d.shouldBypassCache(obj); err != nil {
		return err
	} else if isUncached {
		return d.ClientReader.Get(ctx, key, obj)
	}
	return d.CacheReader.Get(ctx, key, obj)
}
```

### Controller 初始化

Controller 初始化代码如下：

```go
func (r *GameReconciler) SetupWithManager(mgr ctrl.Manager) error {
	ctrl.NewControllerManagedBy(mgr).
		WithOptions(controller.Options{
			MaxConcurrentReconciles: 3,
		}).
		For(&myappv1.Game{}). // Reconcile资源
		Owns(&appsv1.Deployment{}). // 监听Owner是当前资源的Deployment
		Complete(r)

	return nil
}

// Complete builds the Application ControllerManagedBy.
func (blder *Builder) Complete(r reconcile.Reconciler) error {
	_, err := blder.Build(r)
	return err
}

// Build builds the Application ControllerManagedBy and returns the Controller it created.
func (blder *Builder) Build(r reconcile.Reconciler) (controller.Controller, error) {
	if r == nil {
		return nil, fmt.Errorf("must provide a non-nil Reconciler")
	}
	if blder.mgr == nil {
		return nil, fmt.Errorf("must provide a non-nil Manager")
	}
	if blder.forInput.err != nil {
		return nil, blder.forInput.err
	}
	// Checking the reconcile type exist or not
	if blder.forInput.object == nil {
		return nil, fmt.Errorf("must provide an object for reconciliation")
	}

	// Set the Config
	blder.loadRestConfig()

	// Set the ControllerManagedBy
	if err := blder.doController(r); err != nil {
		return nil, err
	}

	// Set the Watch
	if err := blder.doWatch(); err != nil {
		return nil, err
	}

	return blder.ctrl, nil
}
```

初始化`Controller`调用`ctrl.NewControllerManagedBy`来创建`Builder`，填充配置，最后通过`Build`方法完成初始化，主要做了三件事

1. 设置配置
2. `doController`来创建`controller`
3. `doWatch`来设置需要监听的资源

先看`controller`初始化

```go
func (blder *Builder) doController(r reconcile.Reconciler) error {
	ctrlOptions := blder.ctrlOptions
	if ctrlOptions.Reconciler == nil {
		ctrlOptions.Reconciler = r
	}

	gvk, err := getGvk(blder.forInput.object, blder.mgr.GetScheme())
	if err != nil {
		return err
	}

	// Setup the logger.
	if ctrlOptions.Log == nil {
		ctrlOptions.Log = blder.mgr.GetLogger()
	}
	ctrlOptions.Log = ctrlOptions.Log.WithValues("reconciler group", gvk.Group, "reconciler kind", gvk.Kind)

	// Build the controller and return.
	blder.ctrl, err = newController(blder.getControllerName(gvk), blder.mgr, ctrlOptions)
	return err
}

func New(name string, mgr manager.Manager, options Options) (Controller, error) {
	c, err := NewUnmanaged(name, mgr, options)
	if err != nil {
		return nil, err
	}

	// Add the controller as a Manager components
	return c, mgr.Add(c)
}

func NewUnmanaged(name string, mgr manager.Manager, options Options) (Controller, error) {
	if options.Reconciler == nil {
		return nil, fmt.Errorf("must specify Reconciler")
	}

	if len(name) == 0 {
		return nil, fmt.Errorf("must specify Name for Controller")
	}

	if options.Log == nil {
		options.Log = mgr.GetLogger()
	}

	if options.MaxConcurrentReconciles <= 0 {
		options.MaxConcurrentReconciles = 1
	}

	if options.CacheSyncTimeout == 0 {
		options.CacheSyncTimeout = 2 * time.Minute
	}

	if options.RateLimiter == nil {
		options.RateLimiter = workqueue.DefaultControllerRateLimiter()
	}

	// Inject dependencies into Reconciler
	if err := mgr.SetFields(options.Reconciler); err != nil {
		return nil, err
	}

	// Create controller with dependencies set
	return &controller.Controller{
		Do: options.Reconciler,
		MakeQueue: func() workqueue.RateLimitingInterface {
			return workqueue.NewNamedRateLimitingQueue(options.RateLimiter, name)
		},
		MaxConcurrentReconciles: options.MaxConcurrentReconciles,
		CacheSyncTimeout:        options.CacheSyncTimeout,
		SetFields:               mgr.SetFields,
		Name:                    name,
		Log:                     options.Log.WithName("controller").WithName(name),
	}, nil
}
```

`doController`调用`controller.New`来创建`controller`并添加到`manager`，在`NewUnmanaged`可以看到我们熟悉的配置，与上文`sample-controller`类似这里也设置了工作队列、最大 Worker 数等。

`doWatch`代码如下

```go
func (blder *Builder) doWatch() error {
	// Reconcile type
	typeForSrc, err := blder.project(blder.forInput.object, blder.forInput.objectProjection)
	if err != nil {
		return err
	}
	src := &source.Kind{Type: typeForSrc}
	hdler := &handler.EnqueueRequestForObject{}
	allPredicates := append(blder.globalPredicates, blder.forInput.predicates...)
	if err := blder.ctrl.Watch(src, hdler, allPredicates...); err != nil {
		return err
	}

	// Watches the managed types
	for _, own := range blder.ownsInput {
		typeForSrc, err := blder.project(own.object, own.objectProjection)
		if err != nil {
			return err
		}
		src := &source.Kind{Type: typeForSrc}
		hdler := &handler.EnqueueRequestForOwner{
			OwnerType:    blder.forInput.object,
			IsController: true,
		}
		allPredicates := append([]predicate.Predicate(nil), blder.globalPredicates...)
		allPredicates = append(allPredicates, own.predicates...)
		if err := blder.ctrl.Watch(src, hdler, allPredicates...); err != nil {
			return err
		}
	}

	// Do the watch requests
	for _, w := range blder.watchesInput {
		allPredicates := append([]predicate.Predicate(nil), blder.globalPredicates...)
		allPredicates = append(allPredicates, w.predicates...)

		// If the source of this watch is of type *source.Kind, project it.
		if srckind, ok := w.src.(*source.Kind); ok {
			typeForSrc, err := blder.project(srckind.Type, w.objectProjection)
			if err != nil {
				return err
			}
			srckind.Type = typeForSrc
		}

		if err := blder.ctrl.Watch(w.src, w.eventhandler, allPredicates...); err != nil {
			return err
		}
	}
	return nil
}
```

`doWatch`以此`watch`当前资源，`ownsInput`资源（即 owner 为当前资源），以及通过`builder`传入的`watchsInput`，最后调用`ctrl.Watch`来注册。其中参数`eventhandler`为入队函数，如当前资源入队实现为`handler.EnqueueRequestForObject`，类似地`handler.EnqueueRequestForOwner`是将`owner`加入工作队列。

```go
type EnqueueRequestForObject struct{}

// Create implements EventHandler
func (e *EnqueueRequestForObject) Create(evt event.CreateEvent, q workqueue.RateLimitingInterface) {
	if evt.Object == nil {
		enqueueLog.Error(nil, "CreateEvent received with no metadata", "event", evt)
		return
	}
	// 加入队列
	q.Add(reconcile.Request{NamespacedName: types.NamespacedName{
		Name:      evt.Object.GetName(),
		Namespace: evt.Object.GetNamespace(),
	}})
}
```

`Watch`实现如下：

```go
func (c *Controller) Watch(src source.Source, evthdler handler.EventHandler, prct ...predicate.Predicate) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Inject Cache into arguments
	if err := c.SetFields(src); err != nil {
		return err
	}
	if err := c.SetFields(evthdler); err != nil {
		return err
	}
	for _, pr := range prct {
		if err := c.SetFields(pr); err != nil {
			return err
		}
	}

	if !c.Started {
		c.startWatches = append(c.startWatches, watchDescription{src: src, handler: evthdler, predicates: prct})
		return nil
	}

	c.Log.Info("Starting EventSource", "source", src)
	return src.Start(c.ctx, evthdler, c.Queue, prct...)
}

func (ks *Kind) InjectCache(c cache.Cache) error {
	if ks.cache == nil {
		ks.cache = c
	}
	return nil
}

func (ks *Kind) Start(ctx context.Context, handler handler.EventHandler, queue workqueue.RateLimitingInterface,
	prct ...predicate.Predicate) error {
	...
	i, err := ks.cache.GetInformer(ctx, ks.Type)
	if err != nil {
		if kindMatchErr, ok := err.(*meta.NoKindMatchError); ok {
			log.Error(err, "if kind is a CRD, it should be installed before calling Start",
				"kind", kindMatchErr.GroupKind)
		}
		return err
	}
	i.AddEventHandler(internal.EventHandler{Queue: queue, EventHandler: handler, Predicates: prct})
	return nil
}

// informer get 实现
func (m *InformersMap) Get(ctx context.Context, gvk schema.GroupVersionKind, obj runtime.Object) (bool, *MapEntry, error) {
	switch obj.(type) {
	case *unstructured.Unstructured:
		return m.unstructured.Get(ctx, gvk, obj)
	case *unstructured.UnstructuredList:
		return m.unstructured.Get(ctx, gvk, obj)
	case *metav1.PartialObjectMetadata:
		return m.metadata.Get(ctx, gvk, obj)
	case *metav1.PartialObjectMetadataList:
		return m.metadata.Get(ctx, gvk, obj)
	default:
		return m.structured.Get(ctx, gvk, obj)
	}
}

// 如果informer不存在则新创建一个，加入到informerMap
func (ip *specificInformersMap) Get(ctx context.Context, gvk schema.GroupVersionKind, obj runtime.Object) (bool, *MapEntry, error) {
	// Return the informer if it is found
	i, started, ok := func() (*MapEntry, bool, bool) {
		ip.mu.RLock()
		defer ip.mu.RUnlock()
		i, ok := ip.informersByGVK[gvk]
		return i, ip.started, ok
	}()

	if !ok {
		var err error
		if i, started, err = ip.addInformerToMap(gvk, obj); err != nil {
			return started, nil, err
		}
	}
	...
	return started, i, nil
}


```

`Watch`通过`SetFeilds`方法注入`cache`, 最后添加到`controller`的`startWatches`队列，若已启动，调用`Start`方法配置回调函数`EventHandler`。

### Manager 启动

最后来看`Manager`启动流程

```go
func (cm *controllerManager) Start(ctx context.Context) (err error) {
	if err := cm.Add(cm.cluster); err != nil {
		return fmt.Errorf("failed to add cluster to runnables: %w", err)
	}
	cm.internalCtx, cm.internalCancel = context.WithCancel(ctx)

	stopComplete := make(chan struct{})
	defer close(stopComplete)
	defer func() {
		stopErr := cm.engageStopProcedure(stopComplete)
	}()

	cm.errChan = make(chan error)

	if cm.metricsListener != nil {
		go cm.serveMetrics()
	}

	// Serve health probes
	if cm.healthProbeListener != nil {
		go cm.serveHealthProbes()
	}

	go cm.startNonLeaderElectionRunnables()

	go func() {
		if cm.resourceLock != nil {
			err := cm.startLeaderElection()
			if err != nil {
				cm.errChan <- err
			}
		} else {
			// Treat not having leader election enabled the same as being elected.
			cm.startLeaderElectionRunnables()
			close(cm.elected)
		}
	}()

	select {
	case <-ctx.Done():
		// We are done
		return nil
	case err := <-cm.errChan:
		// Error starting or running a runnable
		return err
	}
}
```

主要流程包括：

1. 启动监控服务
2. 启动健康检查服务
3. 启动非选主服务
4. 启动选主服务

对于非选主服务，代码如下

```go
func (cm *controllerManager) startNonLeaderElectionRunnables() {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	cm.waitForCache(cm.internalCtx)

	// Start the non-leaderelection Runnables after the cache has synced
	for _, c := range cm.nonLeaderElectionRunnables {
		cm.startRunnable(c)
	}
}

func (cm *controllerManager) waitForCache(ctx context.Context) {
	if cm.started {
		return
	}

	for _, cache := range cm.caches {
		cm.startRunnable(cache)
	}

	for _, cache := range cm.caches {
		cache.GetCache().WaitForCacheSync(ctx)
	}
	cm.started = true
}
```

启动`cache`，启动其他服务，对于选主服务也类似，初始化`controller`时会加入到选主服务队列，即最后启动`Controller`

```go
func (c *Controller) Start(ctx context.Context) error {
	...
	c.Queue = c.MakeQueue()
	defer c.Queue.ShutDown() // needs to be outside the iife so that we shutdown after the stop channel is closed

	err := func() error {
		defer c.mu.Unlock()
		defer utilruntime.HandleCrash()

		for _, watch := range c.startWatches {
			c.Log.Info("Starting EventSource", "source", watch.src)

			if err := watch.src.Start(ctx, watch.handler, c.Queue, watch.predicates...); err != nil {
				return err
			}
		}

		for _, watch := range c.startWatches {
			syncingSource, ok := watch.src.(source.SyncingSource)
			if !ok {
				continue
			}

			if err := func() error {
				// use a context with timeout for launching sources and syncing caches.
				sourceStartCtx, cancel := context.WithTimeout(ctx, c.CacheSyncTimeout)
				defer cancel()

				if err := syncingSource.WaitForSync(sourceStartCtx); err != nil {
					err := fmt.Errorf("failed to wait for %s caches to sync: %w", c.Name, err)
					c.Log.Error(err, "Could not wait for Cache to sync")
					return err
				}

				return nil
			}(); err != nil {
				return err
			}
		}

		...
		for i := 0; i < c.MaxConcurrentReconciles; i++ {
			go wait.UntilWithContext(ctx, func(ctx context.Context) {
				for c.processNextWorkItem(ctx) {
				}
			}, c.JitterPeriod)
		}

		c.Started = true
		return nil
	}()
	if err != nil {
		return err
	}

	<-ctx.Done()
	c.Log.Info("Stopping workers")
	return nil
}

func (c *Controller) processNextWorkItem(ctx context.Context) bool {
	obj, shutdown := c.Queue.Get()
	...
	c.reconcileHandler(ctx, obj)
	return true
}

func (c *Controller) reconcileHandler(ctx context.Context, obj interface{}) {
	// Make sure that the the object is a valid request.
	req, ok := obj.(reconcile.Request)
	...

	if result, err := c.Do.Reconcile(ctx, req); err != nil {
	...
}
```

`Controller`启动主要包括

1. 等待 cache 同步
2. 启动多个`processNextWorkItem`
3. 每个 Worker 调用`c.Do.Reconcile`来进行数据处理
   与`sample-controller`工作流程一致，不断获取工作队列中的数据调用`Reconcile`进行调谐。

### 流程归纳

至此，通过`kubebuilder`生成代码的主要逻辑已经明朗，对比`sample-controller`其实整体流程类似，只是`kubebuilder`通过`controller-runtime`已经帮我们做了很多工作，如`client`、`cache`的初始化，`controller`的运行框架，我们只需要关心`Reconcile`逻辑即可。

1. 初始化`manager`，创建`client`与`cache`
2. 创建`controller`，对于监听资源会创建对应`informer`并添加回调函数
3. 启动`manager`，启动`cache`与`controller`

## 总结

`kubebuilder`大大简化了开发`Operator`的流程，了解其背后的原理有利于我们对`Operator`进行调优，能更好地应用于生产。

## 引用

- https://github.com/kubernetes/sample-controller
- https://book.kubebuilder.io/architecture.html
- https://developer.aliyun.com/article/719215
