---
title: '如何实现零宕机的配置热加载'
date: 2022-09-30T10:37:17+08:00
draft: false
description: '在单机与分布式环境中实现配置监听与更新'
tags: ['golang', 'etcd', 'linux', '分布式']
categories: ['code']
---

对于高可用的服务，为了保证服务可用性，更新配置时必然不能直接停止服务，可以使用配置热加载来避免服务暂停，不需要重启服务。

配置的热加载可以分为两个场景，手动更新与自动更新。

## 手动更新

对于一些临时调试，服务数量不多的情况下，可以进行手动更新配置。需要实现两点，如何触发更新，以及接受到更新后如何操作。

触发更新的手段很多，常见的有

- 通过命令行，例如`nginx -s reload`
- 通过信号，通常是 SIGHUP，比如 sshd、Prometheus 等，其实 Nginx 的热加载内部也是调用 SIGHUP 信号
- HTTP 接口，例如 Prometheus 也支持 HTTP 的方式通过`curl -X POST :9090/-/reload`可以重新加载配置
- RPC 接口，类似 HTTP

接受到配置更新通知后，需要程序内部来重新加载配置，类似初始化过程，但要注意运行时可以要加锁来保证线程安全。

## 自动更新

自动更新是建立手动更新的基础上，首先服务要提供手动更新的方法，其次可以通过服务本身或者外部进程来自动调用配置更新接口，外部程序可以使用 SideCar 的形式与服务绑定。

自动加载配置的关键是如何感知配置变化，要考虑到单机环境与分布式环境。

### 单机环境

Linux 提供了[inotify](https://man7.org/linux/man-pages/man7/inotify.7.html)接口，可以用来监听文件或者目录的增上改查事件。我们可以使用 inotify 来监听配置变化，如果有更新则调用更新接口来实现热加载。其他平台也提供了类似的接口。

在 Golang 中[fsnotify](https://github.com/fsnotify/fsnotify)提供了跨平台的文件监听接口，可以方便的监听文件，使用方式如下：

```go
    watcher, _ := fsnotify.NewWatcher()
    defer watcher.Close()

    // 监听目录或者文件
    watcher.Add("/tmp")

    go func() {
        for {
            // 获取监听事件
            select {
            case event, ok := <-watcher.Events:
                if !ok {
                    return
                }
                log.Println("event:", event)
                if event.Has(fsnotify.Write) {
                    log.Println("modified file:", event.Name)
                    // 进行更新操作
                }
            case err, ok := <-watcher.Errors:
                if !ok {
                    return
                }
                log.Println("error:", err)
            }
        }
    }()
```

### 分布式环境

在分布式环境中实现配置热更新，需要能够感知配置（本地或者远端），对于本地配置需要平台配合将远端配置同步到本地（比如 kubernetes 会同步 ConfigMap 到 Pod 中），然后按照单机环境的方式来监听文件变化。

对于远端配置，需要依赖额外的分布式配置中心，比如 Apollo、etcd、ZooKeeper 等。以 etcd 为例，etcd 提供了 watch 接口，可以监听对应配置的变化

```go
// 获取watch Channel
ch := client.Watch(d.watchContext, d.Prefix, clientv3.WithPrefix())

// 处理事件
for {
		select {
		case wr, ok := <-ch:
			if !ok {
				return fmt.Errorf("watch closed")
			}
			if wr.Err() != nil {
				return wr.Err()
			}
			for _, ev := range wr.Events {
				key, val := string(ev.Kv.Key), string(ev.Kv.Value)
				switch ev.Type {
				case mvccpb.PUT:
					// 更新处理逻辑
                    // 1. 对比配置是否变化
                    // 2. 变化了更新内存中的配置
				case mvccpb.DELETE:
					// 删除处理逻辑
				}
			}
		}
	}
```

为了实现配置更新通知，通常有两种方式，Pull 与 Push。

- Pull 就是客户端轮询，定期查询配置是否更新，这种方式实现简单，对服务器压力小，但时效性低
- Push 由服务端实现，通过维护一个长连接，实时推送数据，这种方式时效性高，但逻辑更复杂，连接过多会影响服务端性能。目前 etcd v3 版本是通过 HTTP2 来实现实时数据推送

## 总结

本文主要总结实现配置热更新的多种方式，手动更新可以通过 Socket、信号等进程间通信手段来通知服务，自动更新可以通过 inotify 来感知配置变化，在分布式环境中就需要配合分布式配置中心来进行热更新。

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
