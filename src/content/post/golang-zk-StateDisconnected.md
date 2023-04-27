---
title: golang zk大量disconnected event
author: qinng
toc: true
tags:
  - golang
  - zk
date: 2021-03-02 17:16:23
categories:
  - code
---

## 背景

在容器平台上我们提供了`zk`做白名单功能，`Pod`启动时 sidecar 会自动注册`zk`。昨天遇到`zk server`抖动，`sidecar`容器输出大量`StateDisconnected`事件，zk 正常后仍无法恢复，由于大量日志造成`sidecar`容器 cpu 占用过高，进而引发`dockerd`cpu 占用过高，严重时影响 dockerd 正常调用。

## 问题分析

### 问题复现

正常情况下，`sidecar`启动后会去注册`zk`：

```bash
# docker logs -f 01a1a4a74785
I0302 15:04:05.476463       1 manager.go:116] start run plugin zk
2021/03/02 15:04:05 Connected to 10.38.161.60:11000
I0302 15:04:05.488006       1 zk.go:152] zookeeper connect succeed: zk.srv:11000
2021/03/02 15:04:05 authenticated: id=33746806328105493, timeout=30000
2021/03/02 15:04:05 re-submitting `0` credentials after reconnect
I0302 15:04:05.516446       1 zk.go:220] watching zk node:[/tasks/cluster.xxx_default_deployment.htool/10.46.12.72] in cluster[xxx] #注册成功，开始watch
```

通过`iptable`s 来模拟异常，首先进入到容器`network namesapce`

```bash
pod=htool-6875bcb898-w7llc
containerid=$(docker ps |grep $pod|awk '{print $1}'|head -n 1)
pid=$(docker inspect -f {{.State.Pid}} $containerid)
nsenter -n --target $pid
```

使用`iptables` `drop`掉发往`zk`的请求(11000 为 zk server 端口)

```bash
iptables -A OUTPUT -p tcp -m tcp --dport 11000 -j DROP
```

zk client 自动重试（1s 一次），日志显示`Failed to connect to 10.38.161.54:11000: dial tcp 10.38.161.54:11000: i/o timeout`

```bash
I0302 15:04:05.516446       1 zk.go:220] watching zk node:[/tasks/cluster.xxx_default_deployment.htool/10.46.12.72] in cluster[xxx]
2021/03/02 15:08:55 recv loop terminated: err=failed to read from connection: read tcp 10.46.12.72:36884->10.38.161.60:11000: i/o timeout
2021/03/02 15:08:55 send loop terminated: err=<nil>
2021/03/02 15:08:56 Failed to connect to 10.38.161.54:11000: dial tcp 10.38.161.54:11000: i/o timeout
```

网络恢复，删除`iptables`

```bash
iptables -D OUTPUT -p tcp -m tcp --dport 11000 -j DROP
```

出现大量`StateDisconnected`日志

```bash
I0302 15:09:50.951897       1 zk.go:232] Unknown zk event[StateDisconnected] for znode:[/tasks/cluster.xxx_default_deployment.htool/10.46.12.72]
I0302 15:09:50.951893       1 zk.go:232] Unknown zk event[StateDisconnected] for znode:[/tasks/cluster.xxx_default_deployment.htool/10.46.12.72]
...
```

### 问题分析

`sidecar`中 zk watch 代码如下：

```go
exist, _, eventCh, err := conn.ExistsW(node) //监听zk事件
watcher:
        for {
                select {
                case e := <-eventCh:
                        switch e.State {
                        case zk.StateExpired:
                                return fmt.Errorf("node[%v] expired", node)
                        case zk.StateConnected, zk.StateHasSession:
                                return fmt.Errorf("Get zk event: %v ", e.State)
                        default:
                                klog.Infof("Get zk event[%v] for znode:[%v]", e.State, node) // 出错位置
                        }
                case <-ctx.Done():
                        // we close the conn in caller
                        break watcher
                }
        }
```

`ExistsW`函数由`github.com/samuel/go-zookeeper/zk`库提供，监听 zk 给定目录的事件

```go
func (c *Conn) ExistsW(path string) (bool, *Stat, <-chan Event, error) {
    var ech <-chan Event
    ...
    ech = c.addWatcher(path, watchTypeData)
    return exists, &res.Stat, ech, err
}
```

当 zk 异常恢复后，`c.addWatcher`中的`channel`被`close`，即`sidecar`中`eventCh`关闭，进入死循环。

### 修复验证

知道了原因，修复很简单，判断下 eventCh 状态即可

```go
    for {
        select {
        case e, ok := <-eventCh:
            if !ok {
                return fmt.Errorf("event channel closed")
            }
            if e.Err != nil {
                return fmt.Errorf("Get zk event: %v, err: %v", e.State, e.Err)
            }
            switch e.State {
            case zk.StateExpired:
                return fmt.Errorf("node[%v] expired", node)
            case zk.StateConnected, zk.StateHasSession:
                return fmt.Errorf("Get zk event: %v ", e.State)
            default:
                klog.Infof("Get zk event[%v] for znode:[%v]", e.State, node)
            }
        }
```

在修复代码后，再次验证可正常注册

```go
2021/03/02 15:13:40 Failed to connect to 10.38.161.60:11000: dial tcp 10.38.161.60:11000: i/o timeout
2021/03/02 15:13:40 Connected to 10.38.161.55:11000
2021/03/02 15:13:40 authentication failed: zk: session has been expired by the server
W0302 15:13:40.222923       1 zk.go:300] meet error when watching node path: Get zk event: StateDisconnected, err: zk: session has been expired by the server
2021/03/02 15:13:40 Connected to 10.38.161.54:11000
2021/03/02 15:13:40 authenticated: id=177861994644216038, timeout=30000
2021/03/02 15:13:40 re-submitting `1` credentials after reconnect
I0302 15:13:41.238524       1 zk.go:220] watching zk node:[/tasks/cluster.xxx_default_deployment.htool/10.46.12.72] in cluster[xxx]
```

## 总结

这个问题其实与`zk`没关系，是由于没有判断`channel`状态，陷入死循环。通常情况下大部分应用只有退出时才会关闭`channel`，不需要特殊处理。
