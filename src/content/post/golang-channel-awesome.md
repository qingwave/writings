---
title: 'Golang Channel 妙用'
date: 2022-02-23T09:13:24Z
draft: false
tags: [golang]
categories: [code]
---

Golang 中通过我们使用 Channel 来传递信息、信号，经典的如生产者消费者、退出信号等, 那么除此之外 Channel 还有哪些不常见的用法。

<!--more-->

## 限制并发数

Golang 原生提供了强大的并发原语，但如果无节制的使用大量 Goroutine，并发过大会造成资源浪费，严重时会导致程序崩溃。使用带缓冲区的 Channel 可以解决此类问题。

在 Golang 的[godoc/gatevfs](https://github.com/golang/tools/blob/master/godoc/vfs/gatefs/gatefs.go)中实现了对最大虚拟文件的并发限制。

```go
// New returns a new FileSystem that delegates to fs.
// If gateCh is non-nil and buffered, it's used as a gate
// to limit concurrency on calls to fs.
func New(fs vfs.FileSystem, gateCh chan bool) vfs.FileSystem {
	if cap(gateCh) == 0 {
		return fs
	}
	return gatefs{fs, gate(gateCh)}
}

type gate chan bool

func (g gate) enter() { g <- true }
func (g gate) leave() { <-g }
```

通过带缓存的 Channel，每次打开文件时调用`enter`发生数据到 Channel，当文件关闭时调用`leave`读取 Channel 数据，当前 Channel 满后再次读取变会阻塞，直到有资源被释放，从而达到限制并发数的目的。

```go
func (fs gatefs) Open(p string) (vfs.ReadSeekCloser, error) {
	fs.enter()
	defer fs.leave()
	rsc, err := fs.fs.Open(p)
	if err != nil {
		return nil, err
	}
	return gatef{rsc, fs.gate}, nil
}
```

可以配合 WaitGroup 来实现最大并发数的控制，具体代码如下:

```go
// control number
type Gocontrol struct {
	ch chan struct{}
	wg sync.WaitGroup
}

func NewGocontrol(number int) *Gocontrol {
	return &Gocontrol{
		ch: make(chan struct{}, number),
	}
}

func (g *Gocontrol) Enter() {
	g.ch <- struct{}{}
}

func (g *Gocontrol) Leave() {
	<-g.ch
}

func (g *Gocontrol) Run(f func()) {
	g.Enter()
	g.wg.Add(1)

	go func() {
		defer g.Leave()
		defer g.wg.Done()
		f()
	}()
}

func (g *Gocontrol) Wait() {
	g.wg.Wait()
}
```

测试运行，创建 100 个任务，调用`Gocontrol`限制最大并发为 10，运行`runtime.NumGoroutine`来获取当前 Goroutine 数

```go
func RunGocontrol() {
	go func() {
		for {
			fmt.Printf("goroutine numbers: %v\n", runtime.NumGoroutine())
			time.Sleep(500 * time.Millisecond)
		}
	}()

	gctl := NewGocontrol(10)

	start := time.Now()
	for i := 0; i < 100; i++ {
		n := i
		gctl.Run(func() {
			time.Sleep(1 * time.Second)
            fmt.Println("hello", n)
		})
	}

	gctl.Wait()

	dur := time.Since(start)
	fmt.Printf("run time: %v", dur)
}
```

运行结果显示，最大 Goroutine 数为 12（包含 1 个主线程，1 个监控线程，10 个任务线程），符合预期

```bash
goroutine numbers: 12
run time: 10.002604769s
```

## 实现锁

除了调用 sync 包，使用 Channel 也可以实现锁，以互斥锁为例：

```go
type ChLock chan struct{}

func NewChLock() ChLock {
	return make(chan struct{}, 1)
}

func (l ChLock) Lock() {
	l <- struct{}{}
}

func (l ChLock) Unlock() {
	<-l
}
```

互斥锁通过容量为 1 的 Channel 实现互斥，同样借助多个 Channel 可以使用读写锁，通过关闭 Channel 可以实现类型 Once 的功能。

从源码层面分析，Channel 其实是一个线程安全的环形队列，Channel 定义在[runtime/chan.go](https://github.com/golang/go/blob/master/src/runtime/chan.go)中：

```go
type hchan struct {
	qcount   uint           // total data in the queue
	dataqsiz uint           // size of the circular queue
	buf      unsafe.Pointer // points to an array of dataqsiz elements
	elemsize uint16
	closed   uint32
	elemtype *_type // element type
	sendx    uint   // send index
	recvx    uint   // receive index
	recvq    waitq  // list of recv waiters
	sendq    waitq  // list of send waiters

	lock mutex
}
```

其中包含了`lock`锁结构，这里的`mutex`不同于`sync.Mutex`，只在 Runtime 内部使用是一种低阶的同步原语，也没有提供 Lock/Unlock 方法，只能通过全局的 lock/unlock/initlock 等函数调用。

## 最后

本文介绍了一些 Channel 的妙用，限制并发数与实现锁等，通过示例及源码阐述其深层次的原因。

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
