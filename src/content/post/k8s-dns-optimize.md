---
title: 优化Kubernetes集群内DNS
author: qinng
toc: true
tags:
  - k8s
  - dns
date: 2021-02-01 10:17:40
categories:
  - cloud
---

kubernetes 集群内置的 dns 插件`kubedns/coredns`在高并发情况下可能遇到性能瓶颈，以下从配置与本地缓存方面说明如何减少 dns 查询失败率，提高性能。

<!--more-->

## 配置优化

### dnsPolicy

k8s 默认的 `dnsPolicy` 是`ClusterFirst`，因为 `ndots` 和 `serach domain` 在访问外部 dns 会有额外的查询次数。

```bash
/ # cat /etc/resolv.conf
nameserver 10.254.0.2
search default.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
/ #
/ #
/ #  host -v mi.com
Trying "mi.com.default.svc.cluster.local"
Trying "mi.com.svc.cluster.local"
Trying "mi.com.cluster.local"
Trying "mi.com"
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 38967
;; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 0

;; QUESTION SECTION:
;mi.com.                                IN        A

;; ANSWER SECTION:
mi.com.                        30        IN        A        58.83.160.156
```

如果不访问 service，调整`dnsPolicy`为`Default`，直接走宿主机的 dns

### ndots

如需访问 service，尽量减少`ndots`（默认 5）即域名中点的个数小于`ndots`会按照 search 域（mi.com.default.svc.cluster.local）依次查询，若查询不到再查询原始域名，总共进行 8 次 dns 查询（4 次 ipv4, 4 次 ipv6）

设置`ndots`为 1 后，只有两次查询（1 次 ipv4, ipv6）

```bash
/ #  host -v mi.com
Trying "mi.com"
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 23894
;; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 0

;; QUESTION SECTION:
;mi.com.                                IN        A

;; ANSWER SECTION:
mi.com.                        30        IN        A        58.83.160.156
```

但此种方式 service 域名分割大于等于`ndots`，则解析不到，需要业务自行判断合适的`ndots`值

```bash
/ #  host -v prometheus.kube-system
Trying "prometheus.kube-system"
Host prometheus.kube-system not found: 3(NXDOMAIN)
Received 115 bytes from 10.254.0.2#53 in 8 ms
Received 115 bytes from 10.254.0.2#53 in 8 ms
```

### coredns 优化

调整合理的副本数，阿里建议`coredns:node=1:8`，启动`AutoPath`插件减少查询次数，见[DNS 性能优化](2)

## DNS 缓存

### NodeLocalDNS

NodeLocal DNSCache 通过在集群节点上作为 DaemonSet 运行 dns 缓存代理来提高集群 DNS 性能，
借助这种新架构，Pods 将可以访问在同一节点上运行的 dns 缓存代理，从而避免了 iptables DNAT 规则和连接跟踪。

