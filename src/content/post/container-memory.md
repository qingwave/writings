---
title: 容器内存分析
date: 2019-05-29 14:37:21
tags:
  - k8s
  - docker
  - cgroup
  - cadvisor
categories:
  - cloud
---

## 背景

在容器化环境中，平台需要提供准确的业务监控指标，已方便业务查看。那么如何准确计算容器或 Pod 的内存使用率，k8s/docker 又是如何计算，本文通过实验与源码阅读相结合来分析容器的内存实际使用量。

## 预备知识

不管 docker 还是 k8s(通过 cadvisor)最终都通过 cgroup 的 memory group 来得到内存的原始文件，memory 相关的主要文件如下:

```
cgroup.event_control       #用于eventfd的接口
memory.usage_in_bytes      #显示当前已用的内存
memory.limit_in_bytes      #设置/显示当前限制的内存额度
memory.failcnt             #显示内存使用量达到限制值的次数
memory.max_usage_in_bytes  #历史内存最大使用量
memory.soft_limit_in_bytes #设置/显示当前限制的内存软额度
memory.stat                #显示当前cgroup的内存使用情况
memory.use_hierarchy       #设置/显示是否将子cgroup的内存使用情况统计到当前cgroup里面
memory.force_empty         #触发系统立即尽可能的回收当前cgroup中可以回收的内存
memory.pressure_level      #设置内存压力的通知事件，配合cgroup.event_control一起使用
memory.swappiness          #设置和显示当前的swappiness
memory.move_charge_at_immigrate #设置当进程移动到其他cgroup中时，它所占用的内存是否也随着移动过去
memory.oom_control         #设置/显示oom controls相关的配置
memory.numa_stat           #显示numa相关的内存
```

