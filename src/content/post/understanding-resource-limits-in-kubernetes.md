---
title: 深入理解K8s资源限制
date: 2019-01-09 16:34:33
tags:
  - k8s
  - docker
  - cgroup
categories:
  - cloud
---

> 本文翻译自[understanding-resource-limits-in-kubernetes-memory](https://medium.com/@betz.mark/understanding-resource-limits-in-kubernetes-memory-6b41e9a955f9)

## 写在前面

当我开始大范围使用 Kubernetes 的时候，我开始考虑一个我做实验时没有遇到的问题：当集群里的节点没有足够资源的时候，Pod 会卡在`Pending`状态。你是没有办法给节点增加 CPU 或者内存的，那么你该怎么做才能将这个 Pod 从这个节点拿走？

最简单的办法是添加另一个节点。但是这个策略无法发挥出 Kubernetes 最重要的一个能力：即它优化计算资源使用的能力。这些场景里面实际的问题并不是节点太小，而是我们没有仔细为 Pod 计算过资源限制。

资源限制是我们可以向 Kubernetes 提供的诸多配置之一，它意味着两点：
- 工作负载运行需要哪些资源
- 最多允许消费多少资源

第一点对于调度器而言十分重要，因为它要以此选择合适的节点。第二点对于 Kubelet 非常重要，每个节点上的守护进程 Kubelet 负责 Pod 的运行健康状态。

大多数本文的读者可能对资源限制有一定的了解，实际上这里面有很多有趣的细节。

## 资源限制

资源限制是通过每个容器 containerSpec 的 resources 字段进行设置的，它是 v1 版本的 ResourceRequirements 类型的 API 对象。每个指定了"limits"和"requests"的对象都可以控制对应的资源。

目前只有 CPU 和内存两种资源。大多数情况下，deployment、statefulset、daemonset 的定义里都包含了 podSpec 和多个 containerSpec。这里有个完整的 v1 资源对象的 yaml 格式配置：

```yaml
resources:
    requests:
        cpu: 50m
        memory: 50Mi
  limits:
        cpu: 100m
        memory: 100Mi
```

这个对象可以这么理解：这个容器通常情况下，需要 5%的 CPU 时间和 50MiB 的内存（requests），同时最多允许它使用 10%的 CPU 时间和 100MiB 的内存（limits）。

我会对`requests`和`limits`的区别做进一步讲解，但是一般来说，在调度的时候`requests`比较重要，在运行时`limits`比较重要。尽管资源限制配置在每个容器上，你可以认为 Pod 的资源限制就是它里面容器的资源限制之和，我们可以从系统的视角观察到这种关系。

### 内存限制

通常情况下分析内存要比分析 CPU 简单一些，所以我从这里开始着手。我的一个目标是给大家展示内存在系统中是如何实现的，也就是 Kubernetes 对容器运行时（docker/containerd）所做的工作，容器运行时对 Linux 内核所做的工作。从分析内存资源限制开始也为后面分析 CPU 打好了基础。

首先，让我们回顾一下前面的例子：
```yaml
resources:
  requests:
    memory: 50Mi
  limits:
    memory: 100Mi
```

单位后缀 Mi 表示的是 MiB，所以这个资源对象定义了这个容器需要 50MiB 并且最多能使用 100MiB 的内存。当然还有其他单位可以进行表示。

为了了解如何用这些值是来控制容器进程，我们来创建一个没有配置内存限制的 Pod:

```bash
$ kubectl run limit-test --image=busybox --command -- /bin/sh -c "while true; do sleep 2; done"
deployment.apps "limit-test" created
```

用 Kubectl 命令我们可以验证这个 Pod 是没有资源限制的：

```bash
$ kubectl get pods limit-test-7cff9996fc-zpjps -o=jsonpath='{.spec.containers[0].resources}'
map[]
```

Kubernetes 最酷的一点是你可以跳到系统以外的角度来观察每个构成部分，所以我们登录到运行 Pod 的节点，看看 Docker 是如何运行这个容器的：

```bash
$ docker ps | grep busy | cut -d' ' -f1
5c3af3101afb
$ docker inspect 5c3af3101afb -f "{{.HostConfig.Memory}}"
0
```

这个容器的`.HostConfig.Memory`域对应了 docker run 时的`--memory`参数，0 值表示未设定。Docker 会对这个值做什么？为了控制容器进程能够访问的内存数量，Docker 配置了一组 control group，或者叫 cgroup。

> Cgroup 在 2008 年 1 月时合并到 Linux 2.6.24 版本的内核。它是一个很重要的话题。我们说 cgroup 是容器的一组用来控制内核如何运行进程的相关属性集合。针对内存、CPU 和各种设备都有对应的 cgroup。Cgroup 是具有层级的，这意味着每个 cgroup 拥有一个它可以继承属性的父亲，往上一直直到系统启动时创建的 root cgroup。

Cgroup 可以通过/proc 和/sys 伪文件系统轻松查看到，所以检查容器如何配置内存的 cgroup 就很简单了。在容器的 Pid namespace 里，根进程的 pid 为 1，但是 namespace 以外它呈现的是系统级 pid，我们可以用来查找它的 cgroups：

```bash
$ ps ax | grep /bin/sh
   9513 ?        Ss     0:00 /bin/sh -c while true; do sleep 2; done
$ sudo cat /proc/9513/cgroup
...
6:memory:/kubepods/burstable/podfbc202d3-da21-11e8-ab5e-42010a80014b/0a1b22ec1361a97c3511db37a4bae932d41b22264e5b97611748f8b662312574
```

我列出了内存 cgroup，这正是我们所关注的。你在路径里可以看到前面提到的 cgroup 层级。一些比较重要的点是：

首先，这个路径是以 kubepods 开始的 cgroup，所以我们的进程继承了这个 group 的每个属性，还有 burstable 的属性（Kubernetes 将 Pod 设置为`burstable QoS`类别）和一组用于审计的 Pod 表示。

最后一段路径是我们进程实际使用的 cgroup。我们可以把它追加到`/sys/fs/cgroups/memory`后面查看更多信息：

```bash
$ ls -l /sys/fs/cgroup/memory/kubepods/burstable/podfbc202d3-da21-11e8-ab5e-42010a80014b/0a1b22ec1361a97c3511db37a4bae932d41b22264e5b97611748f8b662312574
...
-rw-r--r-- 1 root root 0 Oct 27 19:53 memory.limit_in_bytes
-rw-r--r-- 1 root root 0 Oct 27 19:53 memory.soft_limit_in_bytes
```

再一次，我只列出了我们所关心的记录。我们暂时不关注`memory.soft_limit_in_bytes`，而将重点转移到`memory.limit_in_bytes`属性，它设置了内存限制。它等价于 Docker 命令中的`--memory`参数，也就是 Kubernetes 里的内存资源限制。我们看看：

```bash
$ sudo cat /sys/fs/cgroup/memory/kubepods/burstable/podfbc202d3-da21-11e8-ab5e-42010a80014b/0a1b22ec1361a97c3511db37a4bae932d41b22264e5b97611748f8b662312574/memory.limit_in_bytes
9223372036854771712
```

这是没有设置资源限制时我的节点上显示的情况。这里有对它的一个简单的[解释](https://unix.stackexchange.com/questions/420906/what-is-the-value-for-the-cgroups-limit-in-bytes-if-the-memory-is-not-restricte)。 所以我们看到如果没有在 Kubernetes 里设置内存限制的话，会导致 Docker 设置`HostConfig.Memory`值为 0，并进一步导致容器进程被放置在默认值为"no limit"的`memory.limit_in_bytes`内存 cgroup 下。

我们现在创建使用 100MiB 内存限制的 Pod：
```bash
$ kubectl run limit-test --image=busybox --limits "memory=100Mi" --command -- /bin/sh -c "while true; do sleep 2; done"
deployment.apps "limit-test" created
```

我们再一次使用 kubectl 验证我们的资源配置：

```bash
$ kubectl get pods limit-test-5f5c7dc87d-8qtdx -o=jsonpath='{.spec.containers[0].resources}'
map[limits:map[memory:100Mi] requests:map[memory:100Mi]]
```

你会注意到除了我们设置的`limits`外，Pod 还增加了 requests。当你设置`limits`而没有设置`requests`时，Kubernetes 默认让`requests`等于 limits。如果你从调度器的角度看这是非常有意义的。我会在下面进一步讨论 requests。当这个 Pod 启动后，我们可以看到 Docker 如何配置的容器以及这个进程的内存 cgroup：

```bash
$ docker ps | grep busy | cut -d' ' -f1
8fec6c7b6119
$ docker inspect 8fec6c7b6119 --format '{{.HostConfig.Memory}}'
104857600
$ ps ax | grep /bin/sh
   29532 ?      Ss     0:00 /bin/sh -c while true; do sleep 2; done
$ sudo cat /proc/29532/cgroup
...
6:memory:/kubepods/burstable/pod88f89108-daf7-11e8-b1e1-42010a800070/8fec6c7b61190e74cd9f88286181dd5fa3bbf9cf33c947574eb61462bc254d11
$ sudo cat /sys/fs/cgroup/memory/kubepods/burstable/pod88f89108-daf7-11e8-b1e1-42010a800070/8fec6c7b61190e74cd9f88286181dd5fa3bbf9cf33c947574eb61462bc254d11/memory.limit_in_bytes
104857600
```

正如你所见，Docker 基于我们的 containerSpec 正确地设置了这个进程的内存 cgroup。但是这对于运行时意味着什么？Linux 内存管理是一个复杂的话题，Kubernetes 工程师需要知道的是：当一个宿主机遇到了内存资源压力时，内核可能会有选择性地杀死进程。

如果一个使用了多于限制内存的进程会有更高几率被杀死。因为 Kubernetes 的任务是尽可能多地向这些节点上安排 Pod，这会导致节点内存压力异常。如果你的容器使用了过多内存，那么它很可能会被 oom-killed。如果 Docker 收到了内核的通知，Kubernetes 会找到这个容器并依据设置尝试重启这个 Pod。

所以 Kubernetes 默认创建的内存`requests`是什么？拥有一个 100MiB 的内存请求会影响到 cgroup？可能它设置了我们之前看到的`memory.soft_limit_in_bytes`？让我们看看：

```bash
$ sudo cat /sys/fs/cgroup/memory/kubepods/burstable/pod88f89108-daf7-11e8-b1e1-42010a800070/8fec6c7b61190e74cd9f88286181dd5fa3bbf9cf33c947574eb61462bc254d11/memory.soft_limit_in_bytes
9223372036854771712
```

你可以看到软限制仍然被设置为默认值“no limit”。即使 Docker 支持通过参数`--memory-reservation`进行设置，但 Kubernetes 并不支持这个参数。这是否意味着为你的容器指定内存`requests`并不重要？不，不是的。`requests`要比`limits`更重要。limits 告诉 Linux 内核什么时候你的进程可以为了清理空间而被杀死。`requests`帮助 Kubernetes 调度找到合适的节点运行 Pod。如果不设置它们，或者设置得非常低，那么可能会有不好的影响。

例如，假设你没有配置内存`requests`来运行 Pod，而配置了一个较高的 limits。正如我们所知道的 Kubernetes 默认会把`requests`的值指向 limits，如果没有合适的资源的节点的话，Pod 可能会调度失败，即使它实际需要的资源并没有那么多。

另一方面，如果你运行了一个配置了较低`requests`值的 Pod，你其实是在鼓励内核 oom-kill 掉它。为什么？假设你的 Pod 通常使用 100MiB 内存，你却只为它配置了 50MiB 内存 requests。如果你有一个拥有 75MiB 内存空间的节点，那么这个 Pod 会被调度到这个节点。当 Pod 内存消耗扩大到 100MiB 时，会让这个节点压力变大，这个时候内核可能会选择杀掉你的进程。所以我们要正确配置 Pod 的内存`requests`和 limits。

### CPU 限制

CPU 资源限制比内存资源限制更复杂，原因将在下文详述。幸运的是 CPU 资源限制和内存资源限制一样都是由 cgroup 控制的，上文中提到的思路和工具在这里同样适用，我们只需要关注他们的不同点就行了。

首先，让我们将 CPU 资源限制添加到之前示例中的 yaml：

```yaml
resources:
  requests:
    memory: 50Mi
    cpu: 50m
  limits:
    memory: 100Mi
    cpu: 100m
```

单位后缀 m 表示千分之一核，也就是说 1 Core = 1000m。因此该资源对象指定容器进程需要 50/1000 核（5%）才能被调度，并且允许最多使用 100/1000 核（10%）。同样，2000m 表示两个完整的 CPU 核心，你也可以写成 2 或者 2.0。

为了了解 Docker 和 cgroup 如何使用这些值来控制容器，我们首先创建一个只配置了 CPU`requests`的 Pod：
```bash
$ kubectl run limit-test --image=busybox --requests "cpu=50m" --command -- /bin/sh -c "while true; do sleep 2; done"
deployment.apps "limit-test" created
```

通过 kubectl 命令我们可以验证这个 Pod 配置了 50m 的 CPU requests：

```bash
$ kubectl get pods limit-test-5b4c495556-p2xkr -o=jsonpath='{.spec.containers[0].resources}'
map[requests:map[cpu:50m]]
```

我们还可以看到 Docker 为容器配置了相同的资源限制：

```bash
$ docker ps | grep busy | cut -d' ' -f1
f2321226620e

$ docker inspect f2321226620e --format '{{.HostConfig.CpuShares}}'
51
```

这里显示的为什么是 51，而不是 50？这是因为 Linux cgroup 和 Docker 都将 CPU 核心数分成了 1024 个时间片（shares），而 Kubernetes 将它分成了 1000 个`shares`。

`shares`用来设置 CPU 的相对值，并且是针对所有的 CPU（内核），默认值是 1024，假如系统中有两个 cgroup，分别是 A 和 B，A 的`shares`值是 1024，B 的`shares`值是 512，那么 A 将获得 1024/(1204+512)=66% 的 CPU 资源，而 B 将获得 33% 的 CPU 资源。

`shares`有两个特点：
1. 如果 A 不忙，没有使用到 66% 的 CPU 时间，那么剩余的 CPU 时间将会被系统分配给 B，即 B 的 CPU 使用率可以超过 33%。
2. 如果添加了一个新的 cgroup C，且它的`shares`值是 1024，那么 A 的限额变成了 1024/(1204+512+1024)=40%，B 的变成了 20%。

从上面两个特点可以看出：
- 在闲的时候，shares 基本上不起作用，只有在 CPU 忙的时候起作用，这是一个优点。
- 由于`shares`是一个绝对值，需要和其它 cgroup 的值进行比较才能得到自己的相对限额，而在一个部署很多容器的机器上，cgroup 的数量是变化的，所以这个限额也是变化的，自己设置了一个高的值，但别人可能设置了一个更高的值，所以这个功能没法精确的控制 CPU 使用率。

与配置内存资源限制时 Docker 配置容器进程的内存 cgroup 的方式相同，设置 CPU 资源限制时 Docker 会配置容器进程的 cpu,cpuacct cgroup：

```bash
$ ps ax | grep /bin/sh
   60554 ?      Ss     0:00 /bin/sh -c while true; do sleep 2; done

$ sudo cat /proc/60554/cgroup
...
4:cpu,cpuacct:/kubepods/burstable/pode12b33b1-db07-11e8-b1e1-42010a800070/3be263e7a8372b12d2f8f8f9b4251f110b79c2a3bb9e6857b2f1473e640e8e75

$ ls -l /sys/fs/cgroup/cpu,cpuacct/kubepods/burstable/pode12b33b1-db07-11e8-b1e1-42010a800070/3be263e7a8372b12d2f8f8f9b4251f110b79c2a3bb9e6857b2f1473e640e8e75
total 0
drwxr-xr-x 2 root root 0 Oct 28 23:19 .
drwxr-xr-x 4 root root 0 Oct 28 23:19 ..
...
-rw-r--r-- 1 root root 0 Oct 28 23:19 cpu.shares
```

Docker 容器的 HostConfig.CpuShares 属性映射到 cgroup 的 cpu.shares 属性，可以验证一下：

```bash
$ sudo cat /sys/fs/cgroup/cpu,cpuacct/kubepods/burstable/podb5c03ddf-db10-11e8-b1e1-42010a800070/64b5f1b636dafe6635ddd321c5b36854a8add51931c7117025a694281fb11444/cpu.shares
51
```

你可能会很惊讶，设置了 CPU`requests`竟然会把值传播到 cgroup，而在设置内存`requests`时并没有将值传播到 cgroup。这是因为内存的 soft limit 内核特性对 Kubernetes 不起作用，而设置了 cpu.shares 却对 Kubernetes 很有用。后面我会详细讨论为什么会这样。现在让我们先看看设置 CPU`limits`时会发生什么：

```bash
$ kubectl run limit-test --image=busybox --requests "cpu=50m" --limits "cpu=100m" --command -- /bin/sh -c "while true; do
sleep 2; done"
deployment.apps "limit-test" created
```

再一次使用 kubectl 验证我们的资源配置：

```bash
$ kubectl get pods limit-test-5b4fb64549-qpd4n -o=jsonpath='{.spec.containers[0].resources}'
map[limits:map[cpu:100m] requests:map[cpu:50m]]
```

查看对应的 Docker 容器的配置：

```bash
$ docker ps | grep busy | cut -d' ' -f1
f2321226620e
$ docker inspect 472abbce32a5 --format '{{.HostConfig.CpuShares}} {{.HostConfig.CpuQuota}} {{.HostConfig.CpuPeriod}}'
51 10000 100000
```

可以明显看出，CPU`requests`对应于 Docker 容器的 HostConfig.CpuShares 属性。而 CPU`limits`就不太明显了，它由两个属性控制：`HostConfig.CpuPeriod` 和 `HostConfig.CpuQuota`。

Docker 容器中的这两个属性又会映射到进程的 cpu,couacct cgroup 的另外两个属性：`cpu.cfs_period_us`和 `cpu.cfs_quota_us`：

```bash
$ sudo cat /sys/fs/cgroup/cpu,cpuacct/kubepods/burstable/pod2f1b50b6-db13-11e8-b1e1-42010a800070/f0845c65c3073e0b7b0b95ce0c1eb27f69d12b1fe2382b50096c4b59e78cdf71/cpu.cfs_period_us
100000

$ sudo cat /sys/fs/cgroup/cpu,cpuacct/kubepods/burstable/pod2f1b50b6-db13-11e8-b1e1-42010a800070/f0845c65c3073e0b7b0b95ce0c1eb27f69d12b1fe2382b50096c4b59e78cdf71/cpu.cfs_quota_us
10000
```

如我所说，这些值与容器配置中指定的值相同。但是这两个属性的值是如何从我们在 Pod 中设置的 100m cpu`limits`得出的呢，他们是如何实现该`limits`的呢？

这是因为 cpu`requests`和 cpu`limits`是使用两个独立的控制系统来实现的。Requests 使用的是 cpu`shares`系统，cpu`shares`将每个 CPU 核心划分为 1024 个时间片，并保证每个进程将获得固定比例份额的时间片。如果总共有 1024 个时间片，并且两个进程中的每一个都将 cpu.shares 设置为 512，那么它们将分别获得大约一半的 CPU 可用时间。但 cpu`shares`系统无法精确控制 CPU 使用率的上限，如果一个进程没有设置 shares，则另一个进程可用自由使用 CPU 资源。

> 大约在 2010 年左右，谷歌团队和其他一部分人注意到了这个问题。为了解决这个问题，后来在 linux 内核中增加了第二个功能更强大的控制系统：CPU 带宽控制组。带宽控制组定义了一个 周期，通常为 1/10 秒（即 100000 微秒）。还定义了一个 配额，表示允许进程在设置的周期长度内所能使用的 CPU 时间数，两个文件配合起来设置 CPU 的使用上限。两个文件的单位都是微秒（us），cfs_period_us 的取值范围为 1 毫秒（ms）到 1 秒（s），cfs_quota_us 的取值大于 1ms 即可，如果 cfs_quota_us 的值为 -1（默认值），表示不受 CPU 时间的限制。

下面是几个例子：

```bash
# 1.限制只能使用1个CPU（每250ms能使用250ms的CPU时间）
$ echo 250000 > cpu.cfs_quota_us /* quota = 250ms */
$ echo 250000 > cpu.cfs_period_us /* period = 250ms */

# 2.限制使用2个CPU（内核）（每500ms能使用1000ms的CPU时间，即使用两个内核）
$ echo 1000000 > cpu.cfs_quota_us /* quota = 1000ms */
$ echo 500000 > cpu.cfs_period_us /* period = 500ms */

# 3.限制使用1个CPU的20%（每50ms能使用10ms的CPU时间，即使用一个CPU核心的20%）
$ echo 10000 > cpu.cfs_quota_us /* quota = 10ms */
$ echo 50000 > cpu.cfs_period_us /* period = 50ms */
```

在本例中我们将 Pod 的 cpu`limits`设置为 100m，这表示 100/1000 个 CPU 核心，即 100000 微秒的 CPU 时间周期中的 10000。所以该`limits`翻译到 cpu,cpuacct cgroup 中被设置为 cpu.cfs_period_us=100000 和 cpu.cfs_quota_us=10000。

另外其中的 cfs 代表 Completely Fair Scheduler（绝对公平调度），这是 Linux 系统中默认的 CPU 调度算法。还有一个实时调度算法，它也有自己相应的配额值。

现在让我们来总结一下：

- 在 Kubernetes 中设置的 cpu`requests`最终会被 cgroup 设置为 cpu.shares 属性的值， cpu`limits`会被带宽控制组设置为 cpu.cfs_period_us 和 cpu.cfs_quota_us 属性的值。与内存一样，cpu`requests`主要用于在调度时通知调度器节点上至少需要多少个 cpu`shares`才可以被调度。
- 与 内存`requests`不同，设置了 cpu`requests`会在 cgroup 中设置一个属性，以确保内核会将该数量的`shares`分配给进程。
- cpu`limits`与 内存`limits`也有所不同。如果容器进程使用的内存资源超过了内存使用限制，那么该进程将会成为 oom-killing 的候选者。但是容器进程基本上永远不能超过设置的 CPU 配额，所以容器永远不会因为尝试使用比分配的更多的 CPU 时间而被驱逐。系统会在调度程序中强制进行 CPU 资源限制，以确保进程不会超过这个限制。

如果你没有在容器中设置这些属性，或将他们设置为不准确的值，会发生什么呢？与内存一样，如果只设置了`limits`而没有设置`requests`，Kubernetes 会将 CPU 的`requests`设置为 与`limits`的值一样。

如果只设置了 CPU`requests`却没有设置 CPU`limits`会怎么样呢？这种情况下，Kubernetes 会确保该 Pod 被调度到合适的节点，并且该节点的内核会确保节点上的可用 cpu`shares`大于 Pod 请求的 cpu shares，但是你的进程不会被阻止使用超过所请求的 CPU 数量。既不设置`requests`也不设置`limits`是最糟糕的情况：调度程序不知道容器需要什么，并且进程对 cpu`shares`的使用是无限制的，这可能会对 node 产生一些负面影响。

最后我还想告诉你们的是：为每个 pod 都手动配置这些参数是挺麻烦的事情，kubernetes 提供了 LimitRange 资源，可以让我们配置某个 namespace 默认的 request 和 limit 值。

## 默认限制

通过上文的讨论大家已经知道了忽略资源限制会对 Pod 产生负面影响，因此你可能会想，如果能够配置某个 namespace 默认的 request 和 limit 值就好了，这样每次创建新 Pod 都会默认加上这些限制。Kubernetes 允许我们通过 LimitRange 资源对每个命名空间设置资源限制。

要创建默认的资源限制，需要在对应的命名空间中创建一个 LimitRange 资源。下面是一个例子：

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limit
spec:
  limits:
    - default:
        memory: 100Mi
        cpu: 100m
      defaultRequest:
        memory: 50Mi
        cpu: 50m
    - max:
        memory: 512Mi
        cpu: 500m
    - min:
        memory: 50Mi
        cpu: 50m
      type: Container
```

这里的几个字段可能会让你们有些困惑，我拆开来给你们分析一下。

-`limits`字段下面的 default 字段表示每个 Pod 的默认的`limits`配置，所以任何没有分配资源的`limits`的 Pod 都会被自动分配 100Mi`limits`的内存和 100m`limits`的 CPU。
- defaultRequest 字段表示每个 Pod 的默认`requests`配置，所以任何没有分配资源的`requests`的 Pod 都会被自动分配 50Mi`requests`的内存和 50m`requests`的 CPU。
- max 和 min 字段比较特殊，如果设置了这两个字段，那么只要这个命名空间中的 Pod 设置的`limits`和`requests`超过了这个上限和下限，就不会允许这个 Pod 被创建。我暂时还没有发现这两个字段的用途，如果你知道，欢迎在留言告诉我。
- LimitRange 中设定的默认值最后由 Kubernetes 中的准入控制器 LimitRanger 插件来实现。准入控制器由一系列插件组成，它会在 API 接收对象之后创建 Pod 之前对 Pod 的 Spec - 字段进行修改。对于 LimitRanger 插件来说，它会检查每个 Pod 是否设置了`limits`和 requests，如果没有设置，就给它配置 LimitRange 中设定的默认值。通过检查 Pod 中的 annotations 注释，你可以看到 LimitRanger 插件已经在你的 Pod 中设置了默认值。例如：

```yaml
apiVersion: v1
kind: Pod
metadata:
  annotations:
    kubernetes.io/limit-ranger: 'LimitRanger plugin set: cpu request for container
      limit-test'
  name: limit-test-859d78bc65-g6657
  namespace: default
spec:
  containers:
    - args:
        - /bin/sh
        - -c
        - while true; do sleep 2; done
      image: busybox
      imagePullPolicy: Always
      name: limit-test
      resources:
        requests:
          cpu: 100m
```

以上就是我对 Kubernetes 资源限制的全部见解，希望能对你有所帮助。如果你想了解更多关于 Kubernetes 中资源的`limits`和 requests、以及 linux cgroup 和内存管理的更多详细信息，可以查看我在文末提供的参考链接。

## 参考文档

- https://medium.com/@betz.mark/understanding-resource-limits-in-kubernetes-cpu-time-9eff74d3161b
- https://medium.com/@betz.mark/understanding-resource-limits-in-kubernetes-memory-6b41e9a955f9
