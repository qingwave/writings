---
title: k8s如何优雅升级应用
author: qinng
toc: true
tags:
  - k8s
  - ingress
  - nginx
date: 2020-06-19 18:28:50
categories:
  - cloud
---

在 k8s 中通常用户通过`ingress`接入流量，转发到后端实例(`ingress → pod`)，在后端应用更新过程中，`ingress`是否能做到优雅升级，本文将通过分析升级流程与实验验证，说明在 k8s 中如何实现优化升级。

<!--more-->

## Ingress 原理

用户创建 ingress 资源后，`ingress-nginx`通过`service`获取到对应的`endpoint`，监听到`endpoint`变化后将动态更新`upstream`。

`endpoint`每次变化后会通过`selector`匹配的`pod`列表中`ready pod`（不包括待删除的`pod`, 及`DeletionTimestamp`不为空）

```bash
pod ready = 所有container ready(启动成功, 健康检查通过) + 所有rediness gateway执行成功
```

那么`endpoint`在什么状况下会发生变化：

- service 变化（一般不会）
- 扩缩容
- 升级
- 删除 pod

不管是什么操作，可归结于启动、删除、退出

- **启动**，只要确保`pod ready`时能服务能正常接受流量，不会影响影响服务
- **退出**, 如果是应用异常退出，不能处理已接受的流量，此种状况是应用本身行为，不在讨论范围
- **删除**, 由于 k8s 所有组件都采用监听机制，无法保证`pod`删除时`ingress-nginx`的后端已经更新

```bash
# 大约在2s内
ingress-nginx 生效时间 = endpoint 生效时间 + upstream更新时间
```

如果要保证 pod 删除时不丢流量，需要做到

- 已接受的请求需要处理完，可监听 TERM 信号，处理完再退出， 可参考https://kubernetes.io/docs/concepts/workloads/pods/pod/#termination-of-pods
- 删除时不接受新的请求，这部分无法保证，只能保证#1

## ingress-nginx 重试机制

ingress-nginx 默认开启了 proxy_next_upstream，配置如下

```bash
# In case of errors try the next upstream server before returning an error
proxy_next_upstream error timeout;
proxy_next_upstream_timeout 0;
proxy_next_upstream_tries 3;
```

如果一次请求中，`upstream server` 出错或超时将通过 rr 算法重试下一个 server，最多尝试三次。如果后端大于三个实例，一个实例异常不会影响服务。

## 升级策略

对于`Deployment`有两种升级策略， `Recreate`与`RollingUpdate`

- **Recreate**, 先将旧版缩到 0 再将新版扩到期望值，不建议使用
- **RollingUpdate**，默认策略，滚动更新

在滚动升级时主要依据`maxSurge`与`maxUnavailable`对新旧版本进行扩缩

- **maxSurge**， 升级中最多有多少 pod 超过期望值
- **maxUnavailable**， 此值用来计算升级中最小可用的实例数，最大不可用的实例数表示不准确

举个例子，比如 10 个副本的 Deployment， 采用默认值`maxSurge`与`maxUnavaiable`都为 25%

```bash
// 向上取整为 3
maxSurge = replicas * deployment.spec.strategy.rollingUpdate.maxSurge(25%)= 2.5

// 向下取整为 2
maxUnavailable = replicas * deployment.spec.strategy.rollingUpdate.maxUnavailable(25%)= 2.5

maxAvailable = replicas(10) + MaxSurge（3） = 13

minAvailable := *(deployment.Spec.Replicas)（10） - maxUnavailable（2）= 8
```

在升级过程中，首先创建 newRS，然后为其设定 replicas，此时计算出 replicas 结果为 3。等到下一个 syncLoop 时，所有 rs 的 replicas 已经达到最大值 10 + 3 = 13，此时需要 scale down oldRSs 了，scale down 的数量是通过以下公式得到的：

