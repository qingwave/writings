---
title: 快速实现一个Kubernetes Operator
author: qinng
toc: true
comments: true
description: "借助Kubebuilder实现2048游戏的控制器"
image: /img/blog/crd_mygame.png
tags:
  - k8s
date: 2021-08-12 02:58:47
categories:
  - cloud
---

Kubernetes 提供了众多的扩展功能，比如 CRD、CRI、CSI 等等，强大的扩展功能让 k8s 迅速占领市场。[Operator](https://kubernetes.io/zh/docs/concepts/extend-kubernetes/operator/)模式可以实现 CRD 并管理自定义资源的生命周期，本文基于[kubebuilder](https://kubebuilder.io/)快速实现一个 Operator，示例源码见[mygame](https://github.com/qingwave/mygame)。

<!--more-->

## Kubebuilder

`kubebuilder`是一个官方提供快速实现 Operator 的工具包，可快速生成 k8s 的 CRD、Controller、Webhook，用户只需要实现业务逻辑。

> 类似工具还有[operader-sdk](https://sdk.operatorframework.io/)，目前正在与`Kubebuilder`融合

kubebuilder 封装了`controller-runtime`与`controller-tools`，通过`controller-gen`来生产代码，简化了用户创建 Operator 的步骤。

一般创建 Operator 流程如下：

1. 创建工作目录，初始化项目
2. 创建 API，填充字段
3. 创建 Controller，编写核心协调逻辑(Reconcile)
4. 创建 Webhook，实现接口，可选
5. 验证测试
6. 发布到集群中

## 示例

我们准备创建一个 2048 的游戏，对外可以提供服务，也能方便地扩缩容。

### 准备环境

首先你需要有 Kubernetes、Docker、Golang 相关环境。
Linux 下安装 kubebuilder

```bash
curl -L -o kubebuilder https://go.kubebuilder.io/dl/latest/$(go env GOOS)/$(go env GOARCH)
chmod +x kubebuilder && mv kubebuilder /usr/local/bin/
```

### 创建项目

```
mkdir -p ~/work/mygame && cd $_
kubebuilder init --domain qingwave.github.io --repo qingwave.github.io/mygame
```

### 创建 API

```
kubebuilder create api --group myapp --version v1 --kind Game

Create Resource [y/n]
y #生成CR
Create Controller [y/n]
y #生成Controller
```

目录结构如下：

```
├── api
│   └── v1 # CRD定义
├── bin
│   └── controller-gen
├── config
│   ├── crd # crd配置
│   ├── default
│   ├── manager # operator部署文件
│   ├── prometheus
│   ├── rbac
│   └── samples # cr示例
├── controllers
│   ├── game_controller.go # controller逻辑
│   └── suite_test.go
├── Dockerfile
├── go.mod
├── go.sum
├── hack
│   └── boilerplate.go.txt # 头文件模板
├── main.go # 项目主函数
├── Makefile
└── PROJECT #项目元数据
```

### 编写 API

在`mygame/api/v1/game_types.go`定义我们需要的字段

`Spec`配置如下

```go
type GameSpec struct {
	// Number of desired pods. This is a pointer to distinguish between explicit
	// zero and not specified. Defaults to 1.
	// +optional
	//+kubebuilder:default:=1
	//+kubebuilder:validation:Minimum:=1
	Replicas *int32 `json:"replicas,omitempty" protobuf:"varint,1,opt,name=replicas"`

	// Docker image name
	// +optional
	Image string `json:"image,omitempty"`

	// Ingress Host name
	Host string `json:"host,omitempty"`
}
```

> `kubebuilder:default`可以设置默认值

`Status`定义如下

```go
const (
	Running  = "Running"
	Pending  = "Pending"
	NotReady = "NotReady"
	Failed   = "Failed"
)

type GameStatus struct {
	// Phase is the phase of guestbook
	Phase string `json:"phase,omitempty"`

	// replicas is the number of Pods created by the StatefulSet controller.
	Replicas int32 `json:"replicas"`

	// readyReplicas is the number of Pods created by the StatefulSet controller that have a Ready Condition.
	ReadyReplicas int32 `json:"readyReplicas"`

	// LabelSelector is label selectors for query over pods that should match the replica count used by HPA.
	LabelSelector string `json:"labelSelector,omitempty"`
}
```

另外需要添加`scale`接口

```
//+kubebuilder:subresource:scale:specpath=.spec.replicas,statuspath=.status.replicas,selectorpath=.status.labelSelector
```

添加`kubectl`展示参数

```
//+kubebuilder:printcolumn:name="Phase",type="string",JSONPath=".status.phase",description="The phase of game."
//+kubebuilder:printcolumn:name="Host",type="string",JSONPath=".spec.host",description="The Host Address."
//+kubebuilder:printcolumn:name="DESIRED",type="integer",JSONPath=".spec.replicas",description="The desired number of pods."
//+kubebuilder:printcolumn:name="CURRENT",type="integer",JSONPath=".status.replicas",description="The number of currently all pods."
//+kubebuilder:printcolumn:name="READY",type="integer",JSONPath=".status.readyReplicas",description="The number of pods ready."
//+kubebuilder:printcolumn:name="AGE",type="date",JSONPath=".metadata.creationTimestamp",description="CreationTimestamp is a timestamp representing the server time when this object was created. It is not guaranteed to be set in happens-before order across separate operations. Clients may not set this value. It is represented in RFC3339 form and is in UTC."
```

### 编写 Controller 逻辑

Controller 的核心逻辑在`Reconcile`中，我们只需要填充自己的业务逻辑

```go
func (r *GameReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)
	logger.Info("revice reconcile event", "name", req.String())

	// 获取game对象
	game := &myappv1.Game{}
	if err := r.Get(ctx, req.NamespacedName, game); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

  // 如果处在删除中直接跳过
	if game.DeletionTimestamp != nil {
		logger.Info("game in deleting", "name", req.String())
		return ctrl.Result{}, nil
	}

  // 同步资源，如果资源不存在创建deployment、ingress、service，并更新status
	if err := r.syncGame(ctx, game); err != nil {
		logger.Error(err, "failed to sync game", "name", req.String())
		return ctrl.Result{}, nil
	}

	return ctrl.Result{}, nil
}
```

添加 rbac 配置

```
//+kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
//+kubebuilder:rbac:groups=apps,resources=deployments/status,verbs=get;update;patch
//+kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch;delete
//+kubebuilder:rbac:groups=networking,resources=ingresses,verbs=get;list;watch;create;update;patch;delete
```

具体`syncGame`逻辑如下

```go
func (r *GameReconciler) syncGame(ctx context.Context, obj *myappv1.Game) error {
	logger := log.FromContext(ctx)

	game := obj.DeepCopy()
	name := types.NamespacedName{
		Namespace: game.Namespace,
		Name:      game.Name,
	}

  // 构造owner
	owner := []metav1.OwnerReference{
		{
			APIVersion:         game.APIVersion,
			Kind:               game.Kind,
			Name:               game.Name,
			Controller:         pointer.BoolPtr(true),
			BlockOwnerDeletion: pointer.BoolPtr(true),
			UID:                game.UID,
		},
	}

	labels := game.Labels
	labels[gameLabelName] = game.Name
	meta := metav1.ObjectMeta{
		Name:            game.Name,
		Namespace:       game.Namespace,
		Labels:          labels,
		OwnerReferences: owner,
	}

  // 获取对应deployment, 如不存在则创建
	deploy := &appsv1.Deployment{}
	if err := r.Get(ctx, name, deploy); err != nil {
		if !errors.IsNotFound(err) {
			return err
		}
		deploy = &appsv1.Deployment{
			ObjectMeta: meta,
			Spec:       getDeploymentSpec(game, labels),
		}
		if err := r.Create(ctx, deploy); err != nil {
			return err
		}
		logger.Info("create deployment success", "name", name.String())
	} else {
    // 如果存在对比和game生成的deployment是否一致，不一致则更新
		want := getDeploymentSpec(game, labels)
		get := getSpecFromDeployment(deploy)
		if !reflect.DeepEqual(want, get) {
			deploy = &appsv1.Deployment{
				ObjectMeta: meta,
				Spec:       want,
			}
			if err := r.Update(ctx, deploy); err != nil {
				return err
			}
			logger.Info("update deployment success", "name", name.String())
		}
	}

  //service创建
	svc := &corev1.Service{}
	if err := r.Get(ctx, name, svc); err != nil {
	  ...
	}

  // ingress创建
	ing := &networkingv1.Ingress{}
	if err := r.Get(ctx, name, ing); err != nil {
		...
	}

	newStatus := myappv1.GameStatus{
		Replicas:      *game.Spec.Replicas,
		ReadyReplicas: deploy.Status.ReadyReplicas,
	}

	if newStatus.Replicas == newStatus.ReadyReplicas {
		newStatus.Phase = myappv1.Running
	} else {
		newStatus.Phase = myappv1.NotReady
	}

  // 更新状态
	if !reflect.DeepEqual(game.Status, newStatus) {
		game.Status = newStatus
		logger.Info("update game status", "name", name.String())
		return r.Client.Status().Update(ctx, game)
	}

	return nil
}
```

默认情况下生成的 controller 只监听自定义资源，在示例中我们也需要监听`game`的子资源，如监听`deployment`是否符合预期

```go
// SetupWithManager sets up the controller with the Manager.
func (r *GameReconciler) SetupWithManager(mgr ctrl.Manager) error {
	// 创建controller
	c, err := controller.New("game-controller", mgr, controller.Options{
		Reconciler:              r,
		MaxConcurrentReconciles: 3, //controller运行的worker数
	})
	if err != nil {
		return err
	}

	//监听自定义资源
	if err := c.Watch(&source.Kind{Type: &myappv1.Game{}}, &handler.EnqueueRequestForObject{}); err != nil {
		return err
	}

	//监听deployment,将owner信息即game namespace/name添加到队列
	if err := c.Watch(&source.Kind{Type: &appsv1.Deployment{}}, &handler.EnqueueRequestForOwner{
		OwnerType:    &myappv1.Game{},
		IsController: true,
	}); err != nil {
		return err
	}

	return nil
}
```

### 部署验证

安装 CRD

```
make install
```

本地运行 operator

```
make run
```

修改 sample 文件`config/samples/myapp_v1_game.yaml`

```yaml
apiVersion: myapp.qingwave.github.io/v1
kind: Game
metadata:
  name: game-sample
spec:
  replicas: 1
  image: alexwhen/docker-2048
  host: mygame.io
```

部署`game-sample`

```
kubectl apply -f config/samples/myapp_v1_game.yaml
```

查看`game`自定义资源状态

```bash
# 查看game
kubectl get game
NAME          PHASE     HOST        DESIRED   CURRENT   READY   AGE
game-sample   Running   mygame.io   1         1         1       6m

# 查看deploy
kubectl get deploy game-sample
NAME          READY   UP-TO-DATE   AVAILABLE   AGE
game-sample   1/1     1            1           6m

# 查看ingress
kubectl get ing game-sample
NAME          CLASS    HOSTS       ADDRESS        PORTS   AGE
game-sample   <none>   mygame.io   192.168.49.2   80      7m
```

验证应用，在`/etc/hosts`中添加`<Ingress ADDRESS Ip>	mygame.io`，访问浏览器如下图所示
![2048](/img/blog/crd_mygame.png)

验证扩容

```bash
kubectl scale games.myapp.qingwave.github.io game-sample --replicas 2
game.myapp.qingwave.github.io/game-sample scaled

# 扩容后
kubectl get games.myapp.qingwave.github.io
NAME          PHASE     HOST        DESIRED   CURRENT   READY   AGE
game-sample   Running   mygame.io   2         2         2       7m
```

如需部署`Operator`到集群中，可参考官方文档，制作镜像并上传，运行`make deploy`

### Webhook

通常我们需要与 CR 自定义资源设置部分字段的默认值，或者验证字段是否合法，这就需要自己实现`Webhook`，`Kubebuilder`也提供了`Webhook`的功能。

通过设置`--defaulting`可创建[mutatingadmissionwebhook](https://kubernetes.io/zh/docs/reference/access-authn-authz/admission-controllers/#mutatingadmissionwebhook)类型准入控制器，用来修改传入资源；参数`--programmatic-validation`可创建[validatingadmissionwebhook](https://kubernetes.io/zh/docs/reference/access-authn-authz/admission-controllers/#validatingadmissionwebhook)，用来验证传入资源

> 在资源创建、修改时`apiserver`会通过 http 调用`webhook`提供的接口，所以会带来额外开销，简单的验证工作可通过`//+kubebuilder:validation`注解，直接通过`openapi`验证，性能更好

```bash
kubebuilder create webhook --group myapp --version v1 --kind Game --defaulting --programmatic-validation
```

生成文件在`api/v1/game_webhook.go`

`Default`接口可实现修改资源，根据 kubebuilder 注释,当`game`资源`create`与`update`时，调用这个接口

```
//+kubebuilder:webhook:path=/mutate-myapp-qingwave-github-io-v1-game,mutating=true,failurePolicy=fail,sideEffects=None,groups=myapp.qingwave.github.io,resources=games,verbs=create;update,versions=v1,name=mgame.kb.io,admissionReviewVersions={v1,v1beta1}
```

```go
const (
	defaultImage = `alexwhen/docker-2048`
)

// Default implements webhook.Defaulter so a webhook will be registered for the type
func (r *Game) Default() {
	gamelog.Info("default", "name", r.Name)

	// 设置默认镜像
	if r.Spec.Image == "" {
		r.Spec.Image = defaultImage
	}

	// 设置默认Host
	if r.Spec.Host == "" {
		r.Spec.Host = fmt.Sprintf("%s.%s.mygame.io", r.Name, r.Namespace)
	}
}
```

同样的通过`ValidateCreate`、`ValidateUpdate`可实现`validating webhook`

```go
func (r *Game) ValidateCreate() error {
	gamelog.Info("validate create", "name", r.Name)

	// Host不能包括通配符
	if strings.Contains(r.Spec.Host, "*") {
		return errors.New("host should not contain *")
	}
	return nil
}
```

本地验证 webhook 需要配置证书，在集群中测试更方便点，可参考官方文档。

## 总结

至此，我们已经实现了一个功能完全的`game-operator`，可以管理`game`资源的生命周期，创建/更新 game 时会自动创建`deployment、service、ingress`等资源，当`deployment`被误删或者误修改时也可以自动回复到期望状态，也实现了`scale`接口。

通过`kubebuiler`大大简化了开发`operator`的成本，我们只需要关心业务逻辑即可，不需要再手动去创建`client/controller`等，但同时`kubebuilder`生成的代码中屏蔽了很多细节，比如`controller`的最大 worker 数、同步时间、队列类型等参数设置，只有了解`operator`的原理才更好应用于生产。

## 引用

- https://book.kubebuilder.io/
