---
title: k8s+gitlab实现cicd
author: qinng
toc: true
tags:
  - k8s
  - cicd
date: 2020-02-11 22:45:54
categories:
  - cloud
---

## 前言

目前 Gitlab11 已经支持了 Kubernetes Runner, 任务可以跑在 Pod 中。本文介绍如何通过 CICD 接入 Kubernetes，开始前需要以下必备条件：

- Kubernetes 集群
- 配置 Kubernetes Runner, 网上有很多教程，若是生产环境或是多租户 k8s 集群，建议通过 yaml 手动配置；默认通过 helm 安装权限比较大，而且配置不灵活

## CI 过程

通常编译镜像有三种方式：

- docker in docker：与物理方式类似，需要权限多，性能较差
- kaniko：镜像编译工具，性能好

我们使用 kaniko 编译镜像，push 到镜像仓库，过程如下：

1. 配置变量
   配置镜像相关变量，仓库的账户密码，推送的镜像名称`CI_REGISTRY_IMAGE`等
   ![gitlab-ci](/img/blog/gitlab-ci.png)
2. gitlab-ci 配置如下

```yaml
build:
  stage: build
  image:
    name: gcr.io/kaniko-project/executor:debug
    entrypoint: ['']
  script:
    - echo "{\"auths\":{\"$CI_REGISTRY\":{\"username\":\"$CI_REGISTRY_USER\",\"password\":\"$CI_REGISTRY_PASSWORD\"}}}" > /kaniko/.docker/config.json
    - /kaniko/executor --context $CI_PROJECT_DIR --dockerfile $CI_PROJECT_DIR/Dockerfile --destination $CI_REGISTRY_IMAGE:$CI_COMMIT_TAG
  after_script:
    - echo "build completed"
  only:
    - tags # 打tag才会执行，测试可去掉
```

## CD 过程

CD 即需要将生成的镜像更新到 Kubernetes 集群中，有如下几种方式：

- k8s restful api：需要对 api 较了解，更新过程需要调用`PATH`方法，不推荐
- kubectl: 常规方式
- helm: 如有可用的 helm 仓库，也可使用 helm 进行更新

我们以 kubectl 为例，CD 配置如下：

1. 配置变量
   配置必须的集群地址，token，需要更新服务的 namespace, container 等
2. CD 配置
   配置与物理环境类似，首先配置 kubectl token、集群等，最后调用`set image`更新服务

```yaml
deploy:
  image:
    name: kubectl:1.17
    entrypoint: ['']
  before_script:
  script:
    - IMAGE=$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA
    - kubectl config set-credentials $CD_USER --token $CD_APP_AK
    - kubectl config set-cluster $CD_CLUSTER --server https://$CD_SERVER
    - kubectl config set-context $CD_USER@$CD_CLUSTER/$CD_NAMESPACE --user $CD_USER --cluster $CD_CLUSTER --namespace $CD_NAMESPACE
    - kubectl config use-context $CD_USER@$CD_CLUSTER/$CD_NAMESPACE
    - kubectl set image -n $CD_NAMESPACE $CD_APP_TYPE/$CD_APP_NAME $CD_CONTAINER=$IMAGE
  only:
    - tags
```

3. 运行结果

```bash
$ kubectl set image -n $CD_NAMESPACE $CD_APP_TYPE/$CD_APP_NAME $CD_CONTAINER=$IMAGE
deployment.extensions/helloworld image updated
Job succeeded
```

## 备注

本文所列举的 CICD 过程较简单，可以使用 CICD 完成服务的多集群部署，更新结果检查等功能。

## 参考

1. https://docs.gitlab.com/ee/ci/docker/using_kaniko.html
2. https://docs.gitlab.com/runner/executors/kubernetes.html
