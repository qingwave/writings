---
title: 'Kubernetes中的Golang设计模式'
date: 2022-04-14T07:18:45Z
draft: false
tags: ['golang', 'k8s', '程序设计']
categories: ['code']
---

随着 Kubernetes 成为容器编排领域的事实标准，Golang 在云原生方面应用的也越来越多。今天我们跟随 K8s 的脚步，学习下在 K8s 中使用哪些经典的设计模式。

## 创建型模式

创建型模式顾名思义提供了对象的创建机制，封装了内部的复杂性，提高代码复用和灵活性。包括：

- 单例模式
- 工厂模式
- 建造者模式
- 原型模式

### 单例模式

单例模式用来保证一个类只有一个实例，并提供调用它的一个全局访问点。单例模式是设计模式中最简单，使用最广的一个，通常用来创建一个共享的实例，比如数据库连接池、线程池等。

单例模式分为懒汉式（使用时创建，延迟调用）与饿汉式（初始化时创建），通常我们使用`once.Do`来实现懒汉式，保证其线程安全。

在`kubeadm`中使用了单例模式来创建用户与用户组
https://github.com/kubernetes/kubernetes/tree/master/cmd/kubeadm/app/util/staticpod/utils.go

```go
var (
	usersAndGroups     *users.UsersAndGroups
	usersAndGroupsOnce sync.Once
)

func GetUsersAndGroups() (*users.UsersAndGroups, error) {
	var err error
	usersAndGroupsOnce.Do(func() {
		usersAndGroups, err = users.AddUsersAndGroups()
	})
	return usersAndGroups, err
}
```

### 工厂模式

工厂模式通过一个工厂方法来创建不同的产品，又分为简单工厂、工厂方法、抽象工厂，一般用来创建一类相似的产品，方便扩展。

简单工厂根据不同的输入创建不同的产品，在 Golang 中采用`Newxxx`的方式实现。

在`kubelet`中通过输入同创建不同的认证类型
https://github.com/kubernetes/kubernetes/tree/master/cmd/kubelet/app/auth.go

```go
func BuildAuthz(client authorizationclient.AuthorizationV1Interface, authz kubeletconfig.KubeletAuthorization) (authorizer.Authorizer, error) {
	switch authz.Mode {
	case kubeletconfig.KubeletAuthorizationModeAlwaysAllow:
		return authorizerfactory.NewAlwaysAllowAuthorizer(), nil

	case kubeletconfig.KubeletAuthorizationModeWebhook:
		if client == nil {
			return nil, errors.New("no client provided, cannot use webhook authorization")
		}
		authorizerConfig := authorizerfactory.DelegatingAuthorizerConfig{
			SubjectAccessReviewClient: client,
			AllowCacheTTL:             authz.Webhook.CacheAuthorizedTTL.Duration,
			DenyCacheTTL:              authz.Webhook.CacheUnauthorizedTTL.Duration,
			WebhookRetryBackoff:       genericoptions.DefaultAuthWebhookRetryBackoff(),
		}
		return authorizerConfig.New()

	case "":
		return nil, fmt.Errorf("no authorization mode specified")

	default:
		return nil, fmt.Errorf("unknown authorization mode %s", authz.Mode)

	}
}
```

以及https://github.com/kubernetes/client-go/blob/master/tools/cache/store.go

```go
func NewStore(keyFunc KeyFunc) Store {
	return &cache{
		cacheStorage: NewThreadSafeStore(Indexers{}, Indices{}),
		keyFunc:      keyFunc,
	}
}

type cache struct {
	// cacheStorage bears the burden of thread safety for the cache
	cacheStorage ThreadSafeStore
	// keyFunc is used to make the key for objects stored in and retrieved from items, and
	// should be deterministic.
	keyFunc KeyFunc
}

type Store interface {
	Add(obj interface{}) error

	Update(obj interface{}) error

	Delete(obj interface{}) error

	List() []interface{}

	ListKeys() []string

	Get(obj interface{}) (item interface{}, exists bool, err error)

	// GetByKey returns the accumulator associated with the given key
	GetByKey(key string) (item interface{}, exists bool, err error)

	Replace([]interface{}, string) error

	Resync() error
}
```

