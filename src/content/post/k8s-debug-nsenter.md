---
title: Kubernetes调试利器Nsenter
author: qinng
toc: true
comments: true
tags:
  - k8s
date: 2021-11-12 09:17:35
categories:
  - cloud
  - 工具
---

在 k8s 云环境中，我们需要在容器内抓包进行 Debug, 但通常大多容器都没有安装 tcpdump 以及其他网络工具；在托管 k8s 中我们想登录 node，不是没权限就是步骤太麻烦。本文的主角`nsenter`正是很擅长解决这些问题，`nsenter`可以进入指定`namespace`的工具，一般用来在容器环境中进行调试。

<!--more-->

## 调试容器网络

通过`nsenter`可以轻松在宿主机进入容器的网络命令空间，命令如下：

```bash
# 设置containerid
containerid=xxx
# 获取容器主进程
pid=$(docker inspect -f {{.State.Pid}} $containerid)
# 进入容器networker namespace
nsenter -n --target $pid
```

之后便可以使用宿主机各种工具`tcpdump`, `netstat`等命令

## 登录 k8s 节点

如果只有`Apiserver`权限，登录 k8s 节点也可以使用`nsenter`

临时登录某个节点可以使用如下脚本:

> 前提是需要拥有一些特殊权限`privileded`，`hostPID`等

```bash
node=xxx
cmd='[ "nsenter", "--target", "1", "--mount", "--uts", "--ipc", "--net", "--pid", "--"]'
overrides="$(
cat <<EOT
{
  "spec": {
    "nodeName": "$node",
    "hostPID": true,
    "hostNetwork": true,
    "containers": [
      {
        "securityContext": {
          "privileged": true
        },
        "image": "alpine",
        "name": "nsenter",
        "stdin": true,
        "stdinOnce": true,
        "tty": true,
        "command": $cmd
      }
    ],
    "tolerations": [
      {
        "operator": "Exists"
      }
    ]
  }
}
EOT
)"
pod="kube-nodeshell-$(env LC_ALL=C tr -dc a-z0-9 </dev/urandom | head -c 6)"
kubectl run --image=alpine --restart=Never --rm --overrides="$overrides" -it $pod
```

原理是通过共享 pid 方式`hostPID=true`，在容器中看到宿主机的所有进程，然后使用`nsenter`进入宿主机 1 号进程（宿主机根进程）的`mount、uts、ipc、net、pid`等 namespace，从而可以获取类似宿主机的 shell。

如果需要经常使用，可以部署个`DaemonSet`，使用时登录对应节点的 pod 即可（建议只在测试环境使用，具有一定风险）

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: kube-nodehsell
  labels:
    app: kube-nodehsell
spec:
  selector:
    matchLabels:
      app: kube-nodehsell
  template:
    metadata:
      labels:
        app: kube-nodehsell
    spec:
      tolerations:
        - operator: 'Exists'
      containers:
        - name: kube-nodehsell
          image: alpine
          command:
            - nsenter
            - --target
            - '1'
            - --mount
            - --uts
            - --ipc
            - --net
            - --pid
            - --
            - sleep
            - infinity
          securityContext:
            privileged: true
      hostIPC: true
      hostPID: true
      hostNetwork: true
      priorityClassName: system-node-critical
```

本文所有文件见[kube-nodeshell](https://github.com/qingwave/kube-nodeshell)

## 临时容器

kubernetes 1.18 之后启用了临时容器，用户可以通过`kubectl debug`命令来添加临时容器到 pod，也可以登录到 node shell，一些简单的调试工作可以使用这种方法， 见[调试运行中的 Pod](https://kubernetes.io/zh/docs/tasks/debug-application-cluster/debug-running-pod/)。

对比`nsenter`方法，`kubectl debug`通过 shell 登录节点时只是共享了`pid`、`hostNetwork`，`nsenter`则更灵活可以使用宿主机的相关工具以及执行特权操作。

## 参考

- https://man7.org/linux/man-pages/man1/nsenter.1.html
- https://github.com/kvaps/kubectl-node-shell
- https://kubernetes.io/zh/docs/tasks/debug-application-cluster/debug-running-pod/
