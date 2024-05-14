---
date: 2024-05-14T08:33:17.801Z
title: 如何设计一个CRD
draft: false
description: '很多文章都在讲如何创建Operator，很少有人谈怎么定义CRD'
excerpt: ''
image: ''
categories: ['cloud']
tags: ['k8s']
---

> 开始之前假设你已经有了开发Operator的相关经验，如果不了解的话可以先看下[快速实现一个Kubernetes Operator](./how-to-write-a-k8s-operator.md)。

借助kubebuilder相关工具，我们可以快速搭建一个Operator框架，但更复杂的是如何将业务抽象成CRD，本文旨在探讨设计CRD时一些关键原则与注意事项，以抛砖引玉。

## 设计原则

每个业务的内容各不相同，但可以使用一些前置原则来避免不合理的CRD带来的频繁返工。结合之前在项目中开发CRD的经验，谈谈几个关键设计原则。

### 合理的业务抽象

对业务的了解不是一蹴而就的，需要反复协商，理清业务的行为，只要这样才能开发出合适CRD。如果一上来就着急动手，后面再不断修改，反而浪费更多时间；业务如果已经上线，积重难返那么情况会更加糟糕。

以开发一个MySQL数据库为例，包含有资源、镜像版本、数据库配置、实例数量、数据卷等等，我们可以简单设计下CRD
```yaml
apiVersion: mysql.com/v1
kind: MYDB
metadata:
    name: mydb
spec:
    resources:
        memory: 10Gi
        cpu: 2
        storage: 100Gi
    version: 5.6
    configName: mysql-configmap
    passwordSecretName: mysql-secret
```

这里并没有将Pod的具体配置比如image、启动参数、卷暴露出来，CRD添加字段相对容易，废弃字段则流程更长，如果一开始将细节暴露出来，后面再隐藏会非常困难。相反地，如果业务又要支持其他新功能，比如自定义挂载卷，我们再将`spec.volume`暴露出来就容易地多。

同时也要避免过度设计，通过逐步迭代增量式扩展，不断调整CRD的结构以满足业务需求，当然前提是对CRD的初始版本得有合理的抽象。

### 最小化耦合

CRD的设计应尽量避免把细节耦合在一起。这样可以增加CRD的灵活性，使其能够适应未来的需求变化。需要将字段合理拆分, 往小了看相似的内容放到一个`Block`中，大了说使用多层资源抽象来满足不同层次的需求，比如`Deployment`、`Replicas`、`Pod`的多级抽象，每个对象有单独地控制器(Controller)，更加灵活可控。

以上面`MYDB`为例，如果又需要支持主从同步，这时候又该怎么做呢？
1. 在`MYDB`添加相关字段，`Controller`中实现相关逻辑
2. 新增`MYDBCluster`CRD以及对应`Controller`

方案2相比方案1更加灵活，即使后面支持HA、MySQL Cluster也是可以良好扩展的，单独的Controller也更加容易维护。

```yaml
apiVersion: mysql.com/v1
kind: MYDBCluster
metadata:
    name: mydb-cluster
spec:
    replicas: 1
    replication: enabled
    resources:
        ...
    version: 5.6
```

### 可扩展性与兼容性

考虑到业务的发展和变化，CRD的设计应该具有良好的可扩展性。在定义CRD时，留出足够的扩展空间，以便将来可以添加新的属性或行为，而无需对现有的CRD进行破坏性的修改。上面提到的关于字段的增加、耦合性都是扩展的一部分。同时要保持向后兼容，减少升级过程中的破坏性，符合k8s的版本控制要求。

### 符合社区规范

在开发CRD时，遵循Kubernetes社区的相关规范是至关重要的，这有助于确保CRD的一致性、可理解性和可扩展性:
- 命名规范，名称要所见所得，不厌其详(比如`podAntiAffinity`的`requiredDuringSchedulingIgnoredDuringExecution`), 相同含义的字段尽量使用社区通用的表达(比如`MYDBCluster`中的`replicas`)
- 版本规范，利用API版本控制(如v1alpha1, v1beta1)来管理不同阶段的CRD变更
- 资源复用，尽量复用官方提供的资源，比如时间类型，我们可以使用`metav1.Time`而不是`time.Time`
- 声明式而不是命令式，CRD描述的是一个期望状态

## 开发细节

### 声明式Reconcile

`Reconcile`函数是Controller实现的核心，多次执行不应该有副作用，一定程度上来说是幂等的，即它可以根据当前资源的状态和期望状态来决定需要执行的操作，而**不需要关心具体的事件类型**。

进一步来说，`Reconcile`应该通过声明式的编程，还是以`MYDBCluster`为例如果副本从3变为4，我们不应该直接创建一个新`MYDB`，而是按照以下步骤：
1. 获取资源
2. 比对当前状态去期望值
3. 根据比较结果执行操作
```golang
mydbs ：= client.ListMYDB()
createdDBs := mycluster.Spec.Replicas - len(mydbs)
for i := 0; i < createdDBs; i++ {
    createDB()
} 
```

这样做有什么好处呢？CRD是面向终态的，如果按照命令式方式，中间状态丢失会影响结果（比如用户手动删除一个`MYDB`），而声明式不会存在这样的问题，也符合k8s的设计哲学。

### `Field`与`*Field`

在CRD中Golang结构体中，有时候需要用到指针类型，有时候又不需要，该怎么处理呢？
如果字段有默认值，需要使用指针类型，指针类型可以区分用户是否设置了字段，比如`Deployment`中的`spec.replicas`, 没有设置副本`Replicas`是`nil`，如果直接`int32`类型，将无法判断用户是设置为0了还是没有设置。
```golang
type DeploymentSpec struct {
	// Number of desired pods. This is a pointer to distinguish between explicit
	// zero and not specified. Defaults to 1.
	// +optional
	Replicas *int32 `json:"replicas,omitempty" protobuf:"varint,1,opt,name=replicas"`
}
```

通过使用指针类型，我们可以清晰地判断用户是否显式设置了字段，避免不一致性。

### 字段验证

通过`+kubebuilder:validation`标签，我们可以方面的验证字段是否合法，如果字段的是必须的，我们不能设置`json:"omitempty"`，否则验证会失效。原因是由于在序列化之后无法区分用户是自己设置的零值还是没有设置。

### Finalizer

在开发Controller时，使用`Finalizer`是一种良好的实践，用于确保资源的清理和回收。当Controller宕机时，Finalizer可以阻止资源的删除，从而避免丢失事件。

## 总结

设计CRD不是一蹴而就的，需要结合实际需求，不断迭代与优化，本文介绍了一些设计原则以及细节处理，希望对你在Kubernetes Operator开发之路上有一点帮助。


> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
