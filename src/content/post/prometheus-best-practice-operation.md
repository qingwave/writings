---
title: Prometheus最佳实践-聚合函数
author: qinng
toc: true
tags:
  - prometheus
date: 2020-07-16 15:28:39
categories:
  - cloud
---

## rate

prometheus 中`rate`只能用于`counter`类型，对于需要聚合的数据需要先`rate`再`sum`，而不是`rate(sum)`

## 数据准确性

`rate/increase/delta`等操作对于原始值进行了外推（类似线性插件），得到的不是准确值

如`rate(http_requests_total[2m])`指两分钟内每秒平均请求量，通过`2m`内首尾两个数据外推得到差值，比 120s 得到；
同理`increase(http_requests_total[2m])`指的不是首尾两个值的增长量，而是外推后计算出`2m`内的增长量。

## absent

通常报警中，我们需要对某个对象是不是有数据进行监控（即`nodata`监控），`absent`用来验证指标是不是有数据很有用

## predict_linear

线性回归预测，适合线性数据的预测，如预测 etcd 的未来 4 小时文件描述符使用量

```
predict_linear(cluster:etcd:fd_utilization[1h], 3600 * 4)
```

## quantile_over_time

一段时间内统计分位数

```
quantile_over_time(0.9, http_requests_total[1d]) # 一天内请求量的90分位
```

## bool

某些情况的需要比较两个标量（通常用来报警），可以使用 bool

```
http_requests_total > bool 100
```
