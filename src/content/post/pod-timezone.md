---
title: Pod中时区设置
date: 2018-10-13 14:18:43
tags:
  - k8s
  - docker
categories:
  - cloud
---

## Pod 设置本地时区的两种方法

我们下载的很多容器内的时区都是格林尼治时间，与北京时间差 8 小时，这将导致容器内的日志和文件创建时间与实际时区不符，有两种方式解决这个问题：

- 修改镜像中的时区配置文件
- 将宿主机的时区配置文件/etc/localtime 使用 volume 方式挂载到容器中

### 修改 Dockfile

修改前

```bash
$ docker run -d nginx:latest

$ docker ps
CONTAINER ID        IMAGE               COMMAND                  CREATED              STATUS              PORTS               NAMES
ca7aacad1493        nginx               "nginx -g 'daemon of…"   About a minute ago   Up About a minute   80/tcp              inspiring_elbakyan

$ docker exec -it inspiring_elbakyan date
Wed Feb 13 06:51:41 UTC 2019

date
Wed Feb 13 14:51:45 CST 2019
```

创建 timezone-dockerfile

```dockerfile
FROM nginx
RUN /bin/cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
     && echo 'Asia/Shanghai' >/etc/timezone
```

```bash
$ docker build -t timezone -f timezone-dockerfile .

$ docker run -d timezone
af39a27d8c8b48b80fb9b052144bd682d75d994dba2e03a02101514304f363d0

$ docker exec -it af39a27d8c8b date
Wed Feb 13 15:05:14 CST 2019

$ date
Wed Feb 13 15:05:16 CST 2019
```

### 挂载 localtime 文件

第二种方式实现更简单，不需要更改镜像，只需要配置 yaml 文件，步骤如下：

创建测试 pod，busybox-pod.yaml

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: busybox
  namespace: default
spec:
  containers:
    - image: busybox:1.28.3
      command:
        - sleep
        - '3600'
      imagePullPolicy: IfNotPresent
      name: busybox
      volumeMounts:
        - name: host-time
          mountPath: /etc/localtime
          readOnly: true
  volumes:
    - name: host-time
      hostPath:
        path: /etc/localtime
  restartPolicy: Always
```

测试时间

```bash
$ kubectl apply -f busybox-pod.yaml
pod/busybox created

$ kubectl exec -it busybox date
Wed Feb 13 06:16:35 UTC 2019

$ date
Wed Feb 13 14:16:39 CST 2019
```

将/etc/localtime 挂载到 pod 中，配置如下:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: busybox
  namespace: default
spec:
  containers:
    - image: busybox:1.28.3
      command:
        - sleep
        - '3600'
      imagePullPolicy: IfNotPresent
      name: busybox
      volumeMounts:
        - name: host-time
          mountPath: /etc/localtime
          readOnly: true
  volumes:
    - name: host-time
      hostPath:
        path: /etc/localtime
  restartPolicy: Always
```

测试时间

```bash
$ kubectl apply -f busybox-pod.yaml

$ kubectl exec -it busybox date
Wed Feb 13 14:17:50 CST 2019 #与当前时间一致

$ date
Wed Feb 13 14:17:52 CST 2019
```