架构如下:
![local-dns](https://d33wubrfki0l68.cloudfront.net/bf8e5eaac697bac89c5b36a0edb8855c860bfb45/6944f/images/docs/nodelocaldns.svg)

NodeLocalDNS 的设计提案见（[nodelocal-dns-cache](3)）

#### 验证

官方安装方式见[nodelocaldns](https://github.com/kubernetes/kubernetes/tree/master/cluster/addons/dns/nodelocaldns)，需要自行替换变量

可通过如下脚本，一键安装（注意设置 kubedns svc ClusterIP）

```bash
#!/bin/bash

wget https://raw.githubusercontent.com/kubernetes/kubernetes/master/cluster/addons/dns/nodelocaldns/nodelocaldns.yaml

# registery
docker_registery=k8s.gcr.io/dns/k8s-dns-node-cache
# kube-dns svc clusterip
kubedns_svc=10.254.0.2
# nodelocaldns ip
nodelocaldns_ip=169.254.20.10
# kube-proxy mode, iptables or ipvs
kubeproxy_mode=iptables
result=result.yaml

if [ ${kubeproxy_mode} == "ipvs" ]; then
    sed -e "s|k8s.gcr.io/dns/k8s-dns-node-cache|$docker_registery|g" \
        -e "s/__PILLAR__CLUSTER__DNS__/$kubedns_svc/g" \
        -e "s/__PILLAR__LOCAL__DNS__/$nodelocaldns_ip/g" \
        -e 's/[ |,]__PILLAR__DNS__SERVER__//g' \
        -e "s/__PILLAR__DNS__DOMAIN__/cluster.local/g" nodelocaldns.yaml >$result
else
    sed -e "s|k8s.gcr.io/dns/k8s-dns-node-cache|$docker_registery|g" \
        -e "s/__PILLAR__DNS__SERVER__/$kubedns_svc/g" \
        -e "s/__PILLAR__LOCAL__DNS__/$nodelocaldns_ip/g" \
        -e "s/__PILLAR__DNS__DOMAIN__/cluster.local/g" nodelocaldns.yaml >$result
fi

kubectl apply -f $result
```

创建完成后，每个节点运行一个 pod，查看 pod(个别节点 ingress-nginx 占用 8080 端口，导致 nodelocaldns 启动失败)

```bash
# kubectl  get po -n kube-system -l k8s-app=node-local-dns -o wide
NAME                   READY   STATUS             RESTARTS   AGE    IP              NODE                            NOMINATED NODE   READINESS GATES
node-local-dns-2fvxb   0/1     CrashLoopBackOff   4          103s   10.38.200.195   node04          <none>           <none>
node-local-dns-4zmcd   1/1     Running            0          54d    10.38.201.55    node06   <none>           <none>
node-local-dns-55tzg   1/1     Running            0          60d    10.38.200.186   node02          <none>           <none>
node-local-dns-cctg7   1/1     Running            0          54d    10.38.200.242   node07   <none>           <none>
node-local-dns-khgmm   1/1     Running            0          54d    10.38.201.36    node08   <none>           <none>
node-local-dns-mbr64   1/1     Running            0          60d    10.38.200.187   node05          <none>           <none>
node-local-dns-t67vw   1/1     Running            0          60d    10.38.200.188   node03          <none>           <none>
node-local-dns-tmm92   1/1     Running            14         54d    10.38.200.57    node09   <none>           <none>
```

默认配置如下：

```bash
cluster.local:53 {
    errors
    cache {
            success 9984 30 # 默认成功缓存30s
            denial 9984 5 #失败缓存5s
    }
    reload
    loop
    bind 169.254.20.10 10.254.0.2 #本地监听ip
    forward . 10.254.132.95 { #转发到kubedns-upstream
            force_tcp
    }
    prometheus :9253 #监控接口
    health 169.254.20.10:8080 #健康检测端口
    }
in-addr.arpa:53 {
    errors
    cache 30
    reload
    loop
    bind 169.254.20.10 10.254.0.2
    forward . 10.254.132.95 {
            force_tcp
    }
    prometheus :9253
    }
ip6.arpa:53 {
    errors
    cache 30
    reload
    loop
    bind 169.254.20.10 10.254.0.2
    forward . 10.254.132.95 {
            force_tcp
    }
    prometheus :9253
    }
.:53 {
    errors
    cache 30
    reload
    loop
    bind 169.254.20.10 10.254.0.2
    forward . /etc/resolv.conf
    prometheus :9253
    }
```

节点上查看 localdns 的网卡，本地将监听`169.254.20.10`与`10.254.0.2`两个地址，拦截 kubedns((默认`10.254.0.2`)的请求，命中后直接返回，若未命中转发到 kubedns(对应 service `kube-dns-upstream`，kube-dns-upstream 由 localdns 创建绑定 kubedns pod)

```bash
# ip addr show nodelocaldns
182232: nodelocaldns: <BROADCAST,NOARP> mtu 1500 qdisc noop state DOWN
    link/ether 4e:62:1c:fd:56:12 brd ff:ff:ff:ff:ff:ff
    inet 169.254.20.10/32 brd 169.254.20.10 scope global nodelocaldns
       valid_lft forever preferred_lft forever
    inet 10.254.0.2/32 brd 10.254.0.2 scope global nodelocaldns
       valid_lft forever preferred_lft forever
```

iptables 规则，使用`NOTRACK`跳过其它表处理

```bash
iptables-save | egrep "10.254.0.2|169.254.20.10"
-A PREROUTING -d 10.254.0.2/32 -p udp -m udp --dport 53 -j NOTRACK
-A PREROUTING -d 10.254.0.2/32 -p tcp -m tcp --dport 53 -j NOTRACK
-A PREROUTING -d 169.254.20.10/32 -p udp -m udp --dport 53 -j NOTRACK
-A PREROUTING -d 169.254.20.10/32 -p tcp -m tcp --dport 53 -j NOTRACK

-A OUTPUT -d 10.254.0.2/32 -p udp -m udp --dport 53 -j NOTRACK
-A OUTPUT -d 10.254.0.2/32 -p tcp -m tcp --dport 53 -j NOTRACK

-A INPUT -d 10.254.0.2/32 -p udp -m udp --dport 53 -j ACCEPT
-A INPUT -d 10.254.0.2/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A OUTPUT -s 10.254.0.2/32 -p udp -m udp --sport 53 -j ACCEPT
-A OUTPUT -s 10.254.0.2/32 -p tcp -m tcp --sport 53 -j ACCEPT

...
-A KUBE-SERVICES -d 10.254.0.2/32 -p tcp -m comment --comment "kube-system/kube-dns:dns-tcp cluster IP" -m tcp --dport 53 -j KUBE-SVC-ERIFXISQEP7F7OF4
-A KUBE-SERVICES -d 10.254.0.2/32 -p tcp -m comment --comment "kube-system/kube-dns:metrics cluster IP" -m tcp --dport 9153 -j KUBE-SVC-JD5MR3NA4I4DYORP
-A KUBE-SERVICES -d 10.254.0.2/32 -p udp -m comment --comment "kube-system/kube-dns:dns cluster IP" -m udp --dport 53 -j KUBE-SVC-TCOU7JCQXEZGVUNU
```

在 pod 通过 localdns 解析域名

```bash
# kubectl  exec -it dns-perf-client-64cfb49f9-9c5hg sh
/ # nslookup kubernetes 169.254.20.10
Server:                169.254.20.10
Address:        169.254.20.10#53

Name:        kubernetes.default.svc.cluster.local
Address: 10.254.0.1
```

#### 压测

通过`dnsperf`进行压测

测试域名列表如下

```bash
# cat records.txt
mi.com A
github.com A
www.microsoft.com A
www.aliyun.com A
kubernetes.io A
nginx A
nginx.default A
kubernetes A
kubernetes.default.svc.cluster.local A
kube-dns.kube-system.svc.cluster.local A
```

测试命令

```bash
dnsperf -l 120 -s 10.254.0.2 -d records.txt
```

结果如下
| |client number|qps|avg-lantency(ms)|stddev(ms)|lost|
|:----|:----|:----|:----|:----|:----|
|kubedns(1 pod)|1|53910|1.83|6.07|0%|
|kubedns(2 pod)|2|110000|1.83|1.94|9%|
|kubedns(4 pod)|4|120000|3.2|0.8|24%|
|nodelocaldns|1|71494|1.39|1.66|0%|
|nodelocaldns|2|142000|1.37|1.55|0%|

相比`nodelocaldns`，`localdns`查询性能提高了 33%，而且延时相对更小，由于`localdns`是分布式的整体 qps 相对 kubedns 有较大优势。当前测试相对简单，大部分请求会命中缓存，完整的测试结果待进一步验证。

#### 优缺点

优点：

- 大幅减少 dns 查询延时
- 提高 dns qps
- 不经过`iptables`与`conntrack`
- 默认使用 tcp 查询 dns，避免 dns 5 秒延时

缺点：

- 单点故障（OOM/Evicted/Config Error/Upgrade），社区通过起一个探测 daemonset 监听 localdns 状态，如果 localdns 异常将去掉 iptables 规则
- `hostnetwork`, 占用多个端口（8080, 9253 等）
- ipvs 模式下，需要改动 kubelet 默认 dns 配置（`NOTRACK`将对`ipvs`无效，除非 service 后端实例为 0）

注意事项

- 低版本 dns 存在 tcp 请求内存泄露
- 安装时`iptables`与`ipvs`配置不同

#### HA

- 社区提案将`iptables`写入规则从`nodelocaldns`拆分为单独的 daemonset，通过监听`localdns`地址来判断是否写入或删除`iptables`规则（ipvs 默认下无效）
- 在`/etc/resolv.conf`配置多个`nameservers`(不推荐，不同基础库表现不同，如`glibc 2.16+`查询 dns 时会向多个`nameservers`发送请求，反而造成了请求激增)

#### 灰度方式

- 通过`dnsConfi`g 配置 Pod 级别 dns（需要配置启动参数 localip）
- 通过设置`nodeselector`灰度 Node 级别 dns 策略

### 本地 DNS 缓存

除了 nodelocaldns，用户还可以在容器内或者添加 sidecar 来启用 dns 缓存

1. 通过在镜像中加入 nscd 进程，缓存 dns，如下：

   ```bash
   FROM ubuntu
   RUN apt-get update && apt-get install -y nscd && rm -rf /var/lib/apt/lists/*
   CMD service nscd start; bash -c "sleep 3600"
   ```

   此种方式需要用户改动镜像，或者加入额外脚本配置`nscd`

2. 另外可以配置可配置 dns 缓存 sidecar（如`coredns`, `dnsmasq`）来提高性能，此种方式灵活性高，但需要改动 pod 配置，而且较`nodelocaldns`浪费资源

## 参考

- https://kubernetes.io/zh/docs/tasks/administer-cluster/nodelocaldns/
- https://help.aliyun.com/document_detail/172339.html
- https://github.com/kubernetes/enhancements/blob/master/keps/sig-network/0030-nodelocal-dns-cache.md
- https://github.com/kubernetes/enhancements/blob/master/keps/sig-network/1024-nodelocal-cache-dns/README.md
- https://lework.github.io/2020/11/09/node-local-dns/
