---
title: apline镜像添加时区与字符设置
date: 2018-08-18 16:40:42
draft: true
tags:
  - docker
categories:
  - cloud
---

1. 添加时区
   设置`TZ`与安装 tzdata

2. 添加 work 用户
   `addgroup -S work && adduser -S -G work work -s /bin/sh`

3. 设置字符格式
   设置环境变量`LANG`与`LC_ALL`

Dockerfile 如下：

```
FROM alpine

ENV TZ=Asia/Shanghai \
    LANG=en_US.UTF-8  \
    LC_ALL=en_US.UTF8

RUN apk update && \
    apk add --no-cache tzdata && \
    addgroup -S work && adduser -S -G work work -s /bin/bash && \
    rm -rf /var/cache/apk/* /tmp/* /var/tmp/* $HOME/.cache
```