```bash
// 13 = 10 + 3
allPodsCount := newRS(10) + oldRS(3)

// ???
newRSUnavailablePodCount := *(newRS.Spec.Replicas) - newRS.Status.AvailableReplicas

// 13 - 8 - ???
maxScaledDown := allPodsCount - minAvailable - newRSUnavailablePodCount
newRSUnavailablePodCount 此时不确定，但是值在 [0,3] 中，此时假设 newRS 的三个 pod 还处于 containerCreating 状态，则newRSUnavailablePodCount 为 3，根据以上公式计算所知 maxScaledDown 为 2。如果有个新版本pod已经ready，则maxScaledDown 为 4。
```

特殊情况，当只有一个副本，`maxSurge`与`maxUnavaiable`都为 1 时，按照以上公式，先扩容 1 个新版 pod，再缩一个旧版的，如果旧版已经删除了而新版还没有起来可能会丟流量，可以将`maxUnavaiable`设置为 0 可避免以上情况。

## 实验验证

滚动升级终于也是通过扩缩新旧版本来实现的，我们只需要分析扩缩容过程中会不会丢流量即可。

### 实验环境

image: nginx
tool:  `wrk -c 2 -d 120 -H "Connection:Close" http://my.nginx.svc`

### 扩容

1. 从 1 扩到 10 个

不丢流量，nginx 启动很快不需要额外的初始化工作，正常情况需要配置健康检查

### 缩容

**1) 10 → 1**

缩容时会有 502 错误

```bash
Running 2m test @ http://my.nginx.svc
  2 threads and 2 connections
  Thread Stats   Avg      Stdev     Max   +/- Stdev
    Latency    11.73ms   27.02ms 229.17ms   95.14%
    Req/Sec   162.91     45.77   232.00     74.13%
  8969 requests in 28.24s, 2.40MB read
  Non-2xx or 3xx responses: 366
Requests/sec:    317.62
Transfer/sec:     86.93KB
```

查看 ingress 日志

```bash
2020/06/19 08:12:28 [error] 9533#9533: *197916788 connect() failed (111: Connection refused) while connecting to upstream, client: 10.232.41.102, server: my.nginx.svc, request: "GET / HTTP/1.1", upstream: "http://10.126.110.3:80/", host: "my.nginx.svc"
2020/06/19 08:12:33 [error] 8935#8935: *197916707 upstream timed out (110: Operation timed out) while connecting to upstream, client: 10.232.41.102, server: my.nginx.svc, request: "GET / HTTP/1.1", upstream: "http://10.126.69.136:80/", host: "my.nginx.svc"
2020/06/19 08:12:33 [error] 9533#9533: *197916788 upstream timed out (110: Operation timed out) while connecting to upstream, client: 10.232.41.102, server: my.nginx.svc, request: "GET / HTTP/1.1", upstream: "http://10.126.69.136:80/", host: "my.nginx.svc
10.232.41.102 - - [18/Jun/2020:09:14:35 +0000] "GET / HTTP/1.1" 502 157 "-" "-" 38 0.001 [default-my-nginx-80] [] 10.46.12.80:80, 10.46.12.79:80, 10.46.12.80:80 0, 0, 0 0.000, 0.000, 0.000 502, 502, 502 5cfc063dbe7daf1db953a0e16891f100
```

**2) 4→1**

会丟流量

**3）3→1**

测试多次，偶现过丢流量的情况，这与 ingress 重试算法有关系

**4） 10→1**, 忽略 term 信号, 不丢流量

```bash
Running 2m test @ http://my.nginx.svc
  2 threads and 2 connections
Thread Stats   Avg      Stdev     Max   +/- Stdev
    Latency    12.12ms   16.66ms 214.89ms   88.39%
    Req/Sec   129.75     74.05   250.00     62.35%
  8811 requests in 34.24s, 2.35MB read
Requests/sec:    257.35
Transfer/sec:     70.41KB
```

## 总结

通过分析及实验，在 pod 启动时可配置健康检查避免请求异常；同一时刻大于 2 个 pod 终止可能会丢失流量，通过监听退出信号可避免此种情况。综上，应用的优化升级需要做到以下几点：

- 健康检测，`pod ready`时能够正常接受流量
- 优雅停止，保证处理完请求再退出，在这段时间内实例 ip 可从 ingress 后端摘除
- 滚动升级配置，若只有 1 个实例需设置 maxsurge=0，更建议副本数设置多个
