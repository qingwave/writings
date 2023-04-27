---
title: pod sandbox 创建失败
author: qinng
toc: true
tags:
  - k8s
  - docker
date: 2020-03-18 18:22:05
categories:
  - cloud
---

## 背景

今天在 k8s 更新服务时,发现 pod 启动失败,报错`failed to start sandbox container`,如下所示:

```bash
Events:
  Type     Reason                  Age                     From                                           Message
  ----     ------                  ----                    ----                                           -------
  Normal   Scheduled               28m                     default-scheduler                              Successfully assigned kube-system/k8s-proxy-7wkt4 to tj1-staging-com-ocean007-201812.kscn
  Warning  FailedCreatePodSandBox  28m (x13 over 28m)      kubelet, tj1-staging-com-ocean007-201812.kscn  Failed create pod sandbox: rpc error: code = Unknown desc = failed to start sandbox container for pod "k8s-proxy-7wkt4": Error response from daemon: OCI runtime create failed: container_linux.go:345: starting container process caused "process_linux.go:297: getting the final child's pid from pipe caused \"EOF\"": unknown
  Normal   SandboxChanged          3m19s (x1364 over 28m)  kubelet, tj1-staging-com-ocean007-201812.kscn  Pod sandbox changed, it will be killed and re-created.
```

## 分析

sandbox 创建失败只是表象,是宿主机其他异常导致的,一般是(cpu,diskio,mem)导致的.

首先,上节点看 kubelet,docker 有无异常,日志没有明显错误,通过`top`看到 docker cpu 占用非常高

```bash
[root@tj1-staging-com-ocean007-201812 ~]# top

top - 17:55:00 up 265 days,  3:41,  1 user,  load average: 10.71, 11.34, 10.76
Tasks: 816 total,   5 running, 811 sleeping,   0 stopped,   0 zombie
%Cpu(s): 24.0 us, 34.5 sy,  0.0 ni, 41.4 id,  0.0 wa,  0.0 hi,  0.1 si,  0.0 st
KiB Mem : 65746380 total, 20407940 free, 11007040 used, 34331400 buff/cache
KiB Swap:        0 total,        0 free,        0 used. 49134416 avail Mem

    PID USER      PR  NI    VIRT    RES    SHR S  %CPU %MEM     TIME+ COMMAND
 115483 root      20   0 3965212 273188  34564 S 489.7  0.4 382260:40 dockerd
1367523 root      20   0   18376   2972   2716 R  66.9  0.0  20163:45 bash
1367487 root      20   0   11856   5616   4512 S  54.0  0.0  16748:26 containerd-shim
3200169 root      20   0    1300      4      0 R  53.3  0.0  14913:49 sh
2429952 root      20   0    1300      4      0 S  49.3  0.0   9620:56 sh
3200130 root      20   0    9392   4756   3884 S  47.7  0.0  13417:30 containerd-shim
3718475 root      20   0    1300      4      0 R  47.4  0.0   8600:20 sh
3718440 root      20   0   10736   5516   4512 S  42.1  0.0   7575:31 containerd-shim
2429917 root      20   0   11856   5556   4512 S  40.1  0.0   8313:22 containerd-shim
3205493 root      20   0 3775924 230996  66704 S  18.9  0.4   2559:07 kubelet
      1 root      20   0  195240 157000   3932 S   7.9  0.2   1417:46 systemd
    804 dbus      20   0   30308   6460   2464 S   1.7  0.0 462:18.84 dbus-daemon
1011737 root      20   0  277656 122788  18428 S   1.3  0.2 768:03.00 cadvisor
 115508 root      20   0 7139200  32896  24288 S   1.0  0.1 662:25.27 containerd
    806 root      20   0   24572   3060   2480 S   0.7  0.0 171:22.52 systemd-logind
 511080 root       0 -20 2751348  52552  15744 S   0.7  0.1 178:27.51 sagent
1102507 root      20   0   11792   7292   4512 S   0.7  0.0  23:36.37 containerd-shim
1272223 root      20   0  164800   5296   3824 R   0.7  0.0   0:00.38 top
2866292 root      20   0 5045000 1.983g   3080 S   0.7  3.2 230:09.47 redis
```

同时, cpu system 异常高.

```bash
%Cpu(s): 24.0 us, 34.5 sy,  0.0 ni, 41.4 id,  0.0 wa,  0.0 hi,  0.1 si,  0.0 st
```

按照以前的经验,一般是由某些容器引起的,通过`top`看到个别`sh`进程占用 cpu 较高.

通过`ps`看到进程居然是个死循环

```bash
[root@tj1-staging-com-ocean007-201812 ~]# ps -ef |grep 1367523
root     1287628 1247781  0 17:55 pts/1    00:00:00 grep --color=auto 1367523
root     1367523 1367504 72 Feb28 ?        14-00:04:17 /bin/bash -c while true; do echo hello; done
```

通过`/proc/pid/cgroup`找到对应容器

