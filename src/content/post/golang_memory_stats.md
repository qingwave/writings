---
date: 2024-05-09T09:54:12.219Z
title: Golang内存问题排查
draft: false
description: '如何快速定位内存泄漏'
excerpt: ''
image: '/img/gomemstats/go_mem_stats_pprof.png'
categories: ['code']
tags: ['golang']
---

最近压测一个Golang实现的新业务时，疑似有内存泄漏，虽然最终确认业务没有问题，先将排查思路整理下，以供参考。

结论先行：
- 实际占用内存(RSS)与[Golang Memstats](https://pkg.go.dev/runtime#MemStats)(或pprof显示的内存占用)并不一致
- 通过[pprof](https://pkg.go.dev/net/http/pprof)工具可快速分析出Golang本身的内存占用情况
- 如果Golang Memstats/pprof显示正常
    - 可能是非Golang内存占用, 如`CGO`造成的内存泄漏，线程泄漏等，可查看线程数等相关指标
    - 或是Golang系统本身预留了部分内存，方便下次快速分配，可以通过`Memstats`简单计算Golang系统占用内存：
        ```
        Sys - HeapReleased # Golang系统占用内存
        HeapIdle - HeapReleased # Golang系统预留内存
        ```

## 背景

业务需要，实现了一个新的`k8s operator`(Golang 1.22)，上线前需要压测，具体步骤如下：
- 压测前，`CPU~=0`, `MEM~=20MB`
- 开始压测，创建了1000个CR(自定义资源)实例, `CPU~=30%`, `MEM~=150MB`
- 清理所有CR，`CPU~=0`，`MEM~=130MB`

CPU/MEM监控分别如下：
![CPU Usage](/img/gomemstats/go_mem_stats_cpu_usage.png)

![MEM Usage](/img/gomemstats/go_mem_stats_mem_usage.png)

测试多次还是一样的现象，怀疑是不是代码中存在内存泄漏？

## 排查思路

### Golang pprof

首先想到是用pprof工具排查，得到内存火焰图如下：
![MEM 火焰图](/img/gomemstats/go_mem_stats_pprof.png)

显示堆内存占用只有14.5MB，那么其他120MB内存去哪儿了？

通过`top`查看
```bash
top - 06:22:47 up  3:34,  0 user,  load average: 0.25, 0.32, 0.47
Tasks:   1 total,   0 running,   1 sleeping,   0 stopped,   0 zombie
%Cpu(s):  1.8 us,  0.9 sy,  0.0 ni, 97.2 id,  0.0 wa,  0.0 hi,  0.1 si,  0.0 st 
MiB Mem :  31644.3 total,  15941.1 free,   4054.4 used,  12104.9 buff/cache     
MiB Swap:      0.0 total,      0.0 free,      0.0 used.  27589.8 avail Mem 
    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND                     
  17867 65532     20   0 1336224  77632  27100 S   0.0   0.2  22:36.45 manager   
```

那是不是Goroutine, 线程泄漏？
排查了Goroutine只有84个，线程也稳定在16个。

### runtime.MemStats

`runtime.MemStats` 是Golang runtime提供的用来存储关于内存统计信息的结构体，注意这里计算的是虚拟内存与实际内存是有差异的，层级结构如下：
```bash
Sys # 总的系统内存
    HeapSys # 堆总内存
        HeapInUse # 堆中在使用的内存
        HeapIdle # 堆空闲内存
            HeapReleased # 返回给OS的内存数据
            ...
    StackSys # Stack总内存
    MSpanSys # mspan总内存
    CacheSys
    OtherSys
```

`MemStats`各个数据有如下关系：
| 表达式 | 含义 |
|-----|-----|
|`Sys=HeapSys + StackSys + MSpanSys + ..Sys` | 总内存  |
|`Sys-HeapReleased` | Golang总的使用内存 |
|`HeapIdle-HeapReleased` | Golang系统预留内存 |
|`HeapInuse-HeapAlloc`| 分配了但没有使用的内存，可以评估碎片上限 |
|`NextGC-HeapAlloc`|NextGC是下一次Heap GC的目标，如果小于HeapAlloc说明下次需要GC掉一部分空间|


通过pprof可以方便获取到`MemStats`

```bash
$ curl http://localhost:6060/debug/pprof/heap?debug=1
# runtime.MemStats
# Alloc = 11551184
# TotalAlloc = 567854091960
# Sys = 141271320 -- 134M
# HeapAlloc = 11551184 -- 11Mi
# HeapSys = 127844352 -- 121.9Mi
# HeapIdle = 104562688 -- 99.7Mi
# HeapInuse = 23281664 -- 22.2Mi
# HeapReleased = 100155392 -- 95.5Mi
# HeapObjects = 41263
# Stack = 2129920 / 2129920 -- 2M
# MSpan = 380800 / 2040000 -- 0.36M
# MCache = 9600 / 15600
# BuckHashSys = 2525199 -- 2.4M
# GCSys = 4930776 -- 4.7M
# OtherSys = 1785473 -- 1.7M
# NextGC = 22293192 -- 21.2M
# LastGC = 1715128450468461934
```

可以得到，总的使用内存39M与监控看到的内存存在较大差异，而且`HeapReleased`与`HeapIdle`比较接近，说明Golang系统预留内存也不多
```
Sys - HeapReleased = 134M - 95M = 39M
```

这里存在两种情况，要么内存被其他系统资源占用了，要么Golang runtime并没有将内存
1. 程序没有使用`CGO`，系统线程占用也不多，排除1
2. Golang特定版本(1.12~1.16)确实有RSS高于使用占用的情况，由于将`madvise()`系统调用参数设置为`MADV_FREE`, 系统并不会立即释放内存, 下次申请时可以快速使用这部分内存，从而提高性能。但我们的程序使用的是1.22，默认是`MADV_DONTNEED`, 也不太可能是这样的原因

### Core dump

[viewcore](https://github.com/golang/debug/blob/master/cmd/viewcore/main.go)是官方提供的一个查看系统dump的工具。

首先生成运行时的程序core dmup, 可以通过`gcore/glv/gdb`等生成运行时的内存dump，再通过`viewcore`查看，这里要吐槽一下，`viewcore`官方维护不积极，bug很多而且对新版本支持也不好，不推荐使用。

由于要生成Core dump线上环境缺少相关工具，本地复现后，内存分布如下
```bash
(viewcore) breakdown
 all                  3877613568 100.00% # 虚拟内存, 与top中显示的虚拟内存一致
   text                 33193984   0.86% 
   readonly           3330621440  85.89% 
   data                  1085440   0.03% 
   bss                 394878976  10.18% (grab bag, includes OS thread stacks, ...)
   heap                117440512   3.03% # 主要看heap占用，等价于MemStats.HeapSys
     in use spans       24395776   0.63% 
       alloc             7977224   0.21% 
         live            7659552   0.20% 
         garbage          317672   0.01% 
       free             16309240   0.42% 
       round              109312   0.00% 
     manual spans        2392064   0.06% (Go stacks)
       alloc             2142208   0.06% 
       free               249856   0.01% 
     free spans         90652672   2.34% 
       retained          7184384   0.19% (kept for reuse by Go)
       released         83468288   2.15% (given back to the OS) # 等价于MemStats.HeapReleased
   ptr bitmap             262144   0.01% 
   span table             131072   0.00% 
```

`viewcore`显示的堆内存数据与`runtime.Memstats`基本一致，其他虚拟内存数据没有参考价值。

### 再次验证

那有没有可能是`GC`的问题，开启了强制回收`debug.FreeOSMemory`，会减少20MB内存，但仍然有差异。

经过各种验证，好像走到了死胡同，唯一的推测还是这部分缺少内存还是Golang系统保留了，如果再次压测内存再与前一次测验相差不多的话，那么说明多出的内存是被Golang预留了。

压测之后，确实符合预期，两个压测后内存基本一致
![banchmark](/img/gomemstats/go_mem_stats_bench.png)

Golang的内存分配非常复杂，暴露出的指标很难推测出这个问题的根因，需要根据代码深入分析，目前只能合理推测RSS与MemStats显示的内存差值是由于以下原因：
- 采集误差
- 内存碎片
- Golang系统预留
- 内核内存占用
- CGO使用的内存

## 总结

通过以上分析，我们可以定位Golang引起的内存泄漏，一般排查步骤如下：
1. 通过PProf获取Heap相关内存系统
2. 通过监控排查线程、Goroutine是否有异常
3. 检查Golang版本是否开启了`MADV_FREE`
4. 获取`runtime.MemStats`进行分析
   - `RSS ~ Sys - HeapReleased`, 可能是Golang问题
   - `RSS >> Sys - HeapReleased`, 可能是非Golang问题
   - `HeapIdle-HeapReleased > 0`, Golang系统预留了内存

通过这些步骤，我们可以更有效地识别和解决由Golang引起的内存相关问题。

## 参考
- https://go.dev/src/runtime/mstats.go
- https://github.com/golang/go/issues/32284
- https://fanlv.fun/2022/06/02/golang-pprof-mem
- https://www.datadoghq.com/blog/go-memory-metrics/

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
