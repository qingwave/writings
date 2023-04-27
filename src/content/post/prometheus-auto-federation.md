---
title: Prometheus高可用自动分区方案
author: qinng
toc: true
tags:
  - prometheus
date: 2021-03-30 19:07:20
categories:
  - cloud
---

在[Prometheus 分区实践](/prometheus-federation)中我们介绍了使用集群联邦与远程存储来扩展 Prometheus 以及监控数据持久化，但之前的分区方案存在一定不足，如分区配置较难维护，全局 Prometheus 存在性能瓶颈等，本文通过`Thanos+Kvass`实现更优雅的 Prometheus 扩展方案。

<!--more-->

## 自动分区

之前分区方案依赖 Prometheus 提供的`hashmod`方法，通过在配置中指定`hash`对象与`modules`进行散列（md5），每个分片只抓取相同 job 命中的对象，例如我们可以通过对`node`散列从而对`cadvisor`、`node-exporter`等 job 做分片。

通过这种方式可以简单的扩展 Prometheus，降低其抓取压力，但是显而易见`hashmod`需要指定散列对象，每个 job 可能需要配置不同的对象如`node`、`pod`、`ip`等，随着采集对象增多，配置难以维护。直到看见了[Kvass](https://github.com/tkestack/kvass)，Kvass 是一个 Prometheus 横向扩展方案，可以不依赖`hashmod`动态调整 target，支持数千万 series 规模。

Kvass 核心架构如下：
![kvass](https://github.com/tkestack/kvass/raw/master/README.assets/image-20201126031456582.png)

- `Kvass-Coordinator`: 加载配置文件并进行服务发现，获取所有 target，周期性分配 target 到`kvass-sidecar`，以及管理分片负载与扩缩容
- `Kvass-Sidecar`: 根据`Coordinator`分发的 target 生成配置，以及代理 Prometheus 请求

通过 Kvass 可实现 Prometheus 动态横向扩展，而不依赖`hashmod`，灵活性更高。

## 全局查询

另一个问题是在集群联邦中我们需要一个全局的 Prometheus 来聚合分区 Prometheus 的数据，依赖原生的`/federate`接口，随着数据量增多，全局 Prometheus 必然会达到性能瓶颈。高可用 Prometheus 集群解决方案[Thanos](https://github.com/thanos-io/thanos)中提供了全局查询功能，通过`Thanos-Query`与`Thanos-Sidecar`可实现查询多个 Prometheus 的数据，并支持了去重。

Thanos 组件较多，核心架构如下：
![Thanos](/img/blog/thanos-arch.png)

- `Thanos Query`: 实现了`Prometheus API`，将来自下游组件提供的数据进行聚合最终返回给查询数据的 client (如 grafana)，类似数据库中间件
- `Thanos Sidecar`: 连接 Prometheus，将其数据提供给`Thanos Query`查询，并且可将其上传到对象存储，以供长期存储
- `Thanos Store Gateway`: 将对象存储的数据暴露给`Thanos Query`去查询
- `Thanos Ruler`: 对监控数据进行评估和告警，还可以计算出新的监控数据，将这些新数据提供给`Thanos Query`查询并且可上传到对象存储，以供长期存储
- `Thanos Compact`: 将对象存储中的数据进行压缩和降低采样率，加速大时间区间监控数据查询的速度

借助于 Thanos 提供的`Query`与`Ruler`我们可以实现全局查询与聚合。

## 最终方案

`Kvass+Thanos`可实现 Prometheus 自动扩展、全局查询，再配合`Remote Wirite`实现数据支持化，通过 Grafana 展示监控数据
![Prometheus-HA](/img/blog/prometheus-ha.png)

### 测试验证

所有部署文件见[prometheus-kvass](https://github.com/qingwave/kube-monitor/tree/master/prometheus-kvass)

```bash
git clone https://github.com/qingwave/kube-monitor.git
kubectl apply -f kube-monitor/prometheus-kvass
```

结果如下：

```bash
$ kubectl get po
NAME                                 READY   STATUS    RESTARTS   AGE
kvass-coordinator-7f65c546d9-vxgxr   2/2     Running   2          29h
metrics-774949d94d-4btzh             1/1     Running   0          10s
metrics-774949d94d-558gn             1/1     Running   1          29h
metrics-774949d94d-gs8kc             1/1     Running   1          29h
metrics-774949d94d-r85rc             1/1     Running   1          29h
metrics-774949d94d-xhbk9             1/1     Running   0          10s
metrics-774949d94d-z5mwk             1/1     Running   1          29h
prometheus-rep-0-0                   3/3     Running   0          49s
prometheus-rep-0-1                   3/3     Running   0          48s
prometheus-rep-0-2                   3/3     Running   0          19s
thanos-query-b469b648f-ltxth         1/1     Running   0          60s
thanos-rule-0                        1/1     Running   2          25h
```

Deployment `metrics`有 6 个副本，每个生成 10045 series，`kvass-coordinator`配置每个分区最大 series 为 30000，以及 Prometheus 默认的指标，需要 3 个 Prometheus 分片。

每个分片包含 2 个 target

```bash
prometheus_tsdb_head_chunks{instance="127.0.0.1:9090",job="prometheus_shards",replicate="prometheus-rep-0-0",shard="0"}	20557
```

通过`Thanos Query`可以查询到多个 Prometheus 分片的数据，以及聚合规则`metrics_count`
![thanos-query](/img/blog/thanos-query.png)

### 待优化问题

此方案可满足绝大部分场景，用户可通过自己的实际环境配合不同的组件，但也存在一些需要优化确认的问题

- `Thanos Ruler`不支持远程写接口，只能存储于 Thanos 提供的对象存储中
- `Thanos Query`全局查询依赖多个下游组件，可能只返回部分结果挺好使
- `Coordinator`性能需要压测验证

## 总结

`Kvass+Thanos+Remote-write`可以实现 Prometheus 集群的自动分区、全局查询、数据持久化等功能，满足绝大部分场景。虽然有一些问题需要验证优化，但瑕不掩瑜，能够解决原生 Prometheus 扩展性问题。

## 引用

- https://qingwave.github.io/prometheus-federation/
- https://github.com/tkestack/kvass
- https://github.com/thanos-io/thanos
