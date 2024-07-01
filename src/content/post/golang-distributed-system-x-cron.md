---
title: 'Golang分布式应用之定时任务'
date: 2022-07-28T16:07:56Z
draft: false
image: /img/blog/cron-heap.png
tags: ['golang', '分布式']
categories: ['code']
---

在系统开发中，有一类任务不是立即执行，而是在未来某个时间点或者按照一定间隔去执行，比如日志定期压缩、报表制作、过期数据清理等，这就是定时任务。

在单机中，定时任务通常需要实现一个类似 crontab 的系统，一般有两种方式：

1. 最小堆，按照任务执行时间建堆，每次取最近的任务执行
2. 时间轮，将任务放到时间轮列表中，每次转动取对应的任务列表执行

## 最小堆

最小堆是一种特殊的完全二叉树，任意非叶子节点的值不大于其子节点，如图

![min-heap](/img/blog/cron-heap.png)

通过最小堆，根据任务最近执行时间键堆，每次取堆顶元素即最近需要执行的任务，设置 timer 定时器，到期后触发任务执行。由于堆的特性每次调整的时间复杂度为 O(lgN)，相较于普通队列性能更快。

在`container/heap`中已经实现操作堆的相关函数，我们只需要实现定期任务核心逻辑即可。

```go
// 运行
func (c *Cron) Run() error {
    // 设置cron已启动，atomic.Bool来保证并发安全
	c.started.Store(true)
    // 主循环
	for {
        // 如果停止则退出
		if !c.started.Load() {
			break
		}
		c.runTask()
	}
	return nil
}

// 核心逻辑
func (c *Cron) runTask() {
	now := time.Now()
	duration := infTime
	// 获取堆顶元素
	task, ok := c.tasks.Peek()
	if ok {
		// 如果已删除则弹出
		if !c.set.Has(task.Name()) {
			c.tasks.Pop()
			return
		}
		// 计算于当前时间查找，设置定时器
		if task.next.After(now) {
			duration = task.next.Sub(now)
		} else {
			duration = 0
		}
	}

	timer := time.NewTimer(duration)
	defer timer.Stop()
	// 当有新元素插入直接返回，防止新元素执行时间小于当前堆顶元素
	select {
	case <-c.new:
		return
	case <-timer.C:
	}

	// 弹出任务，执行
	go task.Exec()

	// 计算下次执行时间，如果为0说明任务已结束，否则重新入堆
	task.next = task.Next(time.Now())
	if task.next.IsZero() {
		c.set.Delete(task.Name())
	} else {
		c.tasks.Push(task)
	}
}
```

主要逻辑可总结为:

1. 将任务按照下次执行时间建最小堆
2. 每次取堆顶任务，设置定时器
3. 如果中间有新加入任务，转入步骤 2
4. 定时器到期后执行任务
5. 再次取下个任务，转入步骤 2，依次执行

## 时间轮

另一种实现 Cron 的方式是时间轮，时间轮通过一个环形队列，每个插槽放入需要到期执行的任务，按照固定间隔转动时间轮，取插槽中任务列表执行，如图所示:

![min-heap](/img/blog/cron-timewheel.png)

时间轮可看作一个表盘，如图中时间间隔为 1 秒，总共 60 个格子，如果任务在 3 秒后执行则放为插槽 3，每秒转动次取插槽上所有任务执行。

如果执行时间超过最大插槽，比如有个任务需要 63 秒后执行（超过了最大格子刻度），一般可以通过多层时间轮，或者设置一个额外变量圈数，只执行圈数为 0 的任务。

时间轮插入的时间复杂度为 O(1)，获取任务列表复杂度为 O(1)，执行列表最差为 O(n)。对比最小堆，时间轮插入删除元素更快。

核心代码如下:

```go
// 定义
type TimeWheel struct {
	interval    time.Duration // 触发间隔
	slots       int // 总插槽数
	currentSlot int // 当前插槽数
	tasks       []*list.List // 环形列表，每个元素为对应插槽的任务列表
	set         containerx.Set[string] // 记录所有任务key值，用来检查任务是否被删除

	tricker *time.Ticker // 定时触发器

	logger logr.Logger
}

func (tw *TimeWheel) Run() error {
	tw.tricker = time.NewTicker(tw.interval)
	for {
		// 通过定时器模拟时间轮转动
		now, ok := <-tw.tricker.C
		if !ok {
			break
		}
		// 转动一次，执行任务列表
		tw.RunTask(now, tw.currentSlot)
		tw.currentSlot = (tw.currentSlot + 1) % tw.slots
	}
	return nil
}

func (tw *TimeWheel) RunTask(now time.Time, slot int) {
	// 一次执行任务列表
	for item := taskList.Front(); item != nil; {
		task, ok := item.Value.(*TimeWheelTask)
		// 任务圈数大于0，不需要执行，将圈数减一
		if task.circle > 0 {
			task.circle--
			item = item.Next()
			continue
		}

		// 运行任务
		go task.Exec()

		// 计算任务下次运行时间
		next := item.Next()
		taskList.Remove(item)
		item = next

		task.next = task.Next(now)
		if !task.next.IsZero() {
			tw.add(now, task)
		} else {
			tw.Remove(task.Name())
		}
	}
}

// 添加任务，计算下一次任务执行的插槽与圈数
func (tw *TimeWheel) add(now time.Time, task *TimeWheelTask) {
	if !task.initialized {
		task.next = task.Next(now)
		task.initialized = true
	}

	duration := task.next.Sub(now)
	if duration <= 0 {
		task.slot = tw.currentSlot + 1
		task.circle = 0
	} else {
		mult := int(duration / tw.interval)
		task.slot = (tw.currentSlot + mult) % tw.slots
		task.circle = mult / tw.slots
	}

	tw.tasks[task.slot].PushBack(task)
	tw.set.Insert(task.Name())
}
```

时间轮的主要逻辑如下：

1. 将任务存在对应插槽的时间
2. 通过定时间模拟时间轮转动
3. 每次到期后遍历当前插槽的任务列表，若任务圈数为 0 则执行
4. 如果任务未结束，计算下次执行的插槽与圈数
5. 转入步骤 2，依次执行

## 总结

本文主要总结了定时任务的两种实现方式，最小堆与时间轮，并分析其核心实现逻辑。

对于执行分布式定时任务，可以借助延时消息队列或者直接使用 Kubernetes 的 CronJob。

自己开发的话可以借助 Etcd：

- 中心节点 Coordinator 将任务按照一定算法(Hash、轮询、或者更复杂的分配算法)将任务与工作节点 Worker 绑定
- 每个 Worker 添加到有绑定到自己的任务则取出放到本地的 Cron 中
- 如果 Worker 挂掉，执行将其上任务重新绑定即可

本文所有代码见[https://github.com/qingwave/gocorex/tree/main/cron](https://github.com/qingwave/gocorex/tree/main/cron)

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
