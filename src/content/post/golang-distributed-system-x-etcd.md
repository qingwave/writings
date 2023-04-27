---
title: 'Golang分布式应用之etcd'
date: 2022-08-07T17:48:18Z
draft: false
tags: ['etcd', 'golang', '分布式']
categories: ['code']
---

etcd 是一个可靠的分布式 KV 存储数据库，由 CoreOS 开源。Kuberentes 使用 etcd 作为其存储引擎，随着云原生的火热，etcd 也逐渐广泛应用起来。

etcd 除了作为普通的 KV 存储、配置存储，还可以用在以下分布式场景中：

- 服务发现
- 分布式锁
- 选主
- 分布式队列
- 分布式系统协调
- 负载均衡

本文结合 Golang 来编写对应的中间件，所有代码见[https://github.com/qingwave/gocorex](https://github.com/qingwave/gocorex)

## 服务发现

在分布式系统中，如何能找到所需要访问的服务即服务发现。服务较少时可以直接访问其 IP，但随着业务规模的扩大，维护其地址越来越复杂，如果服务频繁的扩缩容，必须能够实时感应服务的断点变化。
通常有多种方式可以解决

1. 系统级别，如 LVS、DNS、Kubernetes 中的 Service、Istio 等
2. 微服务注册中心，如 Spring Cloud 中的 Enruka，Dubbo 等
3. 借助分布式协调系统 etcd、ZK、Consul 等

服务发现提供的功能包括：

- 服务注册、注销
- 服务宕机或异常时，自动注销
- 感知服务端点变化

借助 etcd 实现服务发现

- 可以通过将端点写同一个目录(相同前缀，如/services/job/endpoint1, /services/job/endpoint2)，并通过 Lease 设置一个过期时间，不断刷新 Lease，如果服务宕机，Lease 过期对应端点会自动删除
- 通过 Watch API 可以监听端点变化

主要代码如下

```go
func New(config EtcdDiscoveryConfig) (*EtcdDiscovery, error) {
    // 创建session，session会自动续约
	session, err := concurrency.NewSession(config.Client, concurrency.WithTTL(config.TTLSeconds))
	if err != nil {
		return nil, err
	}
	config.Prefix = strings.TrimSuffix(config.Prefix, "/") + "/"
	return &EtcdDiscovery{
		EtcdDiscoveryConfig: config,
		session:             session,
		myKey:               config.Prefix + config.Key,
		services:            make(map[string]string),
	}, nil
}

func (d *EtcdDiscovery) Register(ctx context.Context) error {
	lease := d.session.Lease()
    // 注册服务
	_, err := d.Client.Put(ctx, d.myKey, d.Val, clientv3.WithLease(lease))
	return err
}

func (d *EtcdDiscovery) UnRegister(ctx context.Context) error {
    // 注销服务
	_, err := d.Client.Delete(ctx, d.myKey)
	return err
}

// 监听端点变化
func (d *EtcdDiscovery) Watch(ctx context.Context) error {
    // context用来停止监听
	d.watchContext, d.watchCancel = context.WithCancel(ctx)
    // 首先获取所有端点
	resp, err := d.Client.Get(d.watchContext, d.Prefix, clientv3.WithPrefix())

	services := make(map[string]string)
	for _, kv := range resp.Kvs {
		services[string(kv.Key)] = string(kv.Value)
	}
	d.setServices(services)

    // 回调点，用户可自定义
	if d.Callbacks.OnStartedDiscovering != nil {
		d.Callbacks.OnStartedDiscovering(d.ListServices())
	}

	defer func() {
		if d.Callbacks.OnStoppedDiscovering != nil {
			d.Callbacks.OnStoppedDiscovering()
		}
	}()

	defer d.watchCancel()
    // 监听目录，通过WithPrefix可以添加子目录变化
	ch := d.Client.Watch(d.watchContext, d.Prefix, clientv3.WithPrefix())
	for {
		select {
		case <-d.watchContext.Done():
			return nil
		case wr, ok := <-ch:
			if !ok {
				return fmt.Errorf("watch closed")
			}
			if wr.Err() != nil {
				return wr.Err()
			}
            // 将添加事件同步到本地端点列表
			for _, ev := range wr.Events {
				key, val := string(ev.Kv.Key), string(ev.Kv.Value)
				switch ev.Type {
				case mvccpb.PUT:
					d.addService(key, val)
				case mvccpb.DELETE:
					d.delService(key)
				}
				if d.Callbacks.OnServiceChanged != nil {
					event := DiscoveryEvent{Type: mvccpb.Event_EventType_name[int32(ev.Type)], Service: d.serviceFromKv(key, val)}
					d.Callbacks.OnServiceChanged(d.ListServices(), event)
				}
			}
		}
	}
}
```

主要实现逻辑如下：

1. 创建 Session， Session 中 Lease 会自动续约
2. 服务注册时，在目录下创建对应的子目录，并附带 Lease
3. 通过 Watch 接口监听目录变化，同步到本地

简单测试下，通过 worker 模拟不同的端点

```go
func main() {
	client, err := clientv3.New(clientv3.Config{
		Endpoints:   []string{"localhost:2379"},
		DialTimeout: 3 * time.Second,
	})
	if err != nil {
		log.Fatalf("failed to create etcd lock: %v", err)
	}
	defer client.Close()

	worker := func(i int, run bool) {
		id := fmt.Sprintf("worker-%d", i)
		val := fmt.Sprintf("10.0.0.%d", i)

		sd, err := etcdiscovery.New(etcdiscovery.EtcdDiscoveryConfig{
			Client:     client,
			Prefix:     "/services",
			Key:        id,
			Val:        val,
			TTLSeconds: 2,
			Callbacks: etcdiscovery.DiscoveryCallbacks{
				OnStartedDiscovering: func(services []etcdiscovery.Service) {
					log.Printf("[%s], onstarted, services: %v", id, services)
				},
				OnStoppedDiscovering: func() {
					log.Printf("[%s], onstoped", id)
				},
				OnServiceChanged: func(services []etcdiscovery.Service, event etcdiscovery.DiscoveryEvent) {
					log.Printf("[%s], onchanged, services: %v, event: %v", id, services, event)
				},
			},
		})

		if err != nil {
			log.Fatalf("failed to create service etcdiscovery: %v", err)
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
		if err := sd.Watch(context.Background()); err != nil {
			log.Fatalf("failed to watch service: %v", err)
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
		worker(2, false)
	}()

	wg.Wait()
}
```

通过结果可以看到，服务可以正常的注册注销，并能实时监听端点变化

```bash
2022/08/08 08:44:02 [worker-1], onstarted, services: [{/services/worker-1 worker-1 10.0.0.1} {/services/worker-2 worker-2 10.0.0.2} {/services/worker-0 worker-0 10.0.0.0}]
2022/08/08 08:44:02 [worker-2], onstarted, services: [{/services/worker-0 worker-0 10.0.0.0} {/services/worker-1 worker-1 10.0.0.1} {/services/worker-2 worker-2 10.0.0.2}]
2022/08/08 08:44:02 [worker-0], onstarted, services: [{/services/worker-0 worker-0 10.0.0.0} {/services/worker-1 worker-1 10.0.0.1} {/services/worker-2 worker-2 10.0.0.2}]

2022/08/08 08:44:04 [worker-2], onchanged, services: [{/services/worker-0 worker-0 10.0.0.0} {/services/worker-1 worker-1 10.0.0.1} {/services/worker-2 worker-2 10.0.0.2} {/services/worker-3 worker-3 10.0.0.3}], event: {PUT {/services/worker-3 worker-3 10.0.0.3}}
2022/08/08 08:44:04 [worker-1], onchanged, services: [{/services/worker-0 worker-0 10.0.0.0} {/services/worker-1 worker-1 10.0.0.1} {/services/worker-2 worker-2 10.0.0.2} {/services/worker-3 worker-3 10.0.0.3}], event: {PUT {/services/worker-3 worker-3 10.0.0.3}}
2022/08/08 08:44:04 [worker-0], onchanged, services: [{/services/worker-3 worker-3 10.0.0.3} {/services/worker-0 worker-0 10.0.0.0} {/services/worker-1 worker-1 10.0.0.1} {/services/worker-2 worker-2 10.0.0.2}], event: {PUT {/services/worker-3 worker-3 10.0.0.3}}
2022/08/08 08:44:04 [worker-3], onstarted, services: [{/services/worker-0 worker-0 10.0.0.0} {/services/worker-1 worker-1 10.0.0.1} {/services/worker-2 worker-2 10.0.0.2} {/services/worker-3 worker-3 10.0.0.3}]

2022/08/08 08:44:06 [worker-1], onchanged, services: [{/services/worker-0 worker-0 10.0.0.0} {/services/worker-1 worker-1 10.0.0.1} {/services/worker-3 worker-3 10.0.0.3}], event: {DELETE {/services/worker-2 worker-2 }}
2022/08/08 08:44:06 [worker-3], onchanged, services: [{/services/worker-3 worker-3 10.0.0.3} {/services/worker-0 worker-0 10.0.0.0} {/services/worker-1 worker-1 10.0.0.1}], event: {DELETE {/services/worker-2 worker-2 }}
2022/08/08 08:44:06 [worker-0], onchanged, services: [{/services/worker-0 worker-0 10.0.0.0} {/services/worker-1 worker-1 10.0.0.1} {/services/worker-3 worker-3 10.0.0.3}], event: {DELETE {/services/worker-2 worker-2 }}
2022/08/08 08:44:06 [worker-2], onchanged, services: [{/services/worker-0 worker-0 10.0.0.0} {/services/worker-1 worker-1 10.0.0.1} {/services/worker-3 worker-3 10.0.0.3}], event: {DELETE {/services/worker-2 worker-2 }}
```

## 分布式锁

在 ECTD 官方库[go.etcd.io/etcd/client/v3/concurrency](https://pkg.go.dev/go.etcd.io/etcd/client/v3/concurrency)中，已经支持分布式锁。

主要原理与之前通过[Redis](/golang-distributed-system-x-redis)实现的分布式锁类似，如果目录创建成功则加锁成功，解锁直接删除即可。

etcd 锁的使用

```go
// 创建session并不断刷新
session, err := concurrency.NewSession(client, concurrency.WithTTL(2*time.Second))
if err != nil {
    return nil, err
}

mutex := concurrency.NewMutex(session, config.Prefix)
mutex.Lock()
defer mutext.UnLock()

do()....
```

加锁的核心逻辑如下

```go
func (m *Mutex) tryAcquire(ctx context.Context) (*v3.TxnResponse, error) {
	s := m.s
	client := m.s.Client()

	m.myKey = fmt.Sprintf("%s%x", m.pfx, s.Lease())
	cmp := v3.Compare(v3.CreateRevision(m.myKey), "=", 0)
	// put self in lock waiters via myKey; oldest waiter holds lock
	put := v3.OpPut(m.myKey, "", v3.WithLease(s.Lease()))
	// reuse key in case this session already holds the lock
	get := v3.OpGet(m.myKey)
	// fetch current holder to complete uncontended path with only one RPC
	getOwner := v3.OpGet(m.pfx, v3.WithFirstCreate()...)
	resp, err := client.Txn(ctx).If(cmp).Then(put, getOwner).Else(get, getOwner).Commit()
	if err != nil {
		return nil, err
	}
	m.myRev = resp.Header.Revision
	if !resp.Succeeded {
		m.myRev = resp.Responses[0].GetResponseRange().Kvs[0].CreateRevision
	}
	return resp, nil
}
```

tryAcquire 通过事务来执行加锁逻辑:

1. 判断当前 Key 是否为空，即代码中 Revision 为 0
2. 如果为空，使用 Put 设置并附加 Lease
3. 如果不为空，获取当前锁的所有者，即最先加锁的对象，避免惊群效应

```go
func (m *Mutex) Lock(ctx context.Context) error {
	resp, err := m.tryAcquire(ctx)
	if err != nil {
		return err
	}
	// if no key on prefix / the minimum rev is key, already hold the lock
	ownerKey := resp.Responses[1].GetResponseRange().Kvs
	if len(ownerKey) == 0 || ownerKey[0].CreateRevision == m.myRev {
		m.hdr = resp.Header
		return nil
	}
	client := m.s.Client()
	_, werr := waitDeletes(ctx, client, m.pfx, m.myRev-1)
	// release lock key if wait failed
	if werr != nil {
		m.Unlock(client.Ctx())
		return werr
	}

	// make sure the session is not expired, and the owner key still exists.
	gresp, werr := client.Get(ctx, m.myKey)

	return nil
}
```

Lock 方法会一直阻塞，直到获取锁返回执行出错:

1. 调用 tryAcquire
2. 如果已经加锁成功，或者已经加过锁（可重入），则直接返回
3. 调用 waitDeletes 方法，等待所有小于当前 Revsion 的 Key 删除

## 分布式选主

对于有状态的服务，为了提供其服务水平 SLA 减少宕机时间，通过会有多个副本，当主节点宕机时，副本节点可以快速切换。

通过 etcd 可以实现选主服务，与分布式比较类似

- 选主成功，不断上报心跳
- 通过 Watch 接口，当节点失效时，去竞争主(类似加锁过程)

在 ECTD 官方库[go.etcd.io/etcd/client/v3/concurrency](https://pkg.go.dev/go.etcd.io/etcd/client/v3/concurrency)中，已经支持了分布式选主。

选主核心逻辑如下

```go
func (e *Election) Campaign(ctx context.Context, val string) error {
	s := e.session
	client := e.session.Client()

	k := fmt.Sprintf("%s%x", e.keyPrefix, s.Lease())
	txn := client.Txn(ctx).If(v3.Compare(v3.CreateRevision(k), "=", 0))
	txn = txn.Then(v3.OpPut(k, val, v3.WithLease(s.Lease())))
	txn = txn.Else(v3.OpGet(k))
	resp, err := txn.Commit()
	if err != nil {
		return err
	}
	e.leaderKey, e.leaderRev, e.leaderSession = k, resp.Header.Revision, s
	if !resp.Succeeded {
		kv := resp.Responses[0].GetResponseRange().Kvs[0]
		e.leaderRev = kv.CreateRevision
		if string(kv.Value) != val {
			if err = e.Proclaim(ctx, val); err != nil {
				e.Resign(ctx)
				return err
			}
		}
	}

	_, err = waitDeletes(ctx, client, e.keyPrefix, e.leaderRev-1)
	if err != nil {
		// clean up in case of context cancel
		select {
		case <-ctx.Done():
			e.Resign(client.Ctx())
		default:
			e.leaderSession = nil
		}
		return err
	}
	e.hdr = resp.Header

	return nil
}
```

以上逻辑与 ECTD 锁中的实现非常相似

1. 开启事务，首先判断当前服务 Key 是否存在
2. 不存在，通过 Put 设置对应值
3. 存在获得当前目录最小 Revision 的值，即当前主节点
4. 通过 waitDeletes，直到当前进程的 Revision

简单封装下，支持回调，参考了 Kubernetes 的选主实现

```go
func New(config LeaderElectionConfig) (*EctdLeaderElection, error) {
	session, err := concurrency.NewSession(config.Client, concurrency.WithTTL(config.LeaseSeconds))
	if err != nil {
		return nil, err
	}

	election := concurrency.NewElection(session, config.Prefix)

	return &EctdLeaderElection{
		LeaderElectionConfig: config,
		session:              session,
		election:             election,
	}, nil
}
// 运行选主
func (le *EctdLeaderElection) Run(ctx context.Context) error {
	defer func() {
		le.Callbacks.OnStoppedLeading()
	}()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
    // 添加选主变化
	go le.observe(ctx)
    // 开始选主
	if err := le.election.Campaign(ctx, le.Identity); err != nil {
		return err
	}
    // 选主完成，运行OnStarted，运行结束则退出选主
	le.Callbacks.OnStartedLeading(ctx)

	return nil
}
// 监听Key变化，执行回调
func (le *EctdLeaderElection) observe(ctx context.Context) {
	if le.Callbacks.OnNewLeader == nil {
		return
	}

	ch := le.election.Observe(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case resp, ok := <-ch:
			if !ok {
				return
			}

			if len(resp.Kvs) == 0 {
				continue
			}

			leader := string(resp.Kvs[0].Value)
			if leader != le.Identity {
				go le.Callbacks.OnNewLeader(leader)
			}
		}
	}
}

func (le *EctdLeaderElection) Close() error {
	return le.session.Close()
}
```

测试选主服务

```go
func main() {
	client, err := clientv3.New(clientv3.Config{
		Endpoints:   []string{"localhost:2379"},
		DialTimeout: 3 * time.Second,
	})
	if err != nil {
		log.Fatalf("failed to create etcd lock: %v", err)
	}
	defer client.Close()

	prefix := "/worker/election"
	worker := func(i int) {
		id := fmt.Sprintf("worker-%d", i)

		le, err := leaderelection.New(leaderelection.LeaderElectionConfig{
			Client:       client,
			LeaseSeconds: 15,
			Prefix:       prefix,
			Identity:     id,
			Callbacks: leaderelection.LeaderCallbacks{
				OnStartedLeading: func(ctx context.Context) {
					log.Printf("OnStarted[%s]: acquire new leader", id)
					time.Sleep(3 * time.Second)
					log.Printf("OnStarted[%s]: worker done", id)
				},
				OnStoppedLeading: func() {
					log.Printf("OnStopped[%s]: exit", id)
				},
				OnNewLeader: func(identity string) {
					log.Printf("OnNewLeader[%s]: new leader %s", id, identity)
				},
			},
		})

		if err != nil {
			log.Fatalf("failed to create leader election: %v", err)
		}
		defer le.Close()

		le.Run(context.Background())
	}

	wg := sync.WaitGroup{}
	for i := 1; i <= 3; i++ {
		wg.Add(1)
		id := i
		go func() {
			defer wg.Done()
			worker(id)
		}()
	}

	wg.Wait()
}
```

运行结果

```bash
2022/08/08 09:33:32 OnNewLeader[worker-2]: new leader worker-3
2022/08/08 09:33:32 OnNewLeader[worker-1]: new leader worker-3
2022/08/08 09:33:32 OnStarted[worker-3]: acquire new leader
2022/08/08 09:34:02 OnStarted[worker-3]: worker done
2022/08/08 09:34:02 OnStopped[worker-3]: exit
2022/08/08 09:34:02 OnStarted[worker-2]: acquire new leader
2022/08/08 09:34:02 OnNewLeader[worker-1]: new leader worker-2
2022/08/08 09:34:32 OnStarted[worker-2]: worker done
2022/08/08 09:34:32 OnStopped[worker-2]: exit
2022/08/08 09:34:32 OnStarted[worker-1]: acquire new leader
2022/08/08 09:35:02 OnStarted[worker-1]: worker done
2022/08/08 09:35:02 OnStopped[worker-1]: exit
```

## 发布订阅

借助 etcd 的前缀查找、Watch 的功能，可以实现发布订阅功能，主要逻辑如下

```go
// 发布时，直接通过Put将对象设置在对应Topic路径下，并可以设置Lease，自动删除过时消息
func (ps *EtcdPubSub) Publish(ctx context.Context, topic string, msg Msg) error {
	le, err := ps.Client.Lease.Grant(ctx, int64(ps.TTLSeconds))
	if err != nil {
		return err
	}

	_, err = ps.Client.Put(ctx, ps.Prefix+topic+"/"+msg.Name, msg.Val, clientv3.WithLease(le.ID))
	return err
}

// 订阅时，通过Watch来监听Topic是否有Put事件，这里忽略Delete事件
// Revision为0时，从当前时间点开始监听
// Revision为1时，监听Topic创建后的所有事件
func (ps *EtcdPubSub) SubscribeFromRev(ctx context.Context, topic string, rev int64) (<-chan Msg, error) {
	wch := ps.Client.Watch(ctx, ps.Prefix+topic, clientv3.WithPrefix(), clientv3.WithFilterDelete(), clientv3.WithRev(rev))

	msg := make(chan Msg)
	go func() {
		defer close(msg)

		for {
			wc, ok := <-wch
			if !ok {
				return
			}

			for _, ev := range wc.Events {
				if ev.Type != mvccpb.PUT {
					break
				}
				name := strings.TrimPrefix(string(ev.Kv.Key), ps.Prefix+topic+"/")
				msg <- Msg{Name: name, Val: string(ev.Kv.Value)}
			}
		}
	}()

	return msg, nil
}
```

发布时，直接通过 PUT 操作在 Topic 路径下设置消息；
订阅时，通过 Watch 来捕获消息，通过 Revision 来配置不同的监听行为

- Revision 为 0 时，从当前时间点开始监听
- Revision 为 1 时，监听 Topic 创建后的所有事件

## 总结

本文主要结合 Golang 总结了 etcd 中服务发现、分布式锁、选主等实现方式，另外 etcd 还可以应用在发布订阅、负载均衡等方面。

本文所有代码见[https://github.com/qingwave/gocorex](https://github.com/qingwave/gocorex)，欢迎批评指正。

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
