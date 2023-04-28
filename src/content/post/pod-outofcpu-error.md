---
title: k8s节点资源不足时OutOfcpu错误
date: 2019-01-18 11:06:10
tags:
  - k8s
categories:
  - cloud
---

## 环境

k8s: 1.10.2
docker: 17.03

## 问题

当指定 nodeName 并且节点资源不足时，会创建大量 pod，并显示`outofcpu/outofmem`
类似下面:

```bash
prometheus-slave01-68bd9bc854-slw92 0/2 OutOfcpu 0 1m
prometheus-slave01-68bd9bc854-svxbq 0/2 OutOfcpu 0 20s
prometheus-slave01-68bd9bc854-sw25t 0/2 OutOfcpu 0 1m
```

## 相关 issue

https://github.com/kubernetes/kubernetes/issues/38806

## 解析

Pod设置`spec.nodeName`会跳过调度，没有对容量做检测分配到节点上显示资源不足，状态变为 outofcpu/outofmem，k8s 判断 replicaset 没有检测到期望 pod 的状态，会重新再起一个 pod，而原 pod 不会主动删除，致使创建大量 pod。

## 附件

测试 yaml

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-nginx
  namespace: kube-system
spec:
  replicas: 1
  template:
    metadata:
      labels:
        app: my-nginx
    spec:
      nodeName: tj1-jm-cc-stag05.kscn
      containers:
        - name: my-nginx
          image: nginx
          ports:
            - containerPort: 80
          resources:
            limits:
              cpu: 200
            requests:
              cpu: 100
```