抽象工厂用来构建复杂的一组产品，在 informer 的实现中使用了抽象工厂
https://github.com/kubernetes/client-go/blob/master/informers/factory.go

```go
// NewSharedInformerFactoryWithOptions constructs a new instance of a SharedInformerFactory with additional options.
func NewSharedInformerFactoryWithOptions(client kubernetes.Interface, defaultResync time.Duration, options ...SharedInformerOption) SharedInformerFactory {
	factory := &sharedInformerFactory{
		client:           client,
		namespace:        v1.NamespaceAll,
		defaultResync:    defaultResync,
		informers:        make(map[reflect.Type]cache.SharedIndexInformer),
		startedInformers: make(map[reflect.Type]bool),
		customResync:     make(map[reflect.Type]time.Duration),
	}

	// Apply all options
	for _, opt := range options {
		factory = opt(factory)
	}

	return factory
}

// SharedInformerFactory provides shared informers for resources in all known
// API group versions.
type SharedInformerFactory interface {
	internalinterfaces.SharedInformerFactory
	ForResource(resource schema.GroupVersionResource) (GenericInformer, error)
	WaitForCacheSync(stopCh <-chan struct{}) map[reflect.Type]bool

	Admissionregistration() admissionregistration.Interface
	Internal() apiserverinternal.Interface
	Apps() apps.Interface
	Autoscaling() autoscaling.Interface
	Batch() batch.Interface
	Certificates() certificates.Interface
	Coordination() coordination.Interface
	Core() core.Interface
	Discovery() discovery.Interface
	Events() events.Interface
	Extensions() extensions.Interface
	Flowcontrol() flowcontrol.Interface
	Networking() networking.Interface
	Node() node.Interface
	Policy() policy.Interface
	Rbac() rbac.Interface
	Scheduling() scheduling.Interface
	Storage() storage.Interface
}

func (f *sharedInformerFactory) Apps() apps.Interface {
	return apps.New(f, f.namespace, f.tweakListOptions)
}
```

### 建造者模式

建造者模式通过逐步构建复杂的对象，降低创建对象的复杂度。通常多个步骤返回中间对象，最后通过`Build`完成检验与构建工作。

在`controller-runtime`中使用了建造者模式来创建 controller
https://github.com/kubernetes-sigs/controller-runtime/tree/master/pkg/builder

```go
// Builder builds a Controller.
type Builder struct {
	forInput         ForInput
	ownsInput        []OwnsInput
	watchesInput     []WatchesInput
	mgr              manager.Manager
	globalPredicates []predicate.Predicate
	ctrl             controller.Controller
	ctrlOptions      controller.Options
	name             string
}

func (blder *Builder) For(object client.Object, opts ...ForOption) *Builder {
	if blder.forInput.object != nil {
		blder.forInput.err = fmt.Errorf("For(...) should only be called once, could not assign multiple objects for reconciliation")
		return blder
	}
	input := ForInput{object: object}
	for _, opt := range opts {
		opt.ApplyToFor(&input)
	}

	blder.forInput = input
	return blder
}

// Watches exposes the lower-level ControllerManagedBy Watches functions through the builder.  Consider using
// Owns or For instead of Watches directly.
// Specified predicates are registered only for given source.
func (blder *Builder) Watches(src source.Source, eventhandler handler.EventHandler, opts ...WatchesOption) *Builder {
	input := WatchesInput{src: src, eventhandler: eventhandler}
	for _, opt := range opts {
		opt.ApplyToWatches(&input)
	}

	blder.watchesInput = append(blder.watchesInput, input)
	return blder
}

// WithOptions overrides the controller options use in doController. Defaults to empty.
func (blder *Builder) WithOptions(options controller.Options) *Builder {
	blder.ctrlOptions = options
	return blder
}

// WithLogger overrides the controller options's logger used.
func (blder *Builder) WithLogger(log logr.Logger) *Builder {
	blder.ctrlOptions.Log = log
	return blder
}

// Build builds the Application Controller and returns the Controller it created.
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

### 原型模式

原型模式用来解决对象复制问题，通过`Clone`方法，返回对象的复制品。将实现细节与使用解耦。

在 k8s 中所有资源都需要使用`DeepCopy`接口即原型模式
https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/api/core/v1/zz_generated.deepcopy.go

```go
// DeepCopyInto is an autogenerated deepcopy function, copying the receiver, writing into out. in must be non-nil.
func (in *Pod) DeepCopyInto(out *Pod) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	in.Spec.DeepCopyInto(&out.Spec)
	in.Status.DeepCopyInto(&out.Status)
	return
}

