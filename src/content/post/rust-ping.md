---
title: 'Rust初探: 实现一个Ping'
date: 2022-11-24T16:50:14+08:00
draft: false
description: 'Rust + Ping = Ring'
image: /img/blog/ring.jpg
tags: ['rust']
categories: ['code']
---

这两年 Rust 火的一塌糊涂，甚至都烧到了前端，再不学习怕是要落伍了。最近翻了翻文档，写了个简单的 Ping 应用练练手，被所有权折腾的够呛，相比起 Golang 上手难度大很多，现将开发中的一些问题总结如下，所有源码见[ring](https://github.com/qingwave/ring)。

## 目标

实现一个 Ping，功能包含：

- 命令行解析
- 实现 ICMP 协议，[pnet](https://docs.rs/pnet/latest/pnet/)包中已经包含了 ICMP 包定义，可以使用[socket2](https://docs.rs/socket2/latest/socket2/)库发送
- 周期性发送 Ping，通过多线程发送，再汇总结果
- 监听退出信号

### 命令行解析

系统库`std::env::args`可以解析命令行参数，但对于一些复杂的参数使用起来比较繁琐，更推荐[clap](https://docs.rs/crate/clap/latest)。利用 clap 的注解，通过结构体定义命令行参数

```rust
/// ping but with rust, rust + ping -> ring
#[derive(Parser, Debug, Clone)] // Parser生成clap命令行解析方法
#[command(author, version, about, long_about = None)]
pub struct Args {
    /// Count of ping times
    #[arg(short, default_value_t = 4)] // short表示开启短命名，默认为第一个字母，可以指定；default_value_t设置默认值
    count: u16,

    /// Ping packet size
    #[arg(short = 's', default_value_t = 64)]
    packet_size: usize,

    /// Ping ttl
    #[arg(short = 't', default_value_t = 64)]
    ttl: u32,

    /// Ping timeout seconds
    #[arg(short = 'w', default_value_t = 1)]
    timeout: u64,

    /// Ping interval duration milliseconds
    #[arg(short = 'i', default_value_t = 1000)]
    interval: u64,

    /// Ping destination, ip or domain
    #[arg(value_parser=Address::parse)] // 自定义解析
    destination: Address,
}
```

clap 可以方便的指定参数命名、默认值、解析方法等，运行结果如下

```bash
➜  ring git:(main) cargo run -- -h
   Compiling ring v0.1.0 (/home/i551329/work/ring)
    Finished dev [unoptimized + debuginfo] target(s) in 1.72s
     Running `target/debug/ring -h`
ping but with rust, rust + ping -> ring

Usage: ring [OPTIONS] <DESTINATION>

Arguments:
  <DESTINATION>  Ping destination, ip or domain

Options:
  -c <COUNT>            Count of ping times [default: 4]
  -s <PACKET_SIZE>      Ping packet size [default: 64]
  -t <TTL>              Ping ttl [default: 64]
  -w <TIMEOUT>          Ping timeout seconds [default: 1]
  -i <INTERVAL>         Ping interval duration milliseconds [default: 1000]
  -h, --help            Print help information
  -V, --version         Print version information
```

### 实现 Ping

pnet 中提供了 ICMP 包的定义，socket2 可以将定义好的 ICMP 包发送给目标 IP，另一种实现是通过`pnet_transport::transport_channel`发送原始数据包，但需要过滤结果而且权限要求较高。

首先定义 ICMP 包

```rust
let mut buf = vec![0; self.config.packet_size];
let mut icmp = MutableEchoRequestPacket::new(&mut buf[..]).ok_or(RingError::InvalidBufferSize)?;
icmp.set_icmp_type(IcmpTypes::EchoRequest); // 设置为EchoRequest类型
icmp.set_icmp_code(IcmpCodes::NoCode);
icmp.set_sequence_number(self.config.sequence + seq_offset); // 序列号
icmp.set_identifier(self.config.id);
icmp.set_checksum(util::checksum(icmp.packet(), 1)); // 校验函数
```

通过 socket2 发送请求

```rust
let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4))?;
let src = SocketAddr::new(net::IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0);
socket.bind(&src.into())?; // 绑定源地址
socket.set_ttl(config.ttl)?;
socket.set_read_timeout(Some(Duration::from_secs(config.timeout)))?; // 超时配置
socket.set_write_timeout(Some(Duration::from_secs(config.timeout)))?;

// 发送
socket.send_to(icmp.packet_mut(), &self.dest.into())?;
```

最后处理相应，转换成 pnet 中的 EchoReplyPacket

```rust
let mut mem_buf = unsafe { &mut *(buf.as_mut_slice() as *mut [u8] as *mut [std::mem::MaybeUninit<u8>]) };
let (size, _) = self.socket.recv_from(&mut mem_buf)?;

// 转换成EchoReply
let reply = EchoReplyPacket::new(&buf).ok_or(RingError::InvalidPacket)?;
```

至此，一次 Ping 请求完成。

### 周期性发送

Ping 需要周期性的发送请求，比如秒秒请求一次，如果直接通过循环实现，一次请求卡住将影响主流程，必须通过多线程来保证固定周期的发送。

发送请求

```rust
let send = Arc::new(AtomicU64::new(0)); // 统计发送次数
let _send = send.clone();
let this = Arc::new(self.clone());
let (sx, rx) = bounded(this.config.count as usize); // channel接受线程handler
thread::spawn(move || {
    for i in 0..this.config.count {
        let _this = this.clone();
        sx.send(thread::spawn(move || _this.ping(i))).unwrap(); // 线程中运行ping，并将handler发送到channel中

        _send.fetch_add(1, Ordering::SeqCst); // 发送一次，send加1

        if i < this.config.count - 1 {
            thread::sleep(Duration::from_millis(this.config.interval));
        }
    }
    drop(sx); // 发送完成关闭channel
});
```

- `thread::spawn`可以快速创建线程，但需要注意所有权的转移，如果在线程内部调用方法获取变量，需要通过`Arc`原子引用计数
- `send`变量用来统计发送数，原子类型，并且用 Arc 包裹；`this`是当前类的 Arc 克隆，会转移到线程中
- 第一个线程内周期性调用`ping()`，并且其在单独线程中运行
- 通过`bounded`来定义 channel(类似 Golang 中的 chan)，用来处理结果，发送完成关闭

处理结果

```rust
let success = Arc::new(AtomicU64::new(0)); // 定义请求成功的请求
let _success = success.clone();
let (summary_s, summary_r) = bounded(1); // channel来判断是否处理完成
thread::spawn(move || {
    for handle in rx.iter() {
        if let Some(res) = handle.join().ok() {
            if res.is_ok() {
                _success.fetch_add(1, Ordering::SeqCst); // 如果handler结果正常，success加1
            }
        }
    }
    summary_s.send(()).unwrap(); // 处理完成
});
```

第二个线程用来统计结果，channel 通道取出 ping 线程的 handler，如果返回正常则加 1

处理信号

```rust
let stop = signal_notify()?; // 监听退出信号
select!(
    recv(stop) -> sig => {
        if let Some(s) = sig.ok() { // 收到退出信号
            println!("Receive signal {:?}", s);
        }
    },
    recv(summary_r) -> summary => { // 任务完成
        if let Some(e) = summary.err() {
            println!("Error on summary: {}", e);
        }
    },
);
```

通过 select 来处理信号(类似 Golang 中的 select)，到收到退出信号或者任务完成时继续往下执行。

### 信号处理

Golang 中可以很方便的处理信号，但在 Rust 中官方库没有提供类似功能，可以通过`signal_hook`与`crossbeam_channel`实现监听退出信号

```rust
fn signal_notify() -> std::io::Result<Receiver<i32>> {
    let (s, r) = bounded(1); // 定义channel，用来异步接受退出信号

    let mut signals = signal_hook::iterator::Signals::new(&[SIGINT, SIGTERM])?; // 创建信号

    thread::spawn(move || {
        for signal in signals.forever() { // 如果结果到信号发送到channel中
            s.send(signal).unwrap();
            break;
        }
    });

    Ok(r) // 返回接受channel
}
```

### 其他

很多吐槽人 Golang 的错误处理，Rust 也不遑多让，不过提供了`?`语法糖，也可以配合`anyhow`与`thiserror`来简化错误处理。

## 验证

Ping 域名/IP

```bash
ring git:(main)  cargo run -- www.baidu.com

PING www.baidu.com(103.235.46.40)
64 bytes from 103.235.46.40: icmp_seq=1 ttl=64 time=255.85ms
64 bytes from 103.235.46.40: icmp_seq=2 ttl=64 time=254.17ms
64 bytes from 103.235.46.40: icmp_seq=3 ttl=64 time=255.41ms
64 bytes from 103.235.46.40: icmp_seq=4 ttl=64 time=256.50ms

--- www.baidu.com ping statistics ---
4 packets transmitted, 4 received, 0% packet loss, time 3257.921ms
```

测试退出信息，运行中通过 Ctrl+C 中止

```bash
cargo run 8.8.8.8 -c 10

PING 8.8.8.8(8.8.8.8)
64 bytes from 8.8.8.8: icmp_seq=1 ttl=64 time=4.32ms
64 bytes from 8.8.8.8: icmp_seq=2 ttl=64 time=3.02ms
64 bytes from 8.8.8.8: icmp_seq=3 ttl=64 time=3.24ms
^CReceive signal 2

--- 8.8.8.8 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2365.104ms
```

## 总结

Rust 为了安全高效，通过引入所有权来解决 GC 问题，也带来了许多不便，编程时必须要考虑到变量的声明周期、借用等问题，所有语言都是在方便、性能、安全之间做权衡，要么程序员不方便，要么编译器多做点功。换一个角度来说 Bug 总是不可避免的，在编译阶段出现总好过运行阶段。

所有源码见: https://github.com/qingwave/ring

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
