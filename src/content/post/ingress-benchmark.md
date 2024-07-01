---
title: ingress nginx benchmark
author: qinng
toc: true
image: /img/blog/ingress-benchmark1.png
tags:
  - k8s
  - ingress
  - nginx
date: 2020-05-21 19:16:04
categories:
  - cloud
---

Ingress 是目前 Kubernetes 集群流量接入的重要入口，了解其性能指标有助于用户选用合适的网络方案。

<!--more-->

## 测试方案

通过 wrk 压测后端 nginx 服务，对比 ingress-nginx, 原生 nginx，以及直连后端性能的差异，如下图:
![](/img/blog/ingress-benchmark1.png)

- 方案 1，经过 ingress
- 方案 2，经过 nginx
- 方案 3，直连 ip

### 硬件环境

- CPU： 2x Intel(R) Xeon(R) CPU E5-2620 v4 @ 2.10GHz, 32 cores
- Network： 10-Gigabit
- Memory： 128 GB

### 测试工具

- wrk, 4.1.0, 在 k8s master 测试，减少网络影响
- ingress-nginx, 0.30.0, https://github.com/kubernetes/ingress-nginx
- nginx, 1.13.5
- k8s, v1.14.9
- centos, 7.3.1611(Linux 4.9.2)

### 测试方法

ingress-nginx 主要工作是转发请求到后端 pod, 我们着重对其 RPS（每秒请求量）进行测试

通过以下命令

```yaml
wrk -t4 -c1000 -d120s --latency http://my.nginx.svc/1kb.bin
```

## 测试结果

### 不同 cpu 下的性能

对比不同 ingress-nginx 启动不同 worker 数量的性能差异，以下测试 ingress-nginx 开启了 keepalive 等特性

| CPU | RPS    |
| --- | ------ |
| 1   | 5534   |
| 2   | 11203  |
| 4   | 22890  |
| 8   | 47025  |
| 16  | 93644  |
| 24  | 125990 |
| 32  | 153473 |

![](/img/blog/ingress-benchmark2.png)

如图所示，不同 cpu 下，ingress 的 rps 与 cpu 成正比，cpu 在 16 核之后增长趋势放缓。

### 不同方案的性能对比

| 方案                    | RPS    | 备注                                  |
| ----------------------- | ------ | ------------------------------------- |
| ingress-nginx(原始)     | 69171  |                                       |
| ingress-nginx(配置优化) | 153473 | 调整 worker，access-log, keepalive 等 |
| nginx                   | 336769 | 开启 keepalive, 关闭 log              |
| 直连 ip                 | 340748 | 测试中的 pod ip 为真实 ip             |

通过实验可以看到，使用 nginx 代理和直连 ip，rps 相差不大；原始 ingress-nginx rps 很低，优化后 rps 提升一倍，但对比 nginx 还是有较大的性能差异。

## 结论

默认 ingress-nginx 性能较差，配置优化后也只有 15w RPS，对比原生 nginx（33W) 差距较大。经过分析主要瓶颈在于 ingress-nginx 的 lua 过滤脚本，具体原因需要进一步分析。

## 参考

1. https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/configmap/#upstream-keepalive-connections
2. https://www.nginx.com/blog/testing-performance-nginx-ingress-controller-kubernetes/

## 配置文件

本测试所有配置见[qingwave/ingress-nginx-benchmark](https://github.com/qingwave/ingress-nginx-benchmark)
