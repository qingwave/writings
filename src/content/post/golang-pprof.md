---
title: 记一次golang性能分析
date: 2018-11-23 11:12:48
tags:
  - golang
categories:
  - code
---

## 背景

最近在做 prometheus 监控，需要将 prometheus 聚合数据打向 falcon, 写了个 falcon-adapter，部署到小集群上没问题，最后部署在线上集群 400 nodes k8s 集群出现 部分数据抓取不上， falcon 断点严重， 部署节点 load 过高到达 50.

## 分析

追溯某些数据发现 prometheus 采集不到，确认抓取组件没有问题
查看 falcon，数据采集时间过长，导致断点
查看 falcon-adapter, 有大量 TIME_WAIT 链接
无法确定哪一环出现问题，借助 pprof 进行性能分析
查看 falcon-adapter 得到火焰图如下
![before](/img/blog/golang分析.png)
其中 falcon-adapter 的 metricFilter 操作占了 71.75%， 大部分是 regexp.MatchString 和 regexp.compile 占用的，这在一个转发程序是不正常的，通常应该 HTTP IO 操作占大头
在 metricFilter 中主要实现了 prometheus metrics 的过滤，保存需要的 metrics, 其中有大量正则匹配，可能因此出现性能问题

```
func metricFilter(str string) string {
    for _, scope := range config.Scope {
        regStr := "^" + scope + ":"
        if match, _ := regexp.MatchString(regStr, str); match {
            return scope
        }
    }
    return ""
}
```

将所有正则操作全部替换为常规字符串操作后，得到火焰图如下
![after](/img/blog/golang分析1.png)
net 占有大部分 cpu 时间，meticFilter 只占用 1.67%！

## 后记

在大规模集群中编程一定要考虑性能问题，避免出现类似问题
善于利用 pprof 类似工具分析程序性能问题
