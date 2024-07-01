---
title: cgroup引起的应用延迟
subtitle: lxcfs/cadvisor cpu使用率高
date: 2019-11-13 17:42:06
image: /img/blog/lxcfs-cpu.png
tags:
  - k8s
  - cadvisor
categories:
  - cloud
---

## 背景

用户发现线上某容器请求 hbase 延迟较大，其他容器无类似现象，发现问题容器宿主机系统 cpu 占用较大（30%左右，正常在 5%以下）。通过 top 查看 lxcfs 占用 cpu 较多（200%以上）。

## 探究

查看宿主机(内核 4.9.2)top,显示每个 cpu 使用信息。查看最高的 cpu 占用是**lxcfs**造成的。

`strace`查看 lxcfs 调用

```bash
#查看调用情况，read占用99%
$ strace -p 18521 -c
% time     seconds  usecs/call     calls    errors syscall
------ ----------- ----------- --------- --------- ----------------
 99.82   78.360112       39797      1969           read
  0.11    0.088295         122       722           munmap
  0.01    0.011649         416        28           wait4
  0.01    0.010611          14       736           open
  0.01    0.005685          75        76        18 futex
  0.01    0.005288           7       792           close
  0.01    0.005115          14       366           writev
  0.01    0.004750           7       722           mmap
  0.00    0.003552           5       722           fstat
  0.00    0.002989         107        28           epoll_wait
  0.00    0.002102          17       126           stat
  0.00    0.000202          14        14           socketpair
  0.00    0.000157          11        14           write
  0.00    0.000122           4        28           epoll_create
  0.00    0.000111           8        14           recvmsg
  0.00    0.000104           4        28           epoll_ctl
  0.00    0.000091           3        28           clone
  0.00    0.000071           5        14           setsockopt
  0.00    0.000059           4        14           setns
  0.00    0.000012           1        14           recvfrom
  0.00    0.000011           1        14           sendmsg
  0.00    0.000003           0        14           set_robust_list
  0.00    0.000000           0        14           getpid
------ ----------- ----------- --------- --------- ----------------

# 查看详细情况，大量读取cgroup下memory的调用
$ strace -p 18521 -f -T -tt -o lx.log

cat lx.log
79153 14:20:31.122630 open("/run/lxcfs/controllers/memory//kubepods/burstable/pod7077217d-de6f-11e9-9352-246e96d53468/bcac6516ca5b2a60880fcbc752bf6878ddc77905db71269d852d17f5dc90b148/memory.memsw.limit_in_bytes", O_RDONLY) = 5 <0.000017>

```

经发现某个 pod 调用的次数明显高于其他 pod，排查到其容器内每隔 2s 执行`ps -auf`，会调用/proc/pid/stat 其中就有 memory 相关的。

开开心心联系业务将其驱逐，宿主机没有明显变化，再次查看`top`

```bash
top - 13:43:56 up 120 days, 19:21,  1 user,  load average: 6.59, 3.26, 2.34
Tasks: 630 total,   1 running, 629 sleeping,   0 stopped,   0 zombie
%Cpu(s):  0.8 us,  7.1 sy,  0.0 ni, 92.1 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
KiB Mem : 13170992+total, 93100928 free,  7571536 used, 31037456 buff/cache
KiB Swap:        0 total,        0 free,        0 used. 11042460+avail Mem

   PID USER      PR  NI    VIRT    RES    SHR S  %CPU %MEM     TIME+ COMMAND
 20686 root      20   0  141152  49032  17960 S  51.3  0.0   5890:25 cadvisor
115798 root      20   0       0      0      0 D  19.5  0.0   0:09.62 kworker/14:0
 95501 root      20   0       0      0      0 D  17.2  0.0   0:10.11 kworker/0:1
 38620 root      20   0       0      0      0 D  13.9  0.0   0:07.92 kworker/2:1
111178 root      20   0       0      0      0 D  13.9  0.0   0:10.67 kworker/6:0
 58741 root      20   0       0      0      0 D  12.3  0.0   0:10.50 kworker/15:1
104600 root      20   0       0      0      0 D  12.3  0.0   0:05.55 kworker/8:2
 15166 root      20   0       0      0      0 D  10.9  0.0   0:04.44 kworker/16:1
 89483 root      20   0       0      0      0 D  10.9  0.0   0:04.73 kworker/11:0
 30487 root      20   0 3905496 152268  36216 S   9.3  0.1   3060:33 dockerd
 41220 work      20   0  687540 300368  16012 S   4.0  0.2 235:53.07 lottery-service
125923 root      20   0 4892136 181572  58924 S   3.6  0.1  21469:57 kubelet
 ...
```

发现 cadvisor 占用较高的 cpu，联系以前遇到的问题，cadvisor 也是采集 memory 时变慢,测试居然需要 2 秒多！

```
$ time cat /sys/fs/cgroup/memory/memory.stat
cache 25691987968
rss 3426922496
rss_huge 2759852032
...

real	0m2.485s
user	0m0.000s
sys	0m2.484s
```

主要原因是产生了某些僵尸 cgroup(比如反复启动，进程不存在了，但 cgroup 还没来得及回收，cgroup 会反复计算这些 cgroup 的内存会占用)，导致 cpu 使用增加[相关 issue](https://github.com/google/cadvisor/issues/1774#issuecomment-406314361) 以及[thread](https://lkml.org/lkml/2018/7/3/101)

## 解决

根本原因还需要进一步分析，临时解决办法，通过手动释放内存

```bash
echo 2 > /proc/sys/vm/drop_caches
```

如果没效果可尝试

```bash
echo 3 > /proc/sys/vm/drop_caches
```

释放后，果然系统 cpu 逐渐恢复正常了，从 falcon 查看 cpu 确实下降了
![lxcf-cpu](/img/blog/lxcfs-cpu.png)

## 跟进

经排查，我们使用的内核较旧为（4.9.2）;僵尸 cgroup 过多, 导致遍历 cgroup 读取 per_cpu 变量时可能引起锁的争用。

僵尸 cgroup：没有进程运行，并已经被删除的 cgroup，但是所占用的内存并没有被完全回收(inode，dentry 等缓存资源)，在读取 memory.stat 仍会计算这部分 cgroup 的缓存空间。

目前该问题在新版的内核（如 5.4）中得到修复，新内核引用新的数据结构解决该问题：每次分配内存时，会即时更新 cgroup 的内存使用情况存储到专用的统计变量，因此读取某个 cgroup 的 mem stat 不会涉及到 per_cpu 变量，可以立即返回。
