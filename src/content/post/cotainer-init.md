---
title: 开启shareProcessNamespace后容器异常
author: qinng
toc: true
tags:
  - k8s
  - docker
date: 2020-07-28 17:35:49
categories:
  - cloud
---

## 背景

目前 k8s 不支持容器启动顺序，部分业务通过开启`shareProcessNamespace`监控某些进程状态。当开启共享 pid 后，有用户反馈某个容器主进程退出，但是容器并没有重启，执行`exec`会卡住，现象参考[issue](3)

<!--more-->

## 复现

1. 创建 deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: nginx
  name: nginx
spec:
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
      name: nginx
    spec:
      shareProcessNamespace: true
      containers:
        - image: nginx:alpine
          name: nginx
```

2. 查看进程信息
   由于开启了`shareProcessNamespace`, `pause`变为`pid 1`, `nginx daemon`pid 为`6`, ppid 为`containerd-shim`

```bash
# 查看容器内进程
/ # ps -efo "pid,ppid,comm,args"
PID   PPID  COMMAND          COMMAND
    1     0 pause            /pause
    6     0 nginx            nginx: master process nginx -g daemon off;
   11     6 nginx            nginx: worker process
   12     6 nginx            nginx: worker process
   13     6 nginx            nginx: worker process
   14     6 nginx            nginx: worker process
   15     0 sh               sh
   47    15 ps               ps -efo pid,ppid,comm,args
```

3. 删除主进程
   子进程被`pid 1`回收, 有时也会被`containerd-shim`回收

```bash
/ # kill -9 6
/ #
/ # ps -efo "pid,ppid,comm,args"
PID   PPID  COMMAND          COMMAND
    1     0 pause            /pause
   11     1 nginx            nginx: worker process
   12     1 nginx            nginx: worker process
   13     1 nginx            nginx: worker process
   14     1 nginx            nginx: worker process
   15     0 sh               sh
   48    15 ps               ps -efo pid,ppid,comm,args
```

4. docker hang
   此时对此容器执行 docker 命令(`inspect, logs, exec`)将卡住， 同样通过`kubectl`执行会超时。

## 分析

在未开启`shareProcessNamespace`的容器中，主进程退出`pid 1`, 此 pid namespace 销毁，系统会`kill`其下的所有进程。开启后，`pid 1`为`pause`进程，容器主进程退出，由于共享 pid namespace，其他进程没有退出变成孤儿进程。此时调用 docker 相关接口去操作容器，docker 首先去找主进程，但主进程已经不存在了，导致异常(待确认)。

清理掉这些孤儿进程容器便会正常退出，可以`kill`掉这些进程或者`kill`pause 进程，即可恢复。

## 方案

有没有优雅的方式解决此种问题，如果主进程退出子进程也一起退出便符合预期，这就需要进程管理工具来实现，在宿主机中有`systemd`、`god`，容器中也有类似的工具即`init进程`(传递信息，回收子进程)，常见的有

1. `docker init`, docker 自带的 init 进程(即`tini`)
2. [`tini`](https://github.com/krallin/tini), 可回收孤儿进程/僵尸进程，`kill`进程组等
3. [`dumb-init`](https://github.com/Yelp/dumb-init), 可管理进程，重写信号等

经过测试，`tini`进程只能回收前台程序，对于后台程序则无能为力(例如`nohup`, `&`启动的程序)，`dumb-init`在主进程退出时，会传递信号给子进程，符合预期。

开启`dumb-init`进程的`dockerfile`如下，`tini`也类似

```dockerfile
FROM nginx:alpine

# tini
# RUN apk add --no-cache tini
# ENTRYPOINT ["/sbin/tini", "-s", "-g", "--"]

# dumb-init
RUN wget -O /usr/bin/dumb-init https://github.com/Yelp/dumb-init/releases/download/v1.2.2/dumb-init_1.2.2_amd64
RUN chmod +x /usr/bin/dumb-init
ENTRYPOINT ["/usr/bin/dumb-init", "-v", "--"]

CMD ["nginx", "-g", "daemon off;"]
```

init 方式对于此问题是一种临时的解决方案，需要 docker 从根本上解决此种情况。容器推荐单进程运行，但某些情况必须要运行多进程，如果不想处理处理传递回收进程等，可以通过`init`进程，无需更改代码即可实现。

## 参考

- https://github.com/Yelp/dumb-init
- https://github.com/krallin/tini
- https://github.com/kubernetes/kubernetes/issues/92214
