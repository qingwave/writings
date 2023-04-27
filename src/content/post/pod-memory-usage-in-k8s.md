---
title: Pod memory usage in k8s
date: 2018-11-15 12:42:15
tags:
  - k8s
  - docker
  - cadvisor
categories:
  - cloud
---

## Cadvisor 内存使用率指标

### Cadvisor 中有关 pod 内存使用率的指标

| 指标                               | 说明                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| container_memory_cache             | Number of bytes of page cache memory.                                                                                   |
| container_memory_rss               | Size of RSS in bytes.(包括匿名映射页和交换区缓存)                                                                       |
| container_memory_swap              | Container swap usage in bytes.                                                                                          |
| container_memory_usage_bytes       | Current memory usage in bytes,including all memory regardless ofwhen it was accessed. (包括 cache, rss, swap 等)        |
| container_memory_max_usage_bytes   | Maximum memory usage recorded in bytes.                                                                                 |
| container_memory_working_set_bytes | Current working set in bytes. （工作区内存使用量=活跃的匿名与和缓存,以及 file-baked 页 <=container_memory_usage_bytes） |
| container_memory_failcnt           | Number of memory usage hits limits.                                                                                     |
| container_memory_failures_total    | Cumulative count of memory allocation failures.                                                                         |

其中
`container_memory_max_usage_bytes > container_memory_usage_bytes >= container_memory_working_set_bytes > container_memory_rss`

### Cadvisor 中相关定义

```
type MemoryStats struct { // Current memory usage, this includes all memory regardless of when it was // accessed. // Units: Bytes. Usage uint64 json:"usage"

// Maximum memory usage recorded.
	// Units: Bytes.
	MaxUsage uint64 `json:"max_usage"`

	// Number of bytes of page cache memory.
	// Units: Bytes.
	Cache uint64 `json:"cache"`

	// The amount of anonymous and swap cache memory (includes transparent
	// hugepages).
	// Units: Bytes.
	RSS uint64 `json:"rss"`

	// The amount of swap currently used by the processes in this cgroup
	// Units: Bytes.
	Swap uint64 `json:"swap"`

	// The amount of working set memory, this includes recently accessed memory,
	// dirty memory, and kernel memory. Working set is <= "usage".
	// Units: Bytes.
	WorkingSet uint64 `json:"working_set"`

	Failcnt uint64 `json:"failcnt"`

	ContainerData    MemoryStatsMemoryData `json:"container_data,omitempty"`
	HierarchicalData MemoryStatsMemoryData `json:"hierarchical_data,omitempty"`
}
```

> You might think that memory utilization is easily tracked with container_memory_usage_bytes, however, this metric also includes cached (think filesystem cache) items that can be evicted under memory pressure. The better metric is container_memory_working_set_bytes as this is what the OOM killer is watching for.
> To calculate container memory utilization we use: sum(container_memory_working_set_bytes{name!~"POD"}) by (name)

kubelet 通过 watch container_memory_working_set_bytes 来判断是否 OOM， 所以用 working set 来评价容器内存使用量更科学

## Cgroup 中关于 mem 指标

cgroup 目录相关文件

| 文件名                      | 说明                                                                  | cadvisor 中对应指标          |
| --------------------------- | --------------------------------------------------------------------- | ---------------------------- |
| memory.usage_in_bytes       | 已使用的内存量(包含 cache 和 buffer)(字节)，相当于 linux 的 used_meme | container_memory_usage_bytes |
| memory.limit_in_bytes       | 限制的内存总量(字节)，相当于 linux 的 total_mem                       |
| memory.failcnt              | 申请内存失败次数计数                                                  |
| memory.memsw.usage_in_bytes | 已使用的内存和 swap(字节)                                             |
| memory.memsw.limit_in_bytes | 限制的内存和 swap 容量(字节)                                          |
| memory.memsw.failcnt        | 申请内存和 swap 失败次数计数                                          |
| memory.stat                 | 内存相关状态                                                          |

memory.stat 中包含有的内存信息

| 统计                      | 描述                                                                                                      | cadvisor 中对应指标    |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------- |
| cache                     | 页缓存，包括 tmpfs（shmem），单位为字节                                                                   | container_memory_cache |
| rss                       | 匿名和 swap 缓存，不包括 tmpfs（shmem），单位为字节                                                       | container_memory_rss   |
| mapped_file               | memory-mapped 映射的文件大小，包括 tmpfs（shmem），单位为字节                                             |
| pgpgin                    | 存入内存中的页数                                                                                          |
| pgpgout                   | 从内存中读出的页数                                                                                        |
| swap                      | swap 用量，单位为字节                                                                                     | container_memory_swap  |
| active_anon               | 在活跃的最近最少使用（least-recently-used，LRU）列表中的匿名和 swap 缓存，包括 tmpfs（shmem），单位为字节 |
| inactive_anon             | 不活跃的 LRU 列表中的匿名和 swap 缓存，包括 tmpfs（shmem），单位为字节                                    |
| active_file               | 活跃 LRU 列表中的 file-backed 内存，以字节为单位                                                          |
| inactive_file             | 不活跃 LRU 列表中的 file-backed 内存，以字节为单位                                                        |
| unevictable               | 无法再生的内存，以字节为单位                                                                              |
| hierarchical_memory_limit | 包含 memory cgroup 的层级的内存限制，单位为字节                                                           |
| hierarchical_memsw_limit  | 包含 memory cgroup 的层级的内存加 swap 限制，单位为字节                                                   |

```
active_anon + inactive_anon = anonymous memory + file cache for tmpfs + swap cache = rss + file cache for tmpfs
active_file + inactive_file = cache - size of tmpfs
working set = usage - total_inactive(k8s根据workingset 来判断是否驱逐pod)
```

mstat 看到的 active/inactive memory 就分别是 active list 和 inactive list 中的内存大小。如果 inactive list 很大，表明在必要时可以回收的页面很多；而如果 inactive list 很小，说明可以回收的页面不多。
Active/inactive memory 是针对用户进程所占用的内存而言的，内核占用的内存（包括 slab）不在其中。
至于在源代码中看到的 ACTIVE_ANON 和 ACTIVE_FILE，分别表示 anonymous pages 和 file-backed pages。用户进程的内存页分为两种：与文件关联的内存（比如程序文件、数据文件所对应的内存页）和与文件无关的内存（比如进程的堆栈，用 malloc 申请的内存），前者称为 file-backed pages，后者称为 anonymous pages。File-backed pages 在发生换页(page-in 或 page-out)时，是从它对应的文件读入或写出；anonymous pages 在发生换页时，是对交换区进行读/写操作。

## 参考

- https://blog.freshtracks.io/a-deep-dive-into-kubernetes-metrics-part-3-container-resource-metrics-361c5ee46e66
- https://github.com/google/cadvisor/blob/08f0c2397cbca790a4db0f1212cb592cc88f6e26/info/v1/container.go#L338:6
