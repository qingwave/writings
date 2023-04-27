---
title: 'Golang优雅之道'
date: 2022-09-12T14:57:10+08:00
draft: false
tags: ['golang', '程序设计']
categories: ['code']
---

借助一些设计模式、流式编程、函数编程的方法可以让我们的 Golang 代码更清晰优雅，本文中描述了在错误处理、可选配置、并发控制等方面的优化手段。

## 链式错误处理

很多人不喜欢 Go 的错误处理，需要写大量`if err != nil`的代码，特别是在一些复杂步骤场景中，每一步都要判断结果是否出错。在这种情况中，可以通过类似链式调用将错误封装在其中。

比如在对象中附带一个 error 属性，在每一步调用中如果 error 不为空直接返回

```go
type Handler struct {
    props interface

    err error
}

func (h *Handler) Err() error {
    return h.err
}

func (h *Handler) Step1() *Handler {
    if h.err != nil {
        return h
    }

    // do something for step2
    return h
}

func (h *Handler) Step2() *Handler {
    if h.err != nil {
        return h
    }

    // do something fot step2
    return h
}

// ... StepN()
```

调用时直接通过链式调用即可，最后再判断错误

```go
h := &Handler{}
if err := h.Step1().Step2().StepN().Err(); err != nil {
    // handle error
}
```

这种方式在一些数据库包中有大量使用，比如`etcd`、`gorm`。

## 可选配置

在创建对象时，如果可配置的属性很多，通常会引入一个配置文件

```go
type Config struct {
    Port string
    Host string
    Timeout time.Time
    // ...
}

func NewServer(conf *Config) *Server {

}
```

通常这些配置都有默认值，config 也不是必须的，通过建造者模式可以轻松解决此类问题

```go
builder := &Builder{}
server := builder.WithPort("8080").WithHost("0.0.0.0").WithTimeOut(10*time.Second).Complete()
```

但建造者需要写一个建造类，配置对应的属性设置方法

```go
type Builder struct {
    server Server
}

func (b *Builder) WithPort(port string) *Builder {
    b.server.port = port
    return b
}

func (b *Builder) WithHost(host string) *Builder {
    b.server.host = host
    return b
}

```

除了建造者模式，还可以通过可选配置，对调用者更友好，将配置项封装成 Option，需要的时候注入对应的 Option 即可

```go
type Option func(*Server)

type WithPort(port int) Option {
    return func(s *Server) {
        s.port = port
    }
}

type WithHost(host int) Option {
    return func(s *Server) {
        s.host = host
    }
}

type NewServer(opts ...Option) *Server {
    s := defaultServer() // 默认配置
    for _, opt := range opts {
        opt(s) // 添加可选配置
    }
    return s
}
```

调用时，只需在 NewServer 配置对应的 Option 即可

```go
// 默认配置
s := NewServer()

// 可选配置
s := NewServer(WithPort("8080"), WithHost("127.0.0.1"))
```

可选配置相比直接使用配置和建造者模式，更加清晰，也非常容易扩展和维护，在 kuberentes、etcd 库中都有非常多的应用。

## 并发控制

Golang 基础库中已经提供不少并发控制工具，比如 Channel、WaitGroup、各种锁等等。

### ErrGroup

WaitGroup 可以等待多个 Goroutine 执行结束，但很多时候并发执行多个任务，如果其中一个任务出错那么整体失败，需要直接返回，这种情况下我们可以使用[ErrGroup](https://pkg.go.dev/golang.org/x/sync/errgroup)

ErrGroup 借助封装了 WaitGroup、Once 以及 Context，调用 Wait 时如果一个任务失败取消 Context 直接返回，核心逻辑如下

```go
type ErrGroup struct {
	ctx    context.Context
	cancel func()

	wg sync.WaitGroup

	errOnce sync.Once
	err     error
}

func (g *ErrGroup) Wait() error {
	g.wg.Wait()

	if g.cancel != nil {
		g.cancel()
	}

	return g.err
}

func (g *ErrGroup) Go(f func(ctx context.Context) error) {
	g.wg.Add(1)

	go func() {
		defer g.wg.Done()
		if err := f(g.ctx); err != nil {
            // 执行失败则运行cancel
			g.errOnce.Do(func() {
				g.err = err
				if g.cancel != nil {
					g.cancel()
				}
			})
		}
	}()
}
```

### 控制并发数

借助有缓冲的 Channel，可以实现控制 Goroutine 并发数，逻辑如下：

```go
func NewCtrlGroup(number int) *CtrlGroup {
	return &CtrlGroup{
		ch: make(chan struct{}, number),
	}
}

type CtrlGroup struct {
	ch chan struct{}
	wg sync.WaitGroup
}

func (g *CtrlGroup) Enter() {
	g.ch <- struct{}{}
}

func (g *CtrlGroup) Leave() {
	<-g.ch
}

func (g *CtrlGroup) Go(f func()) {
	g.Enter() // 接收到新任务，发送到Channel，如果Channel满需要等待
	g.wg.Add(1)

	go func() {
		defer g.Leave() // 任务结束，取出一个元素
		defer g.wg.Done()
		f()
	}()
}

func (g *CtrlGroup) Wait() {
	g.wg.Wait()
}
```

### MapReduce

除了 WaitGroup、ErrGroup 处理一些简单的并发任务，有时候我们需要执行类似 MapReduce 的操作，通过 Map 对数据源并行处理，然后通过 Reduce 合并结果。在 Java、Python 中提供了类似功能。

比如实现一个实现一组数据的平方和，利用 MapReduce 在 Golang 中实现如下：

```go
	num := 1000000

	res, err := mapreduce.New(mapreduce.WithWorkers(16)).
		From(func(r mapreduce.Writer) error { // 产生数据源
			for i := 1; i < num; i++ {
				r.Write(i)
			}
			return nil
		}).
		Map(func(item any) (any, error) { // 处理数据
			v, ok := item.(int)
			if !ok {
				return nil, fmt.Errorf("invaild type")
			}

			resp := v * v

			return resp, nil
		}).
		Reduce(func(r mapreduce.Reader) (any, error) { // 合并结果
			sum := 0
			for {
				item, ok := r.Read()
				if !ok {
					break
				}

				v, ok := item.(int)
				if !ok {
					return nil, fmt.Errorf("invaild type")
				}

				sum += v
			}
			return sum, nil
		}).
		Do()
```

主要逻辑是利用 Channel（或者线程安全的队列）将源数据发送到 Map 的执行 Worker 中，处理完后再转发到 Reduce Goroutine 中，通过 ErrGroup 等待所有 Worker 执行完成。源码见[mapreduce.go](https://github.com/qingwave/gocorex/tree/main/syncx/mapreduce/mapreduce.go)。

类似的也可以实现 Kubernetes 中 Controller 模式，通过队列或者 Channel 将生产者与消费者解耦，并行处理提高运行速度。

## 总结

本文总结了 Golang 的一些有趣的编程模式，例如链式调用、可选配置、并发控制等，通过这些技巧或者手段，可以提高编码的质量，所有代码见[gocorex](https://github.com/qingwave/gocorex)。

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
