---
title: 'Golang分布式应用之ZooKeeper'
date: 2022-08-08T08:48:26Z
draft: false
tags: ['zk', 'golang', '分布式']
categories: ['code']
---

ZooKeeper 是 Apache 下一个开源项目，提供分布式配置、同步服务以及命名注册等，是一个高可靠的分布式协调系统。

其应用场景与 etcd 类似，可以使用在

- 服务发现
- 分布式锁
- 选主
- 分布式队列
- 分布式系统协调
- 负载均衡

如在 Hadooop、Kafka 中将 ZooKeeper 作为核心组件。本文结合 Golang 来编写对应的中间件，所有代码见[https://github.com/qingwave/gocorex](https://github.com/qingwave/gocorex)

## 服务注册

服务注册主要细节在[etcd](/golang-distributed-system-x-etcd)中已提及，主要来解决分布式环境中服务注册注销与状态感知，包括：

- 服务注册、注销
- 服务宕机或异常时，自动注销
- 感知服务端点变化

借助 zk 实现服务发现:

- 可以通过将端点写同一个目录(相同前缀，如/services/job/endpoint1, /services/job/endpoint2)，写入临时节点，如果服务宕机，Session 过期对应端点会自动删除
- 通过 Watch API 可以监听端点变化

核心代码如下：

```go
// 注册，1表示临时节点
func (d *ZkDiscovery) Register(ctx context.Context) error {
	_, err := d.conn.Create(d.myKey, []byte(d.Val), 1, d.ACL)
	if err == zk.ErrNodeExists {
		return nil
	}
	return err
}

// 注销，直接删除对应Key即可
func (d *ZkDiscovery) UnRegister(ctx context.Context) error {
	err := d.conn.Delete(d.myKey, -1)
	if err == zk.ErrNoNode {
		return nil
	}
	return err
}
```

服务监听通过 zk Watch 接口

```go
func (d *ZkDiscovery) Watch(ctx context.Context) error {
	d.watchContext, d.watchCancel = context.WithCancel(ctx)
    // 获取最新列表
	if err := d.refreshServices(); err != nil {
		return err
	}

	if d.Callbacks.OnStartedDiscovering != nil {
		d.Callbacks.OnStartedDiscovering(d.ListServices())
	}

	defer d.watchCancel()

	defer func() {
		if d.Callbacks.OnStoppedDiscovering != nil {
			d.Callbacks.OnStoppedDiscovering()
		}
	}()

loop:
    // 添加节点变化
	children, _, ch, err := d.conn.ChildrenW(d.Path)
	if err != nil {
		return err
	}
    d.setServices(containerx.NewSet(children...))
	for {
		select {
		case <-d.watchContext.Done():
			return nil
		case e, ok := <-ch:
        // zk 是一个一次性触发器，收到事件后需要重新watch
			if !ok {
				goto loop
			}
			if e.Err != nil {
				return e.Err
			}
            // 当子节点变化时，获取最新服务列表
			switch e.Type {
			case zk.EventNodeCreated, zk.EventNodeChildrenChanged:
				d.refreshServices()
			}

			switch e.State {
			case zk.StateExpired:
				return fmt.Errorf("node [%s] expired", d.myKey)
			case zk.StateDisconnected:
				return nil
			}

			if d.Callbacks.OnServiceChanged != nil {
				d.Callbacks.OnServiceChanged(d.ListServices())
			}
		}
	}
}
```

通过 worker 模拟不同的端点，测试代码如下：

```go
func main() {
	ctx, cancel := context.WithCancel(context.Background())
	worker := func(i int, run bool) {
		id := fmt.Sprintf("10.0.0.%d", i)
		val := fmt.Sprintf("10.0.0.%d", i)

		sd, err := zkdiscovery.New(zkdiscovery.ZkDiscoveryConfig{
			Endpoints:      []string{"127.0.0.1"},
			Path:           "/zk/services",
			SessionTimeout: 2 * time.Second,
			Key:            id,
			Val:            val,
			Callbacks: zkdiscovery.DiscoveryCallbacks{
				OnStartedDiscovering: func(services []zkdiscovery.Service) {
					log.Printf("[%s] onstarted, services: %v", id, services)
				},
				OnStoppedDiscovering: func() {
					log.Printf("[%s] onstoped", id)
				},
				OnServiceChanged: func(services []zkdiscovery.Service) {
					log.Printf("[%s] onchanged, services: %v", id, services)
				},
			},
		})

		if err != nil {
			log.Fatalf("failed to create service discovery: %v", err)
		}
		defer sd.Close()

		if !run {
			if sd.UnRegister(context.Background()); err != nil {
				log.Fatalf("failed to unregister service [%s]: %v", id, err)
			}
			return
		}

		if err := sd.Register(context.Background()); err != nil {
			log.Fatalf("failed to register service [%s]: %v", id, err)
		}

		if err := sd.Watch(ctx); err != nil {
			log.Printf("[%s] failed to watch service: %v", id, err)
		}
	}

	wg := group.NewGroup()
	for i := 0; i < 3; i++ {
		id := i
		wg.Go(func() { worker(id, true) })
	}

	go func() {
		time.Sleep(2 * time.Second)
		worker(3, true)
	}()

	// unregister
	go func() {
		time.Sleep(4 * time.Second)
		worker(1, false)
	}()

	// wg.Wait()

	time.Sleep(5 * time.Second)
	cancel()
	time.Sleep(1 * time.Second)
}
```

通过结果可以看到服务能够正常注册注销，而且可以监听到节点变化

```bash
2022/08/09 03:01:29 connected to 127.0.0.1:2181
2022/08/09 03:01:29 connected to 127.0.0.1:2181
2022/08/09 03:01:29 connected to 127.0.0.1:2181
2022/08/09 03:01:29 authenticated: id=72787622169739423, timeout=4000
2022/08/09 03:01:29 re-submitting `0` credentials after reconnect
2022/08/09 03:01:29 authenticated: id=72787622169739424, timeout=4000
2022/08/09 03:01:29 authenticated: id=72787622169739425, timeout=4000
2022/08/09 03:01:29 re-submitting `0` credentials after reconnect
2022/08/09 03:01:29 re-submitting `0` credentials after reconnect
2022/08/09 03:01:29 [10.0.0.2] onstarted, services: [{10.0.0.1 } {10.0.0.0 } {10.0.0.2 }]
2022/08/09 03:01:29 [10.0.0.0] onstarted, services: [{10.0.0.0 } {10.0.0.2 } {10.0.0.1 }]
2022/08/09 03:01:29 [10.0.0.1] onstarted, services: [{10.0.0.0 } {10.0.0.2 } {10.0.0.1 }]
2022/08/09 03:01:31 connected to 127.0.0.1:2181
2022/08/09 03:01:31 authenticated: id=72787622169739426, timeout=4000
2022/08/09 03:01:31 re-submitting `0` credentials after reconnect
2022/08/09 03:01:31 [10.0.0.0] onchanged, services: [{10.0.0.0 } {10.0.0.2 } {10.0.0.1 } {10.0.0.3 }]
2022/08/09 03:01:31 [10.0.0.1] onchanged, services: [{10.0.0.3 } {10.0.0.0 } {10.0.0.2 } {10.0.0.1 }]
2022/08/09 03:01:31 [10.0.0.2] onchanged, services: [{10.0.0.0 } {10.0.0.2 } {10.0.0.1 } {10.0.0.3 }]
2022/08/09 03:01:31 [10.0.0.3] onstarted, services: [{10.0.0.1 } {10.0.0.3 } {10.0.0.0 } {10.0.0.2 }]
2022/08/09 03:01:33 connected to 127.0.0.1:2181
2022/08/09 03:01:33 authenticated: id=72787622169739427, timeout=4000
2022/08/09 03:01:33 re-submitting `0` credentials after reconnect
2022/08/09 03:01:33 [10.0.0.3] onchanged, services: [{10.0.0.0 } {10.0.0.2 } {10.0.0.3 }]
2022/08/09 03:01:33 [10.0.0.2] onchanged, services: [{10.0.0.0 } {10.0.0.2 } {10.0.0.3 }]
2022/08/09 03:01:33 [10.0.0.0] onchanged, services: [{10.0.0.3 } {10.0.0.0 } {10.0.0.2 }]
2022/08/09 03:01:33 [10.0.0.1] onchanged, services: [{10.0.0.0 } {10.0.0.2 } {10.0.0.3 }]
2022/08/09 03:01:33 recv loop terminated: EOF
2022/08/09 03:01:33 send loop terminated: <nil>
2022/08/09 03:01:34 [10.0.0.3] onstoped
2022/08/09 03:01:34 [10.0.0.0] onstoped
2022/08/09 03:01:34 [10.0.0.2] onstoped
2022/08/09 03:01:34 [10.0.0.1] onstoped
```

## 分布式锁

在包[github.com/go-zookeeper/zk](https://github.com/go-zookeeper/zk)中已经实现了分布式锁，主要借助了 ZooKeeper 的临时节点的功能

- 加锁时，创建临时节点（client 与 zk server 会保持长链接，链接中断则创建的临时数据会被删除）
- 解锁时，直接删除节点即可

主要来看加锁过程

```go
func (l *Lock) LockWithData(data []byte) error {
	if l.lockPath != "" {
		return ErrDeadlock
	}

	prefix := fmt.Sprintf("%s/lock-", l.path)

	path := ""
	var err error
    // 重试3次
	for i := 0; i < 3; i++ {
        // 创建临时顺序节点，同名节点会加序列号
		path, err = l.c.CreateProtectedEphemeralSequential(prefix, data, l.acl)
		if err == ErrNoNode {
			// Create parent node.
			parts := strings.Split(l.path, "/")
			pth := ""
			for _, p := range parts[1:] {
				var exists bool
				pth += "/" + p
                // 父路径不存在，创建父节点
				exists, _, err = l.c.Exists(pth)
				if err != nil {
					return err
				}
				if exists == true {
					continue
				}
				_, err = l.c.Create(pth, []byte{}, 0, l.acl)
				if err != nil && err != ErrNodeExists {
					return err
				}
			}
		} else if err == nil {
			break
		} else {
			return err
		}
	}
	if err != nil {
		return err
	}
    // 解析序列号
	seq, err := parseSeq(path)
	if err != nil {
		return err
	}
    // 获取lock下所有子节点，根据序列号判断是否获得锁
	for {
		children, _, err := l.c.Children(l.path)
		if err != nil {
			return err
		}

		lowestSeq := seq
		prevSeq := -1
		prevSeqPath := ""

		for _, p := range children {
			s, err := parseSeq(p)
			if err != nil {
				return err
			}
			if s < lowestSeq {
				lowestSeq = s
			}
            // 获取此节点前一个序列号
			if s < seq && s > prevSeq {
				prevSeq = s
				prevSeqPath = p
			}
		}
        // 如果当前节点序列号最低，则获取到锁
		if seq == lowestSeq {
			// Acquired the lock
			break
		}

		// 否则等待节点删除
		_, _, ch, err := l.c.GetW(l.path + "/" + prevSeqPath)
		if err != nil && err != ErrNoNode {
			return err
		} else if err != nil && err == ErrNoNode {
			// try again
			continue
		}

		ev := <-ch
		if ev.Err != nil {
			return ev.Err
		}
	}

	l.seq = seq
	l.lockPath = path
	return nil
}
```

主要逻辑如下：

1. 创建临时顺序节点
2. 如果父节点不存在，则创建父节点
3. 获取 lock 下所有子节点序列号
4. 如果当前节点序列号最小，则获得锁
5. 否则，等待前一个删除，直到获取锁

对比 etcd 的实现，大体思路基本一致，主要差异点在于

- TTL 实现：etcd 通过 Lease 的实现 TTL，获取锁后不断刷新 Lease; zk 通过 Session 来实现 TTL，Session 中止会自动清楚临时节点
- 顺序获取锁：etcd 通过 Revision 来实现；zk 则通过临时顺序节点

## 对比 etcd

ZooKeeper 与 etcd 的使用场景高度重合，可以项目替代，主要区别有以下几点

| 对比项     | ZooKeeper                                              | etcd                            |
| ---------- | ------------------------------------------------------ | ------------------------------- |
| 一致性协议 | zab                                                    | raft                            |
| 健康检查   | 基于 Session                                           | 心跳，Lease 刷新                |
| Watch      | 一次性触发器、只能添加子节点创建、删除，事件不包含数据 | 可以添加前缀、Range、子节点变化 |
| 多版本控制 | 不支持                                                 | 支持，所有 Key 含有 Revision    |

etcd 作为后期之秀，在功能上更丰富，新项目可以优先尝试使用 etcd 作为其分布式协调引擎。

## 总结

本文分析了 ZooKeeper 在分布式锁、服务发现等场景上的实现方式，并对比了与 etcd 的差异点。

本文所有代码见[https://github.com/qingwave/gocorex](https://github.com/qingwave/gocorex)，欢迎批评指正。

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