// DeepCopy is an autogenerated deepcopy function, copying the receiver, creating a new Pod.
func (in *Pod) DeepCopy() *Pod {
	if in == nil {
		return nil
	}
	out := new(Pod)
	in.DeepCopyInto(out)
	return out
}
```

## 结构型模式

结构型模式通过将对象组合成更大的结构，从而提供系统的灵活性。包括：

- 适配器模式
- 桥接模式
- 组合模式
- 代理模式
- 外观模式
- 装饰模式
- 享元模式

### 适配器模式

通过适配器模式能使不兼容的对象相互协作，通常做一些兼容性工作（老版本、外部服务）时会使用到。

k8s 中有很多适配器的例子, 通过`Adapter`去包裹其他对象转换成统一的接口
https://github.com/kubernetes/kubernetes/blob/master/pkg/controller/replication/conversion.go

```go
// informerAdapter implements ReplicaSetInformer by wrapping ReplicationControllerInformer
// and converting objects.
type informerAdapter struct {
	rcInformer coreinformers.ReplicationControllerInformer
}

func (i informerAdapter) Informer() cache.SharedIndexInformer {
	return conversionInformer{i.rcInformer.Informer()}
}

func (i informerAdapter) Lister() appslisters.ReplicaSetLister {
	return conversionLister{i.rcInformer.Lister()}
}
```

https://github.com/kubernetes/client-go/blob/master/tools/events/event_broadcaster.go

```go
type eventBroadcasterAdapterImpl struct {
	coreClient          typedv1core.EventsGetter
	coreBroadcaster     record.EventBroadcaster
	eventsv1Client      typedeventsv1.EventsV1Interface
	eventsv1Broadcaster EventBroadcaster
}

// NewEventBroadcasterAdapter creates a wrapper around new and legacy broadcasters to simplify
// migration of individual components to the new Event API.
func NewEventBroadcasterAdapter(client clientset.Interface) EventBroadcasterAdapter {
	eventClient := &eventBroadcasterAdapterImpl{}
	if _, err := client.Discovery().ServerResourcesForGroupVersion(eventsv1.SchemeGroupVersion.String()); err == nil {
		eventClient.eventsv1Client = client.EventsV1()
		eventClient.eventsv1Broadcaster = NewBroadcaster(&EventSinkImpl{Interface: eventClient.eventsv1Client})
	}
	// Even though there can soon exist cases when coreBroadcaster won't really be needed,
	// we create it unconditionally because its overhead is minor and will simplify using usage
	// patterns of this library in all components.
	eventClient.coreClient = client.CoreV1()
	eventClient.coreBroadcaster = record.NewBroadcaster()
	return eventClient
}

// StartRecordingToSink starts sending events received from the specified eventBroadcaster to the given sink.
func (e *eventBroadcasterAdapterImpl) StartRecordingToSink(stopCh <-chan struct{}) {
	if e.eventsv1Broadcaster != nil && e.eventsv1Client != nil {
		e.eventsv1Broadcaster.StartRecordingToSink(stopCh)
	}
	if e.coreBroadcaster != nil && e.coreClient != nil {
		e.coreBroadcaster.StartRecordingToSink(&typedv1core.EventSinkImpl{Interface: e.coreClient.Events("")})
	}
}

