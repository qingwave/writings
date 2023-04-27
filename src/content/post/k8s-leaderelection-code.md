---
title: k8s基于资源锁的选主分析
date: 2019-12-27 20:13:14
tags:
  - k8s
categories:
  - cloud
---

## 简介

k8s 中为了实现高可用，需要部署多个副本，例如多个 apiserver、scheduler、controller-manager 等，其中 apiserver 是无状态的每个组件都可以工作，而 scheduler 与 controller-manager 是有状态的，同一时刻只能存在一个活跃的，需要进行选主。

<!--more-->

k8s 使用了资源锁（endpoints/configmap/lease）的方式来实现选主，多个副本去创建资源，创建成功则获得锁成为 leader，leader 在租约内去刷新锁，其他副本则通过比对锁的更新时间判断是否成为新的 leader。

k8s 采用了资源版本号的乐观锁方式来实现选主，对比 etcd 选主，效率更高，并发性更好。

## 源码分析

k8s 选主实现在 client-go 中，包`k8s.io/client-go/tools/leaderelection`

### 结构定义

锁结构定义如下：

```go
// k8s.io/client-go/tools/leaderelection/resourcelock/interface.go
type LeaderElectionRecord struct {
  // leader 标识，通常为 hostname
  HolderIdentity       string           `json:"holderIdentity"`
  // 同启动参数 --leader-elect-lease-duration
  LeaseDurationSeconds int              `json:"leaseDurationSeconds"`
  // Leader 第一次成功获得租约时的时间戳
  AcquireTime          unversioned.Time `json:"acquireTime"`
  // leader 定时 renew 的时间戳
  RenewTime            unversioned.Time `json:"renewTime"`
  LeaderTransitions    int              `json:"leaderTransitions"`
}
```

k8s 中的选举锁需实现`resourcelock.Interface`接口，基本上实现 CRU，将 leader 信息存在在 annotation 中

```go
// k8s.io/client-go/tools/leaderelection/resourcelock/interface.go
type Interface interface {
	// Get returns the LeaderElectionRecord
	Get() (*LeaderElectionRecord, []byte, error)

	// Create attempts to create a LeaderElectionRecord
	Create(ler LeaderElectionRecord) error

	// Update will update and existing LeaderElectionRecord
	Update(ler LeaderElectionRecord) error

	// RecordEvent 记录锁切换事件
	RecordEvent(string)

	// Identity will return the locks Identity
	Identity() string

	// Describe is used to convert details on current resource lock
	// into a string
	Describe() string
}
```

### 创建资源锁

锁类型包括：configmaps， endpoints, lease, 以及 multiLock

```go
// k8s.io/client-go/tools/leaderelection/resourcelock/interface.go
func New(lockType string, ns string, name string, coreClient corev1.CoreV1Interface, coordinationClient coordinationv1.CoordinationV1Interface, rlc ResourceLockConfig) (Interface, error) {
	endpointsLock := &EndpointsLock{
		EndpointsMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      name,
		},
		Client:     coreClient,
		LockConfig: rlc,
	}
	configmapLock := &ConfigMapLock{
		ConfigMapMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      name,
		},
		Client:     coreClient,
		LockConfig: rlc,
	}
	leaseLock := &LeaseLock{
		LeaseMeta: metav1.ObjectMeta{
			Namespace: ns,
			Name:      name,
		},
		Client:     coordinationClient,
		LockConfig: rlc,
	}
	switch lockType {
	case EndpointsResourceLock:
		return endpointsLock, nil
	case ConfigMapsResourceLock:
		return configmapLock, nil
	case LeasesResourceLock:
		return leaseLock, nil
	case EndpointsLeasesResourceLock:
		return &MultiLock{
			Primary:   endpointsLock,
			Secondary: leaseLock,
		}, nil
	case ConfigMapsLeasesResourceLock:
		return &MultiLock{
			Primary:   configmapLock,
			Secondary: leaseLock,
		}, nil
	default:
		return nil, fmt.Errorf("Invalid lock-type %s", lockType)
	}
}
```

使用者首先通过`new()`函数创建资源锁，需要提供锁类型、namespace、name、唯一标示等。

### 进行选举

创建选举配置，通常如下：

