---
title: Golang自定义DNS Nameserver
author: qinng
toc: true
tags:
  - dns
  - golang
date: 2021-03-29 10:55:24
categories:
  - code
---

某些情况下我们希望程序通过自定义`Nameserver`去查询域名，而不希望通过操作系统给定的`Nameserver`，本文介绍如何在`Golang`中实现自定义`Nameserver`。

<!--more-->

## DNS 解析过程

`Golang`中一般通过`net.Resolver`的`LookupHost(ctx context.Context, host string) (addrs []string, err error)`去实现域名解析，解析过程如下：

1. 检查本地`hosts`文件是否存在解析记录，存在即返回解析地址
2. 不存在即根据`resolv.conf`中读取的`nameserver`发起递归查询
3. `nameserver`不断的向上级`nameserver`发起迭代查询
4. `nameserver`最终返回查询结果给请求者

用户可以通过修改`/etc/resolv.conf`来添加特定的`nameserver`，但某些场景下我们不希望更改系统配置。比如在`kubernetes`中，作为`sidecar`服务需要通过`service`去访问其他集群内服务，必须更改`dnsPolicy`为`ClusterFirst`，但这可能会影响其他容器的 DNS 查询效率。

## 自定义 Nameserver

在`Golang`中自定义`Nameserver`，需要我们自己实现一个`Resolver`，如果是`httpClient`需要自定义`DialContext()`

`Resolver`实现如下：

```go
// 默认dialer
dialer := &net.Dialer{
		Timeout: 1 * time.Second,
}

// 定义resolver
resolver := &net.Resolver{
	Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		return dialer.DialContext(ctx, "tcp", nameserver) // 通过tcp请求nameserver解析域名
	},
}
```

自定义`Dialer`如下：

```go
type Dialer struct {
	dialer     *net.Dialer
	resolver   *net.Resolver
	nameserver string
}

// NewDialer create a Dialer with user's nameserver.
func NewDialer(dialer *net.Dialer, nameserver string) (*Dialer, error) {
	conn, err := dialer.Dial("tcp", nameserver)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	return &Dialer{
		dialer: dialer,
		resolver: &net.Resolver{
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				return dialer.DialContext(ctx, "tcp", nameserver)
			},
		},
		nameserver: nameserver, // 用户设置的nameserver
	}, nil
}

// DialContext connects to the address on the named network using
// the provided context.
func (d *Dialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}

	ips, err := d.resolver.LookupHost(ctx, host) // 通过自定义nameserver查询域名
	for _, ip := range ips {
    // 创建链接
		conn, err := d.dialer.DialContext(ctx, network, ip+":"+port)
		if err == nil {
			return conn, nil
		}
	}

	return d.dialer.DialContext(ctx, network, address)
}
```

`httpClient`中自定义`DialContext()`如下：

```go
ndialer, _ := NewDialer(dialer, nameserver)

client := &http.Client{
  Transport: &http.Transport{
    DialContext:         ndialer.DialContext,
    TLSHandshakeTimeout: 10 * time.Second,
  },
  Timeout: timeout,
}
```

## 总结

通过以上实现可解决自定义`Nameserver`，也可以在`Dailer`中添加缓存，实现 DNS 缓存。