```bash
# cat /proc/1367523/cgroup
11:freezer:/kubepods/besteffort/pod55d3adf2-67f7-11ea-93f2-246e968203b8/29842d5544b701dbb5ff647dba19bb4ebec821edc6ee1ffbd7aeee58fa5038fd
10:devices:/kubepods/besteffort/pod55d3adf2-67f7-11ea-93f2-246e968203b8/29842d5544b701dbb5ff647dba19bb4ebec821edc6ee1ffbd7aeee58fa5038fd
9:hugetlb:/kubepods/besteffort/pod55d3adf2-67f7-11ea-93f2-246e968203b8/29842d5544b701dbb5ff647dba19bb4ebec821edc6ee1ffbd7aeee58fa5038fd
8:blkio:/kubepods/besteffort/pod55d3adf2-67f7-11ea-93f2-246e968203b8/29842d5544b701dbb5ff647dba19bb4ebec821edc6ee1ffbd7aeee58fa5038fd
7:memory:/kubepods/besteffort/pod55d3adf2-67f7-11ea-93f2-246e968203b8/29842d5544b701dbb5ff647dba19bb4ebec821edc6ee1ffbd7aeee58fa5038fd
6:perf_event:/kubepods/besteffort/pod55d3adf2-67f7-11ea-93f2-246e968203b8/29842d5544b701dbb5ff647dba19bb4ebec821edc6ee1ffbd7aeee58fa5038fd
5:cpuset:/kubepods/besteffort/pod55d3adf2-67f7-11ea-93f2-246e968203b8/29842d5544b701dbb5ff647dba19bb4ebec821edc6ee1ffbd7aeee58fa5038fd
4:pids:/kubepods/besteffort/pod55d3adf2-67f7-11ea-93f2-246e968203b8/29842d5544b701dbb5ff647dba19bb4ebec821edc6ee1ffbd7aeee58fa5038fd
3:net_cls,net_prio:/kubepods/besteffort/pod55d3adf2-67f7-11ea-93f2-246e968203b8/29842d5544b701dbb5ff647dba19bb4ebec821edc6ee1ffbd7aeee58fa5038fd
2:cpu,cpuacct:/kubepods/besteffort/pod55d3adf2-67f7-11ea-93f2-246e968203b8/29842d5544b701dbb5ff647dba19bb4ebec821edc6ee1ffbd7aeee58fa5038fd
1:name=systemd:/kubepods/besteffort/pod55d3adf2-67f7-11ea-93f2-246e968203b8/29842d5544b701dbb5ff647dba19bb4ebec821edc6ee1ffbd7aeee58fa5038fd
```

找到对应容器

```bash
docker ps | grep 29842d554
```

清理完相关 pod 后,系统恢复正常

```
top - 18:25:57 up 265 days,  4:12,  1 user,  load average: 1.05, 1.24, 4.02
Tasks: 769 total,   1 running, 768 sleeping,   0 stopped,   0 zombie
%Cpu(s):  1.7 us,  0.9 sy,  0.0 ni, 97.3 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
KiB Mem : 65746380 total, 22106960 free, 10759860 used, 32879560 buff/cache
KiB Swap:        0 total,        0 free,        0 used. 49401576 avail Mem

    PID USER      PR  NI    VIRT    RES    SHR S  %CPU %MEM     TIME+ COMMAND
3205493 root      20   0 3775924 229844  66704 S   9.9  0.3   2563:18 kubelet
 115483 root      20   0 3965468 249124  34564 S   7.9  0.4 382323:36 dockerd
      1 root      20   0  195240 157000   3932 S   6.3  0.2   1419:48 systemd
    804 dbus      20   0   30308   6460   2464 S   2.0  0.0 462:51.51 dbus-daemon
3085322 root      20   0 12.045g 1.578g  19028 S   1.3  2.5 767:51.19 java
 115508 root      20   0 7139200  32264  24288 S   1.0  0.0 662:42.18 containerd
 511080 root       0 -20 2751348  42116  15744 S   1.0  0.1 178:44.79 sagent
1011737 root      20   0  277656 111836  18428 S   1.0  0.2 768:49.01 cadvisor
1523167 root      20   0  164800   5436   4012 R   0.7  0.0   0:00.04 top
3199459 root      20   0 1554708  43668   9496 S   0.7  0.1  28:50.60 falcon-agent
      7 root      20   0       0      0      0 S   0.3  0.0 619:07.64 rcu_sched
    806 root      20   0   24572   3060   2480 S   0.3  0.0 171:33.69 systemd-logind
  11921 root      20   0   94820  20480   5840 S   0.3  0.0   1402:42 consul
 575838 root      20   0  411464  17092   7364 S   0.3  0.0  15:16.25 python
 856593 root      20   0 1562392  37912   9612 S   0.3  0.1  21:34.23 falcon-agent
 931957 33        20   0   90728   3392   1976 S   0.3  0.0   0:51.23 nginx
1212186 root      20   0       0      0      0 S   0.3  0.0   0:01.12 kworker/14:1
1726228 root      20   0    9392   4496   3808 S   0.3  0.0   0:00.67 containerd-shim
1887128 root      20   0  273160   7932   3128 S   0.3  0.0  46:05.23 redis-server
2788111 root      20   0  273160   6300   3080 S   0.3  0.0  25:18.55 redis-server
3199297 root      20   0 1563160  44812   9624 S   0.3  0.1  31:13.73 falcon-agent
```

## 总结

sandox 创建失败的原因是各种各样的, 如[memory 设置错误触发的异常][1],[dockerd 异常][2].

针对此处问题是由于某些测试 pod 通过`while true; do echo hello; done`启动,死循环一直`echo hello`产生大量`read()`系统调用,所在 cpu 飙升.多个类似 pod 导致系统非常繁忙,无法正常处理其他请求.

此类问题不容易在 pod 创建时直接检测到,只能通过添加物理节点相关报警(dockerd cpu 使用率, node cpu.sys 使用率)及时发现问题.

## 引用

- https://github.com/kubernetes/kubernetes/issues/56996
- https://plugaru.org/2018/05/21/pod-sandbox-changed-it-will-be-killed-and-re-created/