```go
      // start the leader election code loop
      leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
          // 资源锁类型
          Lock: lock,
          // 租约时长，非主候选者用来判断资源锁是否过期
          LeaseDuration:   60 * time.Second,
          // leader刷新资源锁超时时间
          RenewDeadline:   15 * time.Second,
          // 调用资源锁间隔
          RetryPeriod:     5 * time.Second,
          // 回调函数，根据选举不同事件触发
          Callbacks: leaderelection.LeaderCallbacks{
              OnStartedLeading: func(ctx context.Context) {
                  run(ctx)
              },
              OnStoppedLeading: func() {
                  klog.Infof("leader lost: %s", id)
                  os.Exit(0) // 必须要退出，重启开始选主，否则将不会参与到选主中
              },
              OnNewLeader: func(identity string) {
                  if identity == id {
                      return
                  }
                  klog.Infof("new leader elected: %s", identity)
              },
          },
      })
```

创建选举对象后，执行`Run`函数开始选主

```go
// k8s.io/client-go/tools/leaderelection/leaderelection.go
// Run starts the leader election loop
func (le *LeaderElector) Run(ctx context.Context) {
	defer func() {
        runtime.HandleCrash()
        // 锁丢失时执行OnStoppedLeading回调函数
		le.config.Callbacks.OnStoppedLeading()
    }()
    // 尝试获得锁
	if !le.acquire(ctx) {
		return // ctx signalled done
	}
	ctx, cancel := context.WithCancel(ctx)
    defer cancel()
    // 获得锁后执行OnStartedLeading回调函数
	go le.config.Callbacks.OnStartedLeading(ctx)
    // 定期刷新锁
    le.renew(ctx)
}
```

acruire 方法：

```go
// k8s.io/client-go/tools/leaderelection/leaderelection.go
// acquire loops calling tryAcquireOrRenew and returns true immediately when tryAcquireOrRenew succeeds.
// Returns false if ctx signals done.
func (le *LeaderElector) acquire(ctx context.Context) bool {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	succeeded := false
	desc := le.config.Lock.Describe()
    klog.Infof("attempting to acquire leader lease  %v...", desc)
    // 调用 JitterUntil 函数，以 RetryPeriod 为间隔去刷新资源锁，直到获取锁
	wait.JitterUntil(func() {
        // tryAcquireOrRenew 方法去调度资源更新接口，判断是否刷新成功
		succeeded = le.tryAcquireOrRenew()
		le.maybeReportTransition()
		if !succeeded {
			klog.V(4).Infof("failed to acquire lease %v", desc)
			return
		}
		le.config.Lock.RecordEvent("became leader")
		le.metrics.leaderOn(le.config.Name)
		klog.Infof("successfully acquired lease %v", desc)
		cancel()
	}, le.config.RetryPeriod, JitterFactor, true, ctx.Done())
	return succeeded
}
```

renew 方法，只有在获取锁之后才会调用，它会通过持续更新资源锁的数据，来确保继续持有已获得的锁，保持自己的 leader 状态。

```go
// renew loops calling tryAcquireOrRenew and returns immediately when tryAcquireOrRenew fails or ctx signals done.
func (le *LeaderElector) renew(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	wait.Until(func() {
		timeoutCtx, timeoutCancel := context.WithTimeout(ctx, le.config.RenewDeadline)
        defer timeoutCancel()
        //
		err := wait.PollImmediateUntil(le.config.RetryPeriod, func() (bool, error) {
			done := make(chan bool, 1)
			go func() {
				defer close(done)
				done <- le.tryAcquireOrRenew()
			}()
            // 超时返回error, 否则返回更新结果
			select {
			case <-timeoutCtx.Done():
				return false, fmt.Errorf("failed to tryAcquireOrRenew %s", timeoutCtx.Err())
			case result := <-done:
				return result, nil
			}
		}, timeoutCtx.Done())

		le.maybeReportTransition()
		desc := le.config.Lock.Describe()
		if err == nil {
			klog.V(5).Infof("successfully renewed lease %v", desc)
			return
		}
		le.config.Lock.RecordEvent("stopped leading")
		le.metrics.leaderOff(le.config.Name)
		klog.Infof("failed to renew lease %v: %v", desc, err)
		cancel()
	}, le.config.RetryPeriod, ctx.Done())

	// if we hold the lease, give it up
	if le.config.ReleaseOnCancel {
		le.release()
	}
}
```