func (e *eventBroadcasterAdapterImpl) NewRecorder(name string) EventRecorder {
	if e.eventsv1Broadcaster != nil && e.eventsv1Client != nil {
		return e.eventsv1Broadcaster.NewRecorder(scheme.Scheme, name)
	}
	return record.NewEventRecorderAdapter(e.DeprecatedNewLegacyRecorder(name))
}
```

### 桥接模式

桥接模式将实现与抽象解耦，可提供系统的系统的灵活性与可扩展性。

在 k8s 中大量使用，如`DiscoveryClient`的实现
https://github.com/kubernetes/client-go/blob/master/discovery/discovery_client.go

```go
type DiscoveryClient struct {
	restClient restclient.Interface

	LegacyPrefix string
}

type DiscoveryInterface interface {
	RESTClient() restclient.Interface
	ServerGroupsInterface
	ServerResourcesInterface
	ServerVersionInterface
	OpenAPISchemaInterface
	OpenAPIV3SchemaInterface
}

// NewDiscoveryClient returns a new DiscoveryClient for the given RESTClient.
func NewDiscoveryClient(c restclient.Interface) *DiscoveryClient {
	return &DiscoveryClient{restClient: c, LegacyPrefix: "/api"}
}

// RESTClient returns a RESTClient that is used to communicate
// with API server by this client implementation.
func (d *DiscoveryClient) RESTClient() restclient.Interface {
	if d == nil {
		return nil
	}
	return d.restClient
}
```

### 组合模式

组合模式通过组合小对象形成更大的结构，并且具有相同的接口。和 Golang 中的组合非常相似，使用也非常广泛。

https://github.com/kubernetes-sigs/controller-runtime/tree/master/pkg/cache/cache.go

```go
// Cache knows how to load Kubernetes objects, fetch informers to request
// to receive events for Kubernetes objects (at a low-level),
// and add indices to fields on the objects stored in the cache.
type Cache interface {
	// Cache acts as a client to objects stored in the cache.
	client.Reader

	// Cache loads informers and adds field indices.
	Informers
}

type Informers interface {
	GetInformer(ctx context.Context, obj client.Object) (Informer, error)

	GetInformerForKind(ctx context.Context, gvk schema.GroupVersionKind) (Informer, error)

	Start(ctx context.Context) error

	WaitForCacheSync(ctx context.Context) bool

	client.FieldIndexer
}
```

### 代理模式

代理模式通过代理来替代真实服务，通常代理类与真实类具有相同的接口，在代理类中可以做一些额外操作（访问控制、缓存等）

在 k8s 中通过代理来实现访问 Node、Pod、Service。

### 外观模式

外观模式通过一个高度抽象的接口，使子系统更加容器使用，使用也很广泛

比如`controller-runtime`中创建时`controllerManager`时调用了很多子系统，使用时只需通过`GetClient()`便可得到`Client`

```go
// New returns a new Manager for creating Controllers.
func New(config *rest.Config, options Options) (Manager, error) {
	// Set default values for options fields
	options = setOptionsDefaults(options)

	cluster, err := cluster.New(config, func(clusterOptions *cluster.Options) {
		clusterOptions.Scheme = options.Scheme
		clusterOptions.MapperProvider = options.MapperProvider
		clusterOptions.Logger = options.Logger
		clusterOptions.SyncPeriod = options.SyncPeriod
		clusterOptions.Namespace = options.Namespace
		clusterOptions.NewCache = options.NewCache
		clusterOptions.NewClient = options.NewClient
		clusterOptions.ClientDisableCacheFor = options.ClientDisableCacheFor
		clusterOptions.DryRunClient = options.DryRunClient
		clusterOptions.EventBroadcaster = options.EventBroadcaster //nolint:staticcheck
	})
	if err != nil {
		return nil, err
	}

	//...

	return &controllerManager{
		cluster:                       cluster,
		//...
	}, nil
}

