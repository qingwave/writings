---
title: apline容器中执行脚本报错"executable file not found"
date: 2018-09-16 16:14:58
draft: true
tags:
  - k8s
  - docker
categories:
  - cloud
---

## 问题

今天在创建 java 镜像时，使用了(openjdk:8-jdk-alpine)[https://hub.docker.com/_/openjdk]，启动容器后需要运行一 java 脚本，直接执行
`./test.sh`报错*sh:.sh test.sh: not found*

网上有说由于权限文件不能执行，`chmod +x test.sh`，仍然报错

在 k8s pod 中部署，describe 报错
_Error: failed to start container "docker-registry": Error response from daemon: OCI runtime create failed: container_linux.go:344: starting container process caused "exec: \"sh +x start-registry.sh test\": executable file not found in $PATH": unknown_

若使用`sh +x test.sh`则可运行， pod 中仍然报错

## 探究

直到看到 stackoverflow 上有同样的问题(docker alpine /bin/sh script.sh not found)[https://stackoverflow.com/questions/45860784/bin-bash-command-not-found-in-alpine-docker#],
说与 shell 脚本中的执行器有关，test.sh 的执行器是`#!/bin/bash`，而 alpine 默认的是`/bin/ash, /bin/sh`没有 bash，所以执行会报错

问题找到，至于 bash 与 sh 的区别，网上有不少解释
alpine 中 sh 只是一个符号链接
`sh -> /bin/busybox`

## 解决

### 方法 1

将 shell 脚本中`#!/bin/bash`改为`/bin/sh`

### 方法 2

镜像中添加 bash

```dockerfile
FROM alpine:3.9
RUN apk update && \
    apk add --no-cache bash && \
    rm -rf /var/cache/apk/* /tmp/* /var/tmp/* $HOME/.cache
```
