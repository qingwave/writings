---
title: k8s serviceaccount挂载pod问题
date: 2018-09-26 12:31:27
draft: true
tags:
  - k8s
categories:
  - cloud
---

## 问题 1

用户创建 role 失败，报错:

```bash
$ kubectl create -f role.yml
Error from server (Forbidden): error when creating "role.yml": roles.rbac.authorization.k8s.io "pod-modifier" is forbidden: attempt to grant extra privileges: [PolicyRule{APIGroups:[""], Resources:["pods"], Verbs:["get"]}] user=&{test test [system:authenticated] map[]} ownerrules=[PolicyRule{APIGroups:["authorization.k8s.io"], Resources:["selfsubjectaccessreviews" "selfsubjectrulesreviews"], Verbs:["create"]} PolicyRule{NonResourceURLs:["/api" "/api/*" "/apis" "/apis/*" "/healthz" "/openapi" "/openapi/*" "/swagger-2.0.0.pb-v1" "/swagger.json" "/swaggerapi" "/swaggerapi/*" "/version" "/version/"], Verbs:["get"]}] ruleResolutionErrors=[]
```

### 解决

错误显示`user=&{test test [system:authenticated] map[]}`这个 user 没有权限，在`~/.kube/config`添加 admin 用户

## 问题 2

创建 serviceaccount 后，没有挂载到 pod 中

### 解决

需要在 apiserver 配置中开启，添加`--admission-control=ServiceAccount --authorization-mode=RBAC`，重启

```bash
$ systemctl daemon-reload
$ systemctl restart kube-apiserver
```

## 问题 3

添加配置后,直接创建 pod 能够加载 sa 与 token，创建 deployment 则不行

### 解决

kubeconfig 配置有问题，确认其中 user 的配置