func (c *cluster) GetClient() client.Client {
	return c.client
}
```

### 装饰模式

装饰模式通过原有对象多次包装从而添加新功能，典型的一些 Http 中间件实现（日志、认证）

`admission`中装饰器的使用
https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/admission/decorator.go

```go
type Decorator interface {
	Decorate(handler Interface, name string) Interface
}

type DecoratorFunc func(handler Interface, name string) Interface

func (d DecoratorFunc) Decorate(handler Interface, name string) Interface {
	return d(handler, name)
}

type Decorators []Decorator

// Decorate applies the decorator in inside-out order, i.e. the first decorator in the slice is first applied to the given handler.
func (d Decorators) Decorate(handler Interface, name string) Interface {
	result := handler
	for _, d := range d {
		result = d.Decorate(result, name)
	}

	return result
}
```

### 享元模式

享元模式通过共享多个对象共有的子对象，从而节省内存。如连接池、对象池的实现等，在 Golang 中通过`sync.Pool`可实现对象复用即享元模式。

在`apiserver/endpoints`中通过共享 gzip 对象，减少内存分配以及 gc 时间

```go
var gzipPool = &sync.Pool{
	New: func() interface{} {
		gw, err := gzip.NewWriterLevel(nil, defaultGzipContentEncodingLevel)
		if err != nil {
			panic(err)
		}
		return gw
	},
}

func (w *deferredResponseWriter) Write(p []byte) (n int, err error) {
	// ...
	hw := w.hw
	header := hw.Header()
	switch {
	case w.contentEncoding == "gzip" && len(p) > defaultGzipThresholdBytes:
		header.Set("Content-Encoding", "gzip")
		header.Add("Vary", "Accept-Encoding")

		gw := gzipPool.Get().(*gzip.Writer)
		gw.Reset(hw)

		w.w = gw
	default:
		w.w = hw
	}

	header.Set("Content-Type", w.mediaType)
	hw.WriteHeader(w.statusCode)
	return w.w.Write(p)
}

func (w *deferredResponseWriter) Close() error {
	if !w.hasWritten {
		return nil
	}
	var err error
	switch t := w.w.(type) {
	case *gzip.Writer:
		err = t.Close()
		t.Reset(nil)
		gzipPool.Put(t)
	}
	return err
}
```

## 行为型模式

行为型模式负责对象间的通信和职责委派，常用的包括：

- 观察者模式
- 中介者模式
- 命令模式
- 迭代器模式
- 策略模式
- 状态模式
- 备忘录模式
- 职责链模式
- 访问者模式
- 解释器模式

### 观察者模式

观察者模式允许观察者订阅事件，当事件触发时会通知观察对象。

在`shardInformer`订阅事件时使用了观察者模式
https://github.com/kubernetes/client-go/blob/master/tools/cache/shared_informer.go

```go
func (s *sharedIndexInformer) AddEventHandlerWithResyncPeriod(handler ResourceEventHandler, resyncPeriod time.Duration) {
	//...
	s.processor.addListener(listener)
	for _, item := range s.indexer.List() {
		listener.add(addNotification{newObj: item})
	}
}

// 事件触发时通知所有对象
func (s *sharedIndexInformer) OnAdd(obj interface{}) {
	// Invocation of this function is locked under s.blockDeltas, so it is
	// save to distribute the notification
	s.cacheMutationDetector.AddObject(obj)
	s.processor.distribute(addNotification{newObj: obj}, false)
}

