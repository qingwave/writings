---
date: 2023-08-16T09:20:10.001Z
title: 千呼万唤始出来的K8s Sidecar
draft: false
description: '新版Sidecar使用与解析'
excerpt: ''
image: 'https://images.unsplash.com/photo-1683372803044-13ebe4b7c7e1?q=80&w=1887&auto=format&fit=crop&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D'
categories: ['cloud']
tags: ['k8s']
---

随着Kubernetes发布了[1.28](https://kubernetes.io/blog/2023/08/15/kubernetes-v1-28-release/)，支持了不少重磅特性，其中最令人感慨的莫过于新的Sidecar，目前是alpha版本。

之前Sidecar的称谓只是一种多容器的设计模式，在K8s看来和普通容器没什么不一样，但由于其生命周期与业务容器并不一致，对于Sidecar的生命周期管理一直是个问题，我也写过[相关解决办法](/k8s-sideccar-lifecycle)。

最早在15年就K8s Blog就提到了[Sidecar](https://kubernetes.io/blog/2015/06/the-distributed-system-toolkit-patterns/#example-1-sidecar-containers)，1.18发布前，当时很多文章宣称将支持Sidecar，但最终还是没能进入Master，三、四年多过去了，工作都换了几份，终于等来了它。

## 快速上手

目前Sidecar默认不开启，需要开启对应Feature Gate `SidecarContainers`，以minikube为例快速开启Sidecar（kind目前对1.28支持有问题）:
```sh
# 目前minikube默认版本小于1.28.0，需要指定k8s版本，后续升级后可不需要
minikube start --feature-gates=SidecarContainers=true --kubernetes-version=v1.28.0
```

新版本的Sidecar是放置在`initContainers`中，指定`restartPolicy`为`Always`便开启Sidecar，其生命周期以及重启管理与普通容器也是一样的。

下面是一个带有Sidecar的Deployment示例，`log` Sidecar容器用来输出日志到终端，`main`容器模拟写入日志:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  labels:
    app: myapp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
        - name: main
          image: alpine:latest
          command: ['sh', '-c', 'while true; do echo "logging" >> /opt/logs.txt; sleep 1; done']
          volumeMounts:
            - name: data
              mountPath: /opt
      initContainers:
        - name: log # sidecar 容器
          image: alpine:latest
          restartPolicy: Always # 必须指定restartPolicy为Always才能开启sidecar
          command: ['sh', '-c', 'tail -F /opt/logs.txt']
          volumeMounts:
            - name: data
              mountPath: /opt
      volumes:
        - name: data
          emptyDir: {}
```

部署到K8s集群中，可以看到`initContainers[*].restartPolicy`字段，如果不开启Feature Gate是没有这个字段的：
```sh
> kubectl create -f deploy-sidecar.yaml
deployment.apps/myapp created

> kubectl get po -l app=myapp -ojsonpath='{.items[0].spec.initContainers[0].restartPolicy}'
Always

> kubectl get po  -l app=myapp  
NAME                    READY   STATUS    RESTARTS   AGE
myapp-5698fbb8d-rpjzn   2/2     Running   0          3m25s
```

myapp Pod中两个容器都是Ready(`2/2`)，查看日志可以看到`log` Sidecar一直在输出日志。
```sh
> kubectl logs -l app=myapp -c logshipper -f
logging
logging
```

## 源码分析

相关源码在[kubernetes#116429](https://github.com/kubernetes/kubernetes/pull/116429)。

这次的Sidecar是通过初始化容器实现的，在`Container`类型中添加了额外的字段`RestartPolicy`，目前只支持`Always`策略:
```go
// Container represents a single container that is expected to be run on the host.
type Container struct {
	// Required: This must be a DNS_LABEL.  Each container in a pod must
	// have a unique name.
	Name string
	// Required.
	Image string
	// ...
	
	// +featureGate=SidecarContainers
	// +optional
	RestartPolicy *ContainerRestartPolicy

    // ...
}
```
容器的重启策略有以下几种情况：
- 普通容器不可设置，由`Pod.RestartPolicy`决定重启行为
- 初始化容器默认缺省，重启行为由`Pod.RestartPolicy`决定，当Pod设置为`Always`，容器按照`OnFailure`策略
- 初始化容器设置为`Always`，即Sidecar容器会长时间运行

通常Sidecar有特殊的启动顺序，先于业务容器启动，后于业务容器退出，比如日志收集Sidecar、服务网络Istio Envoy等。

### 启动顺序

由于初始化容器是有序启动的，Sidecar容器`Ready`后才会启动下一个，这部分复用了`InitContainers`的逻辑。

特别注意的是，启动Sidecar初始化容器时，并不会等会启完成（`Completed`），这和普通的初始化容器是不一样的。关于初始化容器启动顺序主要在`kuberuntime_container.go`中的[computeInitContainerActions](https://github.com/kubernetes/kubernetes/blob/v1.28.0/pkg/kubelet/kuberuntime/kuberuntime_container.go#L881)

```go
func (m *kubeGenericRuntimeManager) computeInitContainerActions(pod *v1.Pod, podStatus *kubecontainer.PodStatus, changes *podActions) bool {
  //...
  for i := len(pod.Spec.InitContainers) - 1; i >= 0; i-- {
		container := &pod.Spec.InitContainers[i]
		status := podStatus.FindContainerStatusByName(container.Name)
		if status == nil {
			// 如果普通容器初始化了并且Sidecar没有状态，启动Sidecar
			if isPreviouslyInitialized && types.IsRestartableInitContainer(container) {
				changes.InitContainersToStart = append(changes.InitContainersToStart, i)
			}
			continue //找到最后需要处理的容器
		}

		if isPreviouslyInitialized && !types.IsRestartableInitContainer(container) {
			// 初始化过，Sidecar容器保持Running
			continue
		}

    switch status.State {
		case kubecontainer.ContainerStateCreated:
			// nothing to do but wait for it to start

		case kubecontainer.ContainerStateRunning:
      // 等待普通容器运行结束
			if !types.IsRestartableInitContainer(container) {
				break
			}

			if types.IsRestartableInitContainer(container) {
        if container.StartupProbe != nil {} // 执行探针, StartupProbe与LivenessProbe


      }
    }
  }

  // 如果没有初始化，取第一个容器开始处理 
  if !isPreviouslyInitialized {
		changes.InitContainersToStart = append(changes.InitContainersToStart, 0)
	}
}
```

详细启动流程如下：
1. 启动时，从第一个初始化容器开始处理
2. 获取上一个有状态的容器
3. - 对于普通初始化容器，容器状态执行完成（`exited 0`），继续执行下一个；失败则根据Pod的重启策略进行处理
   - 对于Sidecar，状态为`running`不额外处理（含有探针需要执行对应探针），状态为`exited`进行重启
5. 重复步骤2直到处理完所有初始化容器

### 终止顺序

很遗憾目前Alpha版本不支持Sidecar按照特定的顺序退出，退出时将Sidecar将视作普通容器，后续Beta版本可能会支持。

当Pod需要删除时，会调用`killPodWithSyncResult`，获取当前Pod的所有`Running`容器（包括Sidecar）进行删除
```go
func (m *kubeGenericRuntimeManager) killContainersWithSyncResult(ctx context.Context, pod *v1.Pod, runningPod kubecontainer.Pod, gracePeriodOverride *int64) (syncResults []*kubecontainer.SyncResult) {
	containerResults := make(chan *kubecontainer.SyncResult, len(runningPod.Containers))
	wg := sync.WaitGroup{}

	wg.Add(len(runningPod.Containers))
	for _, container := range runningPod.Containers {
		go func(container *kubecontainer.Container) {
			defer utilruntime.HandleCrash()
			defer wg.Done()

			killContainerResult := kubecontainer.NewSyncResult(kubecontainer.KillContainer, container.Name)
			if err := m.killContainer(ctx, pod, container.ID, container.Name, "", reasonUnknown, gracePeriodOverride); err != nil {
				//...
			}
			containerResults <- killContainerResult
		}(container)
	}
```

好消息是当前版本支持了Job Sidecar的清理，当Job的常规Pod执行完会被标记为`KillPod`，然后将清理所有容器。
```go
func (m *kubeGenericRuntimeManager) computePodActions(ctx context.Context, pod *v1.Pod, podStatus *kubecontainer.PodStatus) podActions {
  //...
  if keepCount == 0 && len(changes.ContainersToStart) == 0 {
		changes.KillPod = true
		// To prevent the restartable init containers to keep pod alive, we should
		// not restart them.
		changes.InitContainersToStart = nil
	}
}
```

## 一些思考

目前版本的Sidecar实现可以解决启动问题、Job Sidecar清理问题，但对于退出顺序则需要等待后续支持。

通过`InitContainer`来实现Sidecar比较最大程度的复用之前逻辑（复用初始化容器启动顺序，同时为Container添加了RestartPolicy），相对于之前为`lifecycle: sidecar`改动更小，后续也方便支持容器的不同重启类型。

但也引入了一些新的问题：
- `InitContainer`语义发生了极大的变化，会有歧义，后续可能会替换成`infrastructureContainers`
- 有关Pod的资源计算（Pod Requested Resource）需要重新纠正，比如[HPA](https://github.com/kubernetes/kubernetes/issues/119991)、监控相关的指标/面板

向前迈入一步总归是好事，Kubernetes越来越成熟，也变得有点没趣，一个Feature从提案到生产可用要走很长的流程，好在社区还是非常活跃，希望Ta越来越好吧。

## 引用
- https://kubernetes.io/docs/concepts/workloads/pods/init-containers/
- https://github.com/kubernetes/enhancements/blob/master/keps/sig-node/753-sidecar-containers/README.md

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
