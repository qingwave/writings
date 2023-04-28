---
title: 'Golang实现一个事务型内存数据库'
date: 2023-03-01T08:01:22Z
draft: false
description: "MossDB的实现细节"
image: ~/assets/images/do-more.jpg
tags: ['golang', 'database', 'etcd']
categories: ['code']
---

内存数据库经我们经常用到，例如 Redis，那么如何从零实现一个内存数据库呢，本文旨在介绍如何使用 Golang 编写一个 KV 内存数据库[MossDB](https://github.com/qingwave/mossdb)。

## 特性

MossDB 是一个纯 Golang 编写、可嵌入的、键值型内存数据库，包含以下特性

- 可持久化，类似 Redis AOF(Append only Log)
- 支持事务
- 支持近实时的 TTL(Time to Live), 可以实现毫秒级的过期删除
- 前缀搜索
- Watch 接口，可以监听某个键值的内容变化，类似 etcd 的 Watch
- 多后端存储，目前支持 HashMap 和 RadixTree

## 命名由来

`Moss`有苔、苔花的含义，MossDB 的名字来源于清代袁牧的一句诗:

> 苔花如米小，也学牡丹开

MossDB 虽小，但五脏俱全，也支持了很多重要功能。另外，巧合的是《流浪地球 2》中的超级计算机 550W 名字就是 Moss。

## 架构

内存数据库虽然使用简单，实现起来却有很多细节，Golang 目前也存在不少优秀的开源内存数据库，比如[buntdb](https://github.com/tidwall/buntdb)、[go-memdb](https://github.com/hashicorp/go-memdb)，在编写 MossDB 过程中也借鉴了一些它们的特性。

MossDB 的架构如图：
![MossDB](https://github.com/qingwave/mossdb/raw/main/doc/mossdb.png)

自上往下分为：

1. 接口层，提供 API 接受用户请求
2. 核心层，实现事务、过期删除、Watch 等功能
3. 存储层，提供 KV 的后端存储以及增删改查
4. 持久化层，使用 AOL 持久化即每次修改操作都会持久化到磁盘 Log 中

### 快速开始

MossDB 可嵌入到 Go 程序中，可以通过`go get`获取

```bash
go get github.com/qingwave/mossdb
```

MossDB 提供了易用的 API，可以方便地进行数据处理，下面的示例代码展示了如何使用 MossDB：

```go
package main

import (
	"log"

	"github.com/qingwave/mossdb"
)

func main() {
    // create db instance
	db, err := mossdb.New(&mossdb.Config{})
	if err != nil {
		log.Fatal(err)
	}

    // set, get data
	db.Set("key1", []byte("val1"))
    log.Printf("get key1: %s", db.Get("key1"))

    // transaction
    db.Tx(func(tx *mossdb.Tx) error {
        val1 := tx.Get("key1")

        tx.Set("key2", val1)

        return nil
    })
}
```

更多示例见[源码](https://github.com/qingwave/mossdb)

## 具体实现

从下往上分别介绍下 MossDB 如何设计与实现，以及相关的细节。

### AOF 持久化

AOF 源于 Redis 提供两种持久化技术，另外一种是 RDB，AOF 是指在每次写操作后，将该操作序列化后追加到文件中，重启时重放文件中的对应操作，从而达到持久化的目的。其实现简单，用在 MossDB 是一个不错的选择，但需要注意的是 AOF 缺点同样明显，如果文件较大，每次重启会花费较多时间。

Redis 的 AOF 是一种后写式日志，先写内存直接返回给用户，再写磁盘文件持久化，可以保证其高性能，但如果中途宕机会丢失数据。MossDB 中的 AOF 采用了 WAL(预写式日志)实现，先写 Log 再写内存，用来保证数据不会丢失，从而可以进一步实现事务。

那么采用 WAL 会不会影响其性能？每次必须等到落盘后才进行其他操作，WAL 的每次写入会先写到内核缓冲区，这个调用很快就返回了，内核再将数据落盘。我们也可以使用`fsync`调用强制内核执行直接将数据写入磁盘。在 MossDB 中普通写操作之会不会直接调用`fsync`，事务写中强制开启`fsync`，从而平衡数据一致性与性能。

WAL 的实现引用了[tiwall/wal](https://github.com/tidwall/wal)，其中封装了对 Log 文件的操作，可以支持批量写入。由于 WAL 是二进制的，必须将数据进行编码，通过`varint`编码实现，将数据长度插入到数据本体之前，读取时可以读取定长的数据长度，然后按长度读取数据本体。MossDB 中数据格式如下：

```go
type Record struct {
	Op        uint16
	KeySize   uint32
	ValSize   uint32
	Timestamp uint64
	TTL       uint64
	Key       []byte
	Val       []byte
}
```

对应编码后的二进制格式为:

```
|------------------------------------------------------------|
| Op | KeySize | ValSize | Timestamp | TTL | Key    | Val    |
|------------------------------------------------------------|
| 2  | 4       | 4       | 8         | 8   | []byte | []byte |
|------------------------------------------------------------|
```

使用`binary.BigEndian.PutUint16`进行编码，解码时通过`binary.BigEndian.Uint16`，从而依次取得生成完整的数据。

### 存储引擎

MossDB 提供了存储接口，只要实现了此接口都可以作为其后端存储

```go
type Store interface {
	Get(key string) ([]byte, bool)
	Set(key string, val []byte)
	Delete(key string)
	Prefix(key string) map[string][]byte
	Dump() map[string][]byte

	Len() int
}
```

内置提供了 HashMap 与 RadixTree 两种方式，HashMap 实现简单通过简单封装`map`可以快速进行查询与插入，但范围搜索性能差。RadixTree 即前缀树，查询插入的时间复杂度只与 Key 的长度相关，而且支持范围搜索，MossDB 采用[Adaptive Radix Tree](https://github.com/arriqaaq/art)可以避免原生的前准树空间浪费。

由于 RadixTree 的特性，MossDB 可以方便的进行前缀搜索，目前支持`List`与`Watch`操作。

### 事务实现

要实现事务必须要保证其 ACID 特性，MossDB 的事务定义如下：

```go
type Tx struct {
	db      *DB // DB实例
	commits []*Record // 对于写操作生成 Record, 用来做持久化
	undos   []*Record // 对于写操作生成 Undo Record，用于回滚
}
```

MossDB 中一次事务的流程主要包含以下几个步骤：

1. 首先加锁，保证其数据一致性
2. 对于写操作，生成 Commits 和 Undo Records，然后写入内存；读操作则直接执行
3. 提交阶段，将 Commits 持久化到 WAL 中；若写入失败，则删除已写入数据；成功则设置数据的其他属性(TTL, Watch 等)
4. 若中间发生错误，执行回滚操作，将 Undo Records 的记录执行
5. 事务完成，释放锁

### Watch

由于工作中经常使用 Kubernetes，对于其 Watch 接口印象深刻，通过 Watch 来充当其事件总线，保证其声明式对象的管理。Kubernetes 的 Watch 底层由 etcd 实现，MossDB 也实现了类似的功能。

Watch 的定义如下：

```go
type Watcher struct {
	mu       sync.RWMutex // 锁
	watchers map[string]*SubWatcher // watchId与具体Watcher直接的映射
	keys     map[string]containerx.Set[string] // Watch单个key
	ranges   *art.Tree // 前缀Watch
	queue    workqueue.WorkQueue // 工作队列，存放所有事件
	stop     chan struct{} // 是否中止
}
```

通过[工作队列](https://github.com/qingwave/gocorex/blob/main/syncx/workqueue/workqueue.go)模式，任何写操作都会同步追加到队列中，如果存在单个 key 的监听者，则通过`watchers` map 获取到对应列表，依次发送事件。对于前缀 Watch，我们不可能记录此前缀的所有 Key，这里借鉴了 etcd，通过 RadixTree 保存`前缀Key`，当有新事件时，匹配 Key 所在的路径，如果有监听者，则进行事件通知。

调用 Watch 会返回一个 Channel，用户只需要监听 Channel 即可

```go
func Watch(db *mossdb.DB) {
	key := "watch-key"

	ctx, cancel := context.WithTimeout(context.Background(), 1000*time.Millisecond)
	defer cancel()

	// start watch key
	ch := db.Watch(ctx, key)
	log.Printf("start watch key %s", key)

	go func() { // 模拟发送event
		db.Set(key, mossdb.Val("val1"))
		db.Set(key, mossdb.Val("val2"))
		db.Delete(key)

		time.Sleep(100 * time.Second)

		db.Set(key, mossdb.Val("val3"))
	}()

	for {
		select {
		case <-ctx.Done():
			log.Printf("context done")
			return
		case resp, ok := <-ch:
			if !ok {
				log.Printf("watch done")
				return
			}
			log.Printf("receive event: %s, key: %s, new val: %s", resp.Event.Op, resp.Event.Key, resp.Event.Val)
		}
	}

    // Output
    // 2023/02/23 09:48:50 start watch key watch-key
	// 2023/02/23 09:34:19 receive event: MODIFY, key: watch-key, new val: val1
	// 2023/02/23 09:34:19 receive event: MODIFY, key: watch-key, new val: val2
	// 2023/02/23 09:34:19 receive event: DELETE, key: watch-key, new val:
	// 2023/02/23 09:34:19 context done
}

```

### TTL

过期删除再很多场景很有用，比如验证码过期、订单未支付关闭等。MossDB 采用时间堆来实现精确的 Key 过期策略，具体原理可以参考之前的文章[Golang 分布式应用之定时任务](/golang-distributed-system-x-cron)，在查询操作时也会检查 Key 是否过期，如果过期则直接返回空数据。配合 Watch 操作可以精确管理数据的生命周期。

## 总结

至此，MossDB 的实现细节已经分析完成，支持了事务、持久化、Watch 与过期删除等特性，后续可能会支持 HTTP API、存储快照等功能。

所有代码见[https://github.com/qingwave/mossdb](https://github.com/qingwave/mossdb)，欢迎批评指正以及 Star。

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