func (p *sharedProcessor) distribute(obj interface{}, sync bool) {
	p.listenersLock.RLock()
	defer p.listenersLock.RUnlock()

	if sync {
		for _, listener := range p.syncingListeners {
			listener.add(obj)
		}
	} else {
		for _, listener := range p.listeners {
			listener.add(obj)
		}
	}
}
```

### 命令模式

命令模式通过将请求封装为对象，方便存储调用。

在 k8s 中所有组件启动都是通过`github.com/spf13/cobra`工具包
https://github.com/kubernetes/kubernetes/blob/master/cmd/kube-apiserver/apiserver.go

```go
func main() {
	command := app.NewAPIServerCommand()
	code := cli.Run(command)
	os.Exit(code)
}
```

### 迭代器模式

迭代器允许顺序遍历复杂的数据结构而不暴露其内部细节。通常通过`Next`方法来迭代下一个对象。

k8s 在对象序列化时使用了迭代器。

### 策略模式

策略模式通过定义一系列算法，允许运行时可替换算法，从而实现算法分离。

策略模式与桥接模式非常像，只是桥接模式的抽象程度更高一点。
https://github.com/kubernetes/kubernetes/blob/master/pkg/registry/admissionregistration/mutatingwebhookconfiguration/storage/storage.go

```go
// NewREST returns a RESTStorage object that will work against mutatingWebhookConfiguration.
func NewREST(optsGetter generic.RESTOptionsGetter) (*REST, error) {
	store := &genericregistry.Store{
		NewFunc:     func() runtime.Object { return &admissionregistration.MutatingWebhookConfiguration{} },
		NewListFunc: func() runtime.Object { return &admissionregistration.MutatingWebhookConfigurationList{} },
		ObjectNameFunc: func(obj runtime.Object) (string, error) {
			return obj.(*admissionregistration.MutatingWebhookConfiguration).Name, nil
		},
		DefaultQualifiedResource: admissionregistration.Resource("mutatingwebhookconfigurations"),

		CreateStrategy: mutatingwebhookconfiguration.Strategy,
		UpdateStrategy: mutatingwebhookconfiguration.Strategy,
		DeleteStrategy: mutatingwebhookconfiguration.Strategy,

		TableConvertor: printerstorage.TableConvertor{TableGenerator: printers.NewTableGenerator().With(printersinternal.AddHandlers)},
	}
	options := &generic.StoreOptions{RESTOptions: optsGetter}
	if err := store.CompleteWithOptions(options); err != nil {
		return nil, err
	}
	return &REST{store}, nil
}
```

### 状态模式

状态模式将状态与行为分离，例如状态机的实现

如在容器运行时的接口中，可以获取容器状态

```go
type Runtime interface {
	//...
	Status() (*RuntimeStatus, error)

	// SyncPod syncs the running pod into the desired pod.
	SyncPod(pod *v1.Pod, podStatus *PodStatus, pullSecrets []v1.Secret, backOff *flowcontrol.Backoff) PodSyncResult

	KillPod(pod *v1.Pod, runningPod Pod, gracePeriodOverride *int64) error

	DeleteContainer(containerID ContainerID) error
	//...
}
```

### 备忘录模式

备忘录模式可以保存程序内部状态到外部，又不希望暴露内部状态的情形。例如快照可保存对象状态，用于恢复。

https://github.com/kubernetes/kubernetes/blob/master/pkg/registry/core/service/ipallocator/allocator.go

```go
// NewFromSnapshot allocates a Range and initializes it from a snapshot.
func NewFromSnapshot(snap *api.RangeAllocation) (*Range, error) {
	_, ipnet, err := netutils.ParseCIDRSloppy(snap.Range)
	if err != nil {
		return nil, err
	}
	r, err := NewInMemory(ipnet)
	if err != nil {
		return nil, err
	}
	if err := r.Restore(ipnet, snap.Data); err != nil {
		return nil, err
	}
	return r, nil
}
```

### 职责链模式

通过职责链分离不同的功能，可以动态组合。与装饰模式很相似，实际使用中也不需要区分其差异。

在`apiserver`的`handler`实现中，通过职责链来增加认证、授权、限流等操作
https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/server/config.go

```go
func DefaultBuildHandlerChain(apiHandler http.Handler, c *Config) http.Handler {
	handler := filterlatency.TrackCompleted(apiHandler)
	handler = genericapifilters.WithAuthorization(handler, c.Authorization.Authorizer, c.Serializer)
	handler = filterlatency.TrackStarted(handler, "authorization")

	if c.FlowControl != nil {
		requestWorkEstimator := flowcontrolrequest.NewWorkEstimator(c.StorageObjectCountTracker.Get, c.FlowControl.GetInterestedWatchCount)
		handler = filterlatency.TrackCompleted(handler)
		handler = genericfilters.WithPriorityAndFairness(handler, c.LongRunningFunc, c.FlowControl, requestWorkEstimator)
		handler = filterlatency.TrackStarted(handler, "priorityandfairness")
	} else {
		handler = genericfilters.WithMaxInFlightLimit(handler, c.MaxRequestsInFlight, c.MaxMutatingRequestsInFlight, c.LongRunningFunc)
	}

	//...
	handler = genericapifilters.WithLatencyTrackers(handler)
	handler = genericapifilters.WithRequestInfo(handler, c.RequestInfoResolver)
	handler = genericapifilters.WithRequestReceivedTimestamp(handler)
	handler = genericapifilters.WithMuxAndDiscoveryComplete(handler, c.lifecycleSignals.MuxAndDiscoveryComplete.Signaled())
	handler = genericfilters.WithPanicRecovery(handler, c.RequestInfoResolver)
	handler = genericapifilters.WithAuditID(handler)
	return handler
}
```

### 访问者模式

访问者模式可以给一系列对象透明的添加功能，并且把相关代码封装到一个类中, 对象只要预留访问者接口 Accept 则后期为对象添加功能的时就不需要改动对象。

例如动物园内有多个场馆，有些场馆（熊猫馆、海洋馆）需要单独收费，那么每个场馆（对象）可以通过 Accept 接待游客（Vistor）。访问者模式的关键是将对象的操作分离出来形成单独的类，对象可以选择对应的操作。

在`kubectl`中使用访问者模式，通过不同的访问者实现不同的参数，从而拼接成 Rest 请求。
https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/kubectl/pkg/apps/kind_visitor.go#L39

```go
type KindVisitor interface {
	VisitDaemonSet(kind GroupKindElement)
	VisitDeployment(kind GroupKindElement)
	VisitJob(kind GroupKindElement)
	VisitPod(kind GroupKindElement)
	VisitReplicaSet(kind GroupKindElement)
	VisitReplicationController(kind GroupKindElement)
	VisitStatefulSet(kind GroupKindElement)
	VisitCronJob(kind GroupKindElement)
}

