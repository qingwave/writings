---
title: 'Golang分布式应用之Redis'
date: 2022-07-22T18:07:56Z
draft: false
tags: ['redis', 'golang', '分布式']
categories: ['code']
---

Redis 是一个高性能的内存数据库，常被应用于分布式系统中，除了作为分布式缓存或简单的内存数据库还有一些特殊的应用场景，本文结合 Golang 来编写对应的中间件。

本文所有代码见[https://github.com/qingwave/gocorex](https://github.com/qingwave/gocorex)

## 分布式锁

单机系统中我们可以使用`sync.Mutex`来保护临界资源，在分布式系统中同样有这样的需求，当多个主机抢占同一个资源，需要加对应的“分布式锁”。

在 Redis 中我们可以通过`setnx`命令来实现

1. 如果 key 不存在可以设置对应的值，设置成功则加锁成功，key 不存在返回失败
2. 释放锁可以通过`del`实现。

主要逻辑如下：

```go
type RedisLock struct {
	client     *redis.Client
	key        string
	expiration time.Duration // 过期时间，防止宕机或者异常
}

func NewLock(client *redis.Client, key string, expiration time.Duration) *RedisLock {
	return &RedisLock{
		client:     client,
		key:        key,
		expiration: expiration,
	}
}

// 加锁将成功会将调用者id保存到redis中
func (l *RedisLock) Lock(id string) (bool, error) {
	return l.client.SetNX(context.TODO(), l.key, id, l.expiration).Result()
}

const unLockScript = `
if (redis.call("get", KEYS[1]) == KEYS[2]) then
	redis.call("del", KEYS[1])
	return true
end
return false
`

// 解锁通过lua脚本来保证原子性，只能解锁当前调用者加的锁
func (l *RedisLock) UnLock(id string) error {
	_, err := l.client.Eval(context.TODO(), unLockScript, []string{l.key, id}).Result()
	if err != nil && err != redis.Nil {
		return err
	}

	return nil
}
```

需要加一个额外的超时时间来防止系统宕机或者异常请求造成的死锁，通过超时时间为最大预估运行时间的 2 倍。

解锁时通过 lua 脚本来保证原子性，调用者只会解自己加的锁。避免由于超时造成的混乱，例如：进程 A 在时间 t1 获取了锁，但由于执行缓慢，在时间 t2 锁超时失效，进程 B 在 t3 获取了锁，这是如果进程 A 执行完去解锁会取消进程 B 的锁。

运行测试

```go
func main() {
    client := redis.NewClient(&redis.Options{
		Addr:     "localhost:6379",
		Password: "123456",
		DB:       0, // use default DB
	})

	lock := NewLock(client, "counter", 30*time.Second)

    counter := 0
	worker := func(i int) {
		for {
			id := fmt.Sprintf("worker%d", i)
			ok, err := lock.Lock(id)
			log.Printf("worker %d attempt to obtain lock, ok: %v, err: %v", i, ok, err)
			if !ok {
				time.Sleep(100 * time.Millisecond)
				continue
			}

			defer lock.UnLock(id)
			counter++
			log.Printf("worker %d, add counter %d", i, counter)
			break
		}
	}

	wg := sync.WaitGroup{}
	for i := 1; i <= 5; i++ {
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

运行结果，可以看到与`sync.Mutex`使用效果类似

```bash
2022/07/22 09:58:09 worker 5 attempt to obtain lock, ok: true, err: <nil>
2022/07/22 09:58:09 worker 5, add counter 1
2022/07/22 09:58:09 worker 4 attempt to obtain lock, ok: false, err: <nil>
2022/07/22 09:58:09 worker 1 attempt to obtain lock, ok: false, err: <nil>
2022/07/22 09:58:09 worker 2 attempt to obtain lock, ok: false, err: <nil>
2022/07/22 09:58:09 worker 3 attempt to obtain lock, ok: false, err: <nil>
2022/07/22 09:58:10 worker 3 attempt to obtain lock, ok: false, err: <nil>
2022/07/22 09:58:10 worker 1 attempt to obtain lock, ok: false, err: <nil>
2022/07/22 09:58:10 worker 2 attempt to obtain lock, ok: false, err: <nil>
2022/07/22 09:58:10 worker 4 attempt to obtain lock, ok: true, err: <nil>
2022/07/22 09:58:10 worker 4, add counter 2
2022/07/22 09:58:10 worker 1 attempt to obtain lock, ok: true, err: <nil>
2022/07/22 09:58:10 worker 1, add counter 3
2022/07/22 09:58:10 worker 3 attempt to obtain lock, ok: false, err: <nil>
2022/07/22 09:58:10 worker 2 attempt to obtain lock, ok: false, err: <nil>
2022/07/22 09:58:10 worker 2 attempt to obtain lock, ok: true, err: <nil>
2022/07/22 09:58:10 worker 2, add counter 4
2022/07/22 09:58:10 worker 3 attempt to obtain lock, ok: false, err: <nil>
2022/07/22 09:58:10 worker 3 attempt to obtain lock, ok: true, err: <nil>
2022/07/22 09:58:10 worker 3, add counter 5
```

> 特别注意的是，在分布式 Redis 集群中，如果发生异常时(主节点宕机)，可能会降低分布式锁的可用性，可以通过强一致性的组件 etcd、ZooKeeper 等实现。

## 分布式过滤器

假设要开发一个爬虫服务，爬取百万级的网页，怎么判断某一个网页是否爬取过，除了借助数据库和 HashMap，我们可以借助布隆过滤器来做。相比其他方式布隆过滤器占用极低的空间，而且插入查询时间非常快。

布隆过滤器用来判断某个元素是否在集合中，利用 BitSet

- 插入数据时将值进行多次 Hash，将 BitSet 对应位置 1
- 查询时同样进行多次 Hash 对比所有位上是否为 1，如是则存在。

> 布隆过滤器有一定的误判率，不适合精确查询的场景。另外也不支持删除元素。通常适用于 URL 去重、垃圾邮件过滤、防止缓存击穿等场景中。

在 Redis 中，我们可以使用自带的 BitSet 实现，同样也借助 lua 脚本的原子性来避免多次查询数据不一致。

```go
const (
	// 插入数据，调用setbit设置对应位
	setScript = `
for _, offset in ipairs(ARGV) do
	redis.call("setbit", KEYS[1], offset, 1)
end
`
	// 查询数据，如果所有位都为1返回true
	getScript = `
for _, offset in ipairs(ARGV) do
	if tonumber(redis.call("getbit", KEYS[1], offset)) == 0 then
		return false
	end
end
return true
`
)

type BloomFilter struct {
	client *redis.Client
	key    string // 存在redis中的key
	bits   uint // BitSet的大小
	maps   uint // Hash的次数
}

func NewBloomFilter(client *redis.Client, key string, bits, maps uint) *BloomFilter {
	client.Del(context.TODO(), key)

	if maps == 0 {
		maps = 14
	}

	return &BloomFilter{
		key:    key,
		client: client,
		bits:   bits,
		maps:   maps,
	}
}

// 进行多次Hash, 得到位置列表
func (f *BloomFilter) getLocations(data []byte) []uint {
	locations := make([]uint, f.maps)
	for i := 0; i < int(f.maps); i++ {
		val := murmur3.Sum64(append(data, byte(i)))
		locations[i] = uint(val) % f.bits
	}
	return locations
}

func (f *BloomFilter) Add(data []byte) error {
	args := getArgs(f.getLocations(data))
	_, err := f.client.Eval(context.TODO(), setScript, []string{f.key}, args).Result()
	if err != nil && err != redis.Nil {
		return err
	}
	return nil
}

func (f *BloomFilter) Exists(data []byte) (bool, error) {
	args := getArgs(f.getLocations(data))
	resp, err := f.client.Eval(context.TODO(), getScript, []string{f.key}, args).Result()
	if err != nil {
		if err == redis.Nil {
			return false, nil
		}
		return false, err
	}

	exists, ok := resp.(int64)
	if !ok {
		return false, nil
	}

	return exists == 1, nil
}

func getArgs(locations []uint) []string {
	args := make([]string, 0)
	for _, l := range locations {
		args = append(args, strconv.FormatUint(uint64(l), 10))
	}
	return args
}
```

运行测试

```go
func main() {
	bf := NewBloomFilter(client,"bf-test", 2^16, 14)

	exists, err := bf.Exists([]byte("test1"))
	log.Printf("exist %t, err %v", exists, err)

	if err := bf.Add([]byte("test1")); err != nil {
		log.Printf("add err: %v", err)
	}

	exists, err = bf.Exists([]byte("test1"))
	log.Printf("exist %t, err %v", exists, err)

	exists, err = bf.Exists([]byte("test2"))
	log.Printf("exist %t, err %v", exists, err)
// output
// 2022/07/22 10:05:58 exist false, err <nil>
// 2022/07/22 10:05:58 exist true, err <nil>
// 2022/07/22 10:05:58 exist false, err <nil>
}
```

## 分布式限流器

在`golang.org/x/time/rate`包中提供了基于令牌桶的限流器，如果要实现分布式环境的限流可以基于 Redis Lua 脚本实现。

令牌桶的主要原理如下：

- 假设一个令牌桶容量为 burst，每秒按照 qps 的速率往里面放置令牌
- 初始时放满令牌，令牌溢出则直接丢弃，请求令牌时，如果桶中有足够令牌则允许，否则拒绝
- 当 burst==qps 时，严格按照 qps 限流；当 burst>qps 时，可以允许一定的突增流量

这里主要参考了官方`rate`包的实现，将核心逻辑改为 Lua 实现。

```lua
--- 相关Key
--- limit rate key值，对应value为当前令牌数
local limit_key = KEYS[1]

--- 输入参数
--[[
qps: 每秒请求数;
burst: 令牌桶容量;
now: 当前Timestamp;
cost: 请求令牌数;
max_wait: 最大等待时间
--]]
local qps = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = ARGV[3]
local cost = tonumber(ARGV[4])
local max_wait = tonumber(ARGV[5])

--- 获取redis中的令牌数
local tokens = redis.call("hget", limit_key, "token")
if not tokens then
	tokens = burst
end

--- 上次修改时间
local last_time = redis.call("hget", limit_key, "last_time")
if not last_time then
	last_time = 0
end

--- 最新等待时间
local last_event = redis.call("hget", limit_key, "last_event")
if not last_event then
	last_event = 0
end

--- 通过当前时间与上次修改时间的差值，qps计算出当前时间得令牌数
local delta = math.max(0, now-last_time)
local new_tokens = math.min(burst, delta * qps + tokens)
new_tokens = new_tokens - cost --- 最新令牌数，减少请求令牌

--- 如果最新令牌数小于0，计算需要等待的时间
local wait_period = 0
if new_tokens < 0 and qps > 0 then
	wait_period = wait_period - new_tokens / qps
end
wait_period = math.ceil(wait_period)

local time_act = now + wait_period --- 满足等待间隔的时间戳

--- 允许请求有两种情况
--- 当请求令牌数小于burst, 等待时间不超过最大等待时间，可以通过补充令牌满足请求
--- qps为0时，只要最新令牌数不小于0即可
local ok = (cost <= burst and wait_period <= max_wait and qps > 0) or (qps == 0 and new_tokens >= 0)

--- 设置对应值
if ok then
	redis.call("set", limit_key, new_tokens)
	redis.call("set", last_time_key, now)
	redis.call("set", last_event_key, time_act)
end

--- 返回列表，{是否允许， 等待时间}
return {ok, wait_period}
```

在 Golang 中的相关接口 Allow、AllowN、Wait 等都是通过调用 reserveN 实现

```go
// 调用lua脚本
func (lim *RedisLimiter) reserveN(now time.Time, n int, maxFutureReserveSecond int) (*Reservation, error) {
	// ...

	res, err := lim.rdb.Eval(context.TODO(), reserveNScript, []string{lim.limitKey}, lim.qps, lim.burst, now.Unix(), n, maxFutureReserveSecond).Result()
	if err != nil && err != redis.Nil {
		return nil, err
	}
	//...
	return &Reservation{
		ok:        allow == 1,
		lim:       lim,
		tokens:    n,
		timeToAct: now.Add(time.Duration(wait) * time.Second),
	}, nil
}
```

运行测试

```go
func main() {
	rdb := redis.NewClient(&redis.Options{
		Addr:     "localhost:6379",
		Password: "123456",
		DB:       0, // use default DB
	})

	r, err := NewRedisLimiter(rdb, 1, 2, "testrate")
	if err != nil {
		log.Fatal(err)
	}
	r.Reset()

	for i := 0; i < 5; i++ {
		err := r.Wait(context.TODO())
		log.Printf("worker %d allowed: %v", i, err)
	}
}
// output
// 2022/07/22 12:50:31 worker 0 allowed: <nil>
// 2022/07/22 12:50:31 worker 1 allowed: <nil>
// 2022/07/22 12:50:32 worker 2 allowed: <nil>
// 2022/07/22 12:50:33 worker 3 allowed: <nil>
// 2022/07/22 12:50:34 worker 4 allowed: <nil>
```

前两个请求在 burst 内，直接可以获得，后面的请求按照 qps 的速率生成。

## 其他

除此之外，Redis 还可以用作全局计数、去重(set)、发布订阅等场景。Redis 官方也提供了一些通用模块，通过加载这些模块也可以实现过滤、限流等特性，参考[modules](https://redis.io/docs/modules/)。

本文所有代码见[https://github.com/qingwave/gocorex](https://github.com/qingwave/gocorex)，欢迎批评指正

## 参考

- https://github.com/qingwave/gocorex
- https://go-zero.dev/

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