更多信息可参考[Pod memory usage in k8s](https://qingwave.github.io/2018/11/15/Pod-memory-usage-in-k8s/#Cadvisor%E4%B8%AD%E6%9C%89%E5%85%B3pod%E5%86%85%E5%AD%98%E4%BD%BF%E7%94%A8%E7%8E%87%E7%9A%84%E6%8C%87%E6%A0%87)

## 查看源码

### docker stat

docker stat 的源码在[stats_helpers.go](https://github.com/docker/cli/blob/37f9a88c696ae81be14c1697bd083d6421b4933c/cli/command/container/stats_helpers.go#L233),如下：

```go
func calculateMemUsageUnixNoCache(mem types.MemoryStats) float64 {
    return float64(mem.Usage - mem.Stats["cache"])
}
```

内存使用量为`memory.usage=memory.usage_in_bytes-cache`

### kubectl top

在 k8s 中，`kubectl top`命令通过`metric-server/heapster`获取 cadvisor 中`working_set`的值，来表示 Pod 实例使用内存大小(不包括 pause),metrics-server 中[pod 内存](https://github.com/kubernetes-sigs/metrics-server/blob/d4432d67b2fc435b9c71a89c13659882008a4c54/pkg/sources/summary/summary.go#L206)获取如下：

```go
func decodeMemory(target *resource.Quantity, memStats *stats.MemoryStats) error {
	if memStats == nil || memStats.WorkingSetBytes == nil {
		return fmt.Errorf("missing memory usage metric")
	}

	*target = *uint64Quantity(*memStats.WorkingSetBytes, 0)
	target.Format = resource.BinarySI

	return nil
}
```

cadvisor 中[working_set](https://github.com/google/cadvisor/blob/0ff17b8d0df3712923c46ca484701b876d02dfee/container/libcontainer/handler.go#L706)计算如下：

```go
func setMemoryStats(s *cgroups.Stats, ret *info.ContainerStats) {
	ret.Memory.Usage = s.MemoryStats.Usage.Usage
	ret.Memory.MaxUsage = s.MemoryStats.Usage.MaxUsage
	ret.Memory.Failcnt = s.MemoryStats.Usage.Failcnt

	if s.MemoryStats.UseHierarchy {
		ret.Memory.Cache = s.MemoryStats.Stats["total_cache"]
		ret.Memory.RSS = s.MemoryStats.Stats["total_rss"]
		ret.Memory.Swap = s.MemoryStats.Stats["total_swap"]
		ret.Memory.MappedFile = s.MemoryStats.Stats["total_mapped_file"]
	} else {
		ret.Memory.Cache = s.MemoryStats.Stats["cache"]
		ret.Memory.RSS = s.MemoryStats.Stats["rss"]
		ret.Memory.Swap = s.MemoryStats.Stats["swap"]
		ret.Memory.MappedFile = s.MemoryStats.Stats["mapped_file"]
	}
	if v, ok := s.MemoryStats.Stats["pgfault"]; ok {
		ret.Memory.ContainerData.Pgfault = v
		ret.Memory.HierarchicalData.Pgfault = v
	}
	if v, ok := s.MemoryStats.Stats["pgmajfault"]; ok {
		ret.Memory.ContainerData.Pgmajfault = v
		ret.Memory.HierarchicalData.Pgmajfault = v
	}

	workingSet := ret.Memory.Usage
	if v, ok := s.MemoryStats.Stats["total_inactive_file"]; ok {
		if workingSet < v {
			workingSet = 0
		} else {
			workingSet -= v
		}
	}
	ret.Memory.WorkingSet = workingSet
}
```

`working_set=memory.usage_in_bytes-total_inactive_file (>=0)`
在 kubelet 中节点内存不足时同样以`working_set`判断 pod 是否 OOM 的标准

## 实验

1. 创建 Pod
   Pod 的资源申请如下：

```yaml
resources:
  limits:
    cpu: '1'
    memory: 1Gi
  requests:
    cpu: '0'
    memory: '0'
```

2. 查看 cgroup 内存情况
   找到容器某个进程，查看 memory cgroup

```bash
# cat /proc/16062/cgroup
...
8:memory:/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod21a55da5_f9f8_11e9_b051_fa163e7e981a.slice/docker-57ba1991ab4ba50a9b2eaf5bf90e2c20073198d767653becf77d55ee25e1a6f9.scope
```

进入容器 memory cgroup 对应的目录

```
docker-57ba1991ab4ba50a9b2eaf5bf90e2c20073198d767653becf77d55ee25e1a6f9.scope]# ls
cgroup.clone_children  memory.kmem.failcnt             memory.kmem.tcp.limit_in_bytes      memory.max_usage_in_bytes        memory.move_charge_at_immigrate  memory.stat            tasks
cgroup.event_control   memory.kmem.limit_in_bytes      memory.kmem.tcp.max_usage_in_bytes  memory.memsw.failcnt             memory.numa_stat                 memory.swappiness
cgroup.procs           memory.kmem.max_usage_in_bytes  memory.kmem.tcp.usage_in_bytes      memory.memsw.limit_in_bytes      memory.oom_control               memory.usage_in_bytes
memory.failcnt         memory.kmem.slabinfo            memory.kmem.usage_in_bytes          memory.memsw.max_usage_in_bytes  memory.pressure_level            memory.use_hierarchy
memory.force_empty     memory.kmem.tcp.failcnt         memory.limit_in_bytes               memory.memsw.usage_in_bytes      memory.soft_limit_in_bytes       notify_on_release
```

查看主要 memory 文件

```bash
# cat memory.limit_in_bytes (容器memory limit值，即1Gi)
1073741824
[root@node01 docker-57ba1991ab4ba50a9b2eaf5bf90e2c20073198d767653becf77d55ee25e1a6f9.scope]# cat memory.kmem.limit_in_bytes (容器内核使用memory limit值)
9223372036854771712
[root@node01 docker-57ba1991ab4ba50a9b2eaf5bf90e2c20073198d767653becf77d55ee25e1a6f9.scope]#
[root@node01 docker-57ba1991ab4ba50a9b2eaf5bf90e2c20073198d767653becf77d55ee25e1a6f9.scope]# cat memory.soft_limit_in_bytes
9223372036854771712
[docker-57ba1991ab4ba50a9b2eaf5bf90e2c20073198d767653becf77d55ee25e1a6f9.scope]# cat notify_on_release
0
[docker-57ba1991ab4ba50a9b2eaf5bf90e2c20073198d767653becf77d55ee25e1a6f9.scope]# cat memory.oom_control
oom_kill_disable 0
under_oom 0
oom_kill 0
[docker-57ba1991ab4ba50a9b2eaf5bf90e2c20073198d767653becf77d55ee25e1a6f9.scope]# cat memory.usage_in_bytes
2265088
[docker-57ba1991ab4ba50a9b2eaf5bf90e2c20073198d767653becf77d55ee25e1a6f9.scope]# cat memory.kmem.usage_in_bytes
901120
[docker-57ba1991ab4ba50a9b2eaf5bf90e2c20073198d767653becf77d55ee25e1a6f9.scope]# cat memory.stat
cache 12288
rss 1351680
rss_huge 0
shmem 4096
mapped_file 4096
dirty 0
writeback 0
swap 0
pgpgin 4544
pgpgout 4211
pgfault 1948
pgmajfault 0
inactive_anon 4096
active_anon 1351680
inactive_file 8192
active_file 0
unevictable 0
hierarchical_memory_limit 1073741824
hierarchical_memsw_limit 1073741824
total_cache 12288
total_rss 1351680
total_rss_huge 0
total_shmem 4096
total_mapped_file 4096
total_dirty 0
total_writeback 0
total_swap 0
total_pgpgin 4544
total_pgpgout 4211
total_pgfault 1948
total_pgmajfault 0
total_inactive_anon 4096
total_active_anon 1351680
total_inactive_file 8192
total_active_file 0
total_unevictable 0
```

根据 memory 可得到如下关系：
`memory.usage_in_bytes = memory.kmem.usage_in_bytes + rss + cache`
即 2265088=901120+1351680+12288

那么容器的真实内存即：
`memory.usage=memory.usage_in_bytes-cache`
即`rss+kmem_usage`

通过`docker stat`查看，与公式相符合

```
CONTAINER ID        NAME                                                                                     CPU %               MEM USAGE / LIMIT   MEM %               NET I/O             BLOCK I/O           PIDS
57ba1991ab4b        k8s...default_21a55da5-f9f8-11e9-b051-fa163e7e981a_0   0.00%               2.148MiB / 1GiB     0.21%               12MB / 68.8MB       0B / 0B             2
```

## 结论

实际环境中，docker 与 k8s 两种内存表示方式不同，一般`docker stat`总体值会小于`kubectl top`

- docker 中内存表示为：
  `memory.usage = memory.usage_in_bytes - cache`
- k8s 中：
  `memory.usage = working_set = memory.usage_in_bytes - total_inactive_file (>=0)`
  根据 cgroup memory 关系有：
  `memory.usage_in_bytes = memory.kmem.usage_in_bytes + rss + cache`

真实环境中两种表示相差不大，但更推荐使用`working_set`作为容器内存真实使用量(kubelt 判断 OOM 的依据)，
则容器内存使用率可表示为：
`container_memory_working_set_bytes / memory.limit_in_bytes`

## 参考

1. https://www.kernel.org/doc/Documentation/cgroup-v1/memory.txt
2. https://medium.com/@zhimin.wen/memory-limit-of-pod-and-oom-killer-891ee1f1cad8