// GroupKindElement defines a Kubernetes API group elem
type GroupKindElement schema.GroupKind

// Accept calls the Visit method on visitor that corresponds to elem's Kind
func (elem GroupKindElement) Accept(visitor KindVisitor) error {
	switch {
	case elem.GroupMatch("apps", "extensions") && elem.Kind == "DaemonSet":
		visitor.VisitDaemonSet(elem)
	case elem.GroupMatch("apps", "extensions") && elem.Kind == "Deployment":
		visitor.VisitDeployment(elem)
	case elem.GroupMatch("batch") && elem.Kind == "Job":
		visitor.VisitJob(elem)
	case elem.GroupMatch("", "core") && elem.Kind == "Pod":
		visitor.VisitPod(elem)
	case elem.GroupMatch("apps", "extensions") && elem.Kind == "ReplicaSet":
		visitor.VisitReplicaSet(elem)
	case elem.GroupMatch("", "core") && elem.Kind == "ReplicationController":
		visitor.VisitReplicationController(elem)
	case elem.GroupMatch("apps") && elem.Kind == "StatefulSet":
		visitor.VisitStatefulSet(elem)
	case elem.GroupMatch("batch") && elem.Kind == "CronJob":
		visitor.VisitCronJob(elem)
	default:
		return fmt.Errorf("no visitor method exists for %v", elem)
	}
	return nil
}
```

## 总结

K8s 中包含了不少经典设计模式的例子，部分没找到合适的例子便没有提及。实际使用过程中可能多种模式都有涉及，或者是一些变种，不简单的是严格的标准定义，学会灵活应用才能提高的代码质量。

## 引用

- https://github.com/kubernetes/kubernetes
- https://aly.arriqaaq.com/golang-design-patterns/

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