这里使用了 wait 包，`wait.Until`会不断的调用`wait.PollImmediateUntil`方法，前者是进行无限循环操作，直到 `stop chan`被关闭，`wait.PollImmediateUntil`则不断的对某一条件进行检查，以`RetryPeriod`为间隔，直到该条件返回 true、error 或者超时。这一条件是一个需要满足 func() (bool, error) 签名的方法，比如这个例子只是调用了 `le.tryAcquireOrRenew()`。

最后看下`tryAcquireOrRenew`方法：

```go
// tryAcquireOrRenew tries to acquire a leader lease if it is not already acquired,
// else it tries to renew the lease if it has already been acquired. Returns true
// on success else returns false.
func (le *LeaderElector) tryAcquireOrRenew() bool {
    now := metav1.Now()
    // 这个 leaderElectionRecord 就是保存在 endpoint/configmap 的 annotation 中的值。
    // 每个节点都将 HolderIdentity 设置为自己，以及关于获取和更新锁的时间。后面会对时间进行修正，才会更新到 API server
	leaderElectionRecord := rl.LeaderElectionRecord{
		HolderIdentity:       le.config.Lock.Identity(),
		LeaseDurationSeconds: int(le.config.LeaseDuration / time.Second),
		RenewTime:            now,
		AcquireTime:          now,
	}

	// 1. 获取或者创建 ElectionRecord
	oldLeaderElectionRecord, oldLeaderElectionRawRecord, err := le.config.Lock.Get()
	if err != nil {
        // 记录不存在的话，则创建一条新的记录
		if !errors.IsNotFound(err) {
			klog.Errorf("error retrieving resource lock %v: %v", le.config.Lock.Describe(), err)
			return false
		}
		if err = le.config.Lock.Create(leaderElectionRecord); err != nil {
			klog.Errorf("error initially creating leader election record: %v", err)
			return false
        }
        // 创建记录成功，同时表示获得了锁，返回true
		le.observedRecord = leaderElectionRecord
		le.observedTime = le.clock.Now()
		return true
	}

	// 2. 正常获取了锁资源的记录，检查锁持有者和更新时间。
	if !bytes.Equal(le.observedRawRecord, oldLeaderElectionRawRecord) {
        // 记录之前的锁持有者
		le.observedRecord = *oldLeaderElectionRecord
		le.observedRawRecord = oldLeaderElectionRawRecord
		le.observedTime = le.clock.Now()
    }
    // 在满足以下所有的条件下，认为锁由他人持有，并且还没有过期，返回 false
    // a. 当前锁持有者的并非自己
    // b. 上一次观察时间 + 观测检查间隔大于现在时间，即距离上次观测的间隔，小于 `LeaseDuration` 的设置值。
	if len(oldLeaderElectionRecord.HolderIdentity) > 0 &&
		le.observedTime.Add(le.config.LeaseDuration).After(now.Time) &&
		!le.IsLeader() {
		klog.V(4).Infof("lock is held by %v and has not yet expired", oldLeaderElectionRecord.HolderIdentity)
		return false
	}

	// 3. 更新资源的资源锁
	if le.IsLeader() {
		leaderElectionRecord.AcquireTime = oldLeaderElectionRecord.AcquireTime
		leaderElectionRecord.LeaderTransitions = oldLeaderElectionRecord.LeaderTransitions
	} else {
		leaderElectionRecord.LeaderTransitions = oldLeaderElectionRecord.LeaderTransitions + 1
	}

	// 调用资源锁更新接口
	if err = le.config.Lock.Update(leaderElectionRecord); err != nil {
		klog.Errorf("Failed to update lock: %v", err)
		return false
	}

	le.observedRecord = leaderElectionRecord
	le.observedTime = le.clock.Now()
	return true
}

```

## 总结

当应用在 k8s 上部署时，使用 k8s 的资源锁，可方便的实现高可用，但需要注意以下几点：

- 推荐使用`configmap`作为资源锁，原因是某些组件如`kube-proxy`会去监听`endpoints`来更新节点 iptables 规则，当有大量资源锁时，势必会对性能有影响。
- 当选举结束时调用`OnStoppedLeading`需要**退出程序**(例如`os.Exit(0)`)，若不退出程序，所有副本选举结束不会去竞争资源锁，就没有 leader，造成服务不可用而这时程序并没有异常。需要执行退出逻辑，让 Daemon 程序 k8s/systemd 等重启服务来重新参与选主。
