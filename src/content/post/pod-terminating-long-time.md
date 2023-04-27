---
title: Pod一直显示Terminating
date: 2018-10-26 10:41:03
tags:
  - k8s
categories:
  - cloud
---

## 问题

集群中有一个 pod 一直显示 Terminating

### event

```bash
Normal Scheduled 1h default-scheduler Successfully assigned feed-426565da19777e5d325f-5994dc5cff-znqmh to node01
Normal SuccessfulMountVolume 1h kubelet, node01 (combined from similar events): MountVolume.SetUp succeeded for volume "lvm"
Normal Pulled 1h kubelet, node01 Container image  already present on machine
Normal Created 1h kubelet, node01 Created container
Normal Started 1h kubelet, node01 Started container
Warning Unhealthy 9m (x44 over 1h) kubelet, node01 Liveness probe failed: Get http://*:65318/state.json: dial tcp *.*.*.*:65318: getsockopt: connection refused
Warning Unhealthy 9m (x45 over 1h) kubelet, node01 Readiness probe failed: Get http://*:65318/state.json: dial tcp *.*.*.*:65318: getsockopt: connection refused
Normal Killing 9m kubelet, node01 Killing container with id docker://main:Need to kill Pod
Warning FailedKillPod 5m (x2 over 7m) kubelet, node01 error killing pod: failed to "KillPodSandbox" for "163f99a9-1aec-11e9-a7cd-246e96ab9970" with KillPodSandboxError: "rpc error: code = DeadlineExceeded desc = context deadline exceeded"
```

### 日志

```bash
kubelet: error killing pod: failed to "KillPodSandbox" for "163f99a9-1aec-11e9-a7cd-246e96ab9970" with KillPodSandboxError: "rpc error: code = DeadlineExceeded desc = context deadline exceeded"
```

## 探究

### 查看进程

```bash
ps aux |grep D #查看无法终止的进程（stat D）
root 2626 0.0 0.0 0 0 ? Ds 14:42 0:00 [pause]

ps afx |grep -C 10 2626 #显示父进程
root 2626 2603 0 14:42 ? 00:00:00 [pause]

ps -ef |grep 2603 #查看父进程
root 2603 27573 0 14:42 ? 00:00:00 docker-containerd-shim -namespace moby -workdir /home/docker/containerd/daemon/io.containerd.runtime.v1.linux/moby/ba519a9f1a1102a922bcc74ced7a7fc9fd3f963feea4b8de

ps -ef |grep 27573
root 27573 27553 0 2018 ? 17:02:40 docker-containerd --config /var/run/docker/containerd/containerd.toml

ps -ef |grep 27553
root 27553 1 3 2018 ? 3-16:03:11 /usr/bin/dockerd --bip=10.126.64.193/26 --mtu=1500 -g /home/docker -D -H tcp://127.0.0.1:1983 -H unix:///var/run/docker.sock --tlsverify --iptables=false --storage-driver=devicemapper --storage-opt dm.override_udev_sync_check=true --storage-opt dm.datadev=/dev/vg_root/dmdata --storage-opt dm.metadatadev=/dev/vg_root/dmmeta --exec-opt native.cgroupdriver=cgroupfs

docker ps |grep ba519a9f1a1 #查看docker
ba519a9f1a11 k8s.gcr.io/pause-amd64:3.1 "/pause" 2 hours ago Up 2 hours k8s_POD_feed-426565da19777e5d325f-5994dc5cff-znqmh_ocean-feed_163f99a9-1aec-11e9-a7cd-246e96ab9970_0
```

### 可能原因

可能是内核原因
https://stackoverflow.com/questions/34552232/cant-kill-processes-originating-in-a-docker-container
目前只有重启物理机才能解决
