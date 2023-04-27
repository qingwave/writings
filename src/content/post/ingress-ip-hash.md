---
title: 多端口服务的Ingress IP-hash问题
author: qinng
toc: true
tags:
  - k8s
  - ingress
  - nginx
date: 2020-04-15 15:47:09
categories:
  - cloud
---

## 背景

业务反馈使用 Ingress 的 ip-hash, 同一个服务开启了 http 和 websocket 分别是两个端口, 但是配置 ip-hash 后, 同一个 client 的请求 http 和 websocket 不在同一个后端.

## 探究

根据业务 Ingress 配置,配置如下实例:

```yaml
apiVersion: extensions/v1beta1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/cors-allow-origin: '*'
    nginx.ingress.kubernetes.io/enable-cors: 'true'
    nginx.ingress.kubernetes.io/proxy-body-size: 200m
    nginx.ingress.kubernetes.io/proxy-read-timeout: '300'
    nginx.ingress.kubernetes.io/upstream-hash-by: $binary_remote_addr
  name: hellogo
spec:
  rules:
    - host: hellogo.d.xiaomi.net
      http:
        paths:
          - backend:
              serviceName: hellogo #http1, 8080
              servicePort: 8080
            path: /8080
          - backend:
              serviceName: hellogo #http2, 9090
              servicePort: 9090
            path: /9090
          - backend:
              serviceName: hellogo #websocket, 8081
              servicePort: 8081
            path: /ws
```

创建多个副本

```bash
$ kubectl get po -l app=hellogo
NAME                       READY   STATUS    RESTARTS   AGE
hellogo-699f997454-b5vs4   1/1     Running   0          66m
hellogo-699f997454-hm924   1/1     Running   0          66m
hellogo-699f997454-mfbqv   1/1     Running   0          66m
hellogo-699f997454-qdrwn   1/1     Running   0          66m
hellogo-699f997454-srh9b   1/1     Running   0          66m
hellogo-699f997454-wlwfh   1/1     Running   0          66m
```

测试 http 8080 端口, 请求到 pod hellogo-699f997454-qdrwn

```bash
$ curl http://hellogo.d.xiaomi.net/8080
hello 8080!
host hellogo.d.xiaomi.net
remoteaddr 10.46.23.1:15340
realip 10.232.41.102
hostname hellogo-699f997454-qdrwn

$ curl http://hellogo.d.xiaomi.net/8080
hello 8080!
host hellogo.d.xiaomi.net
remoteaddr 10.46.23.1:15866
realip 10.232.41.102
hostname hellogo-699f997454-qdrwn
```

测试 http 8080 端口, 请求到 pod hellogo-699f997454-b5vs4

```bash
$ curl http://hellogo.d.xiaomi.net/9090
hello 9090!
host hellogo.d.xiaomi.net
remoteaddr 10.38.200.195:23706
realip 10.232.41.102
hostname hellogo-699f997454-b5vs4

$ curl http://hellogo.d.xiaomi.net/9090
hello 9090!
host hellogo.d.xiaomi.net
remoteaddr 10.38.200.195:23706
realip 10.232.41.102
hostname hellogo-699f997454-b5vs4
```

猜想是由于获取的 nginx server 列表顺序不一致导致的, 但是看源码 ip list 是直接从 endpoint 获取的, 进入 nginx-ingress 查看

```bash
$ kubectl exec -it -n kube-system nginx-ingress-controller-m496n sh
# dbg工具查看nginx后端列表
/etc/nginx $ /dbg backends list | grep hellogo
default-hellogo-8080
default-hellogo-8081
default-hellogo-9090
# 8080端口的列表
/etc/nginx $ /dbg backends get default-hellogo-8080
{
  "endpoints": [
    {
      "address": "10.46.12.107",
      "port": "8080"
    },
    {
      "address": "10.46.12.108",
      "port": "8080"
    },
    {
      "address": "10.46.12.109",
      "port": "8080"
    },
    {
      "address": "10.46.23.23",
      "port": "8080"
    },
    {
      "address": "10.46.23.25",
      "port": "8080"
    },
    {
      "address": "10.46.23.29",
      "port": "8080"
    }
  ],
  "name": "default-hellogo-8080",
  "noServer": false,
  "port": 8080,
  ...
}
# 9090端口的列表
/etc/nginx $ /dbg backends get default-hellogo-9090
{
  "endpoints": [
    {
      "address": "10.46.12.107",
      "port": "9090"
    },
    {
      "address": "10.46.12.108",
      "port": "9090"
    },
    {
      "address": "10.46.12.109",
      "port": "9090"
    },
    {
      "address": "10.46.23.23",
      "port": "9090"
    },
    {
      "address": "10.46.23.25",
      "port": "9090"
    },
    {
      "address": "10.46.23.29",
      "port": "9090"
    }
  ],
  "name": "default-hellogo-9090",
  "noServer": false,
  "port": 9090,
  ...
}
```

对比发现两个端口的列表是一样的,只能看看代码.

ip-hash 代码在https://github.com/kubernetes/ingress-nginx/blob/master/rootfs/etc/nginx/lua/balancer/chash.lua

```lua
function _M.new(self, backend)
  local nodes = util.get_nodes(backend.endpoints)
  local o = {
    instance = self.factory:new(nodes),  --获取后端pod ip列表
    hash_by = backend["upstreamHashByConfig"]["upstream-hash-by"],
    traffic_shaping_policy = backend.trafficShapingPolicy,
    alternative_backends = backend.alternativeBackends,
  }
  setmetatable(o, self)
  self.__index = self
  return o
end

function _M.balance(self)
  local key = util.lua_ngx_var(self.hash_by) --获取需要hash的变量
  return self.instance:find(key)  --计算hash值
end

return _M
```

关键是在`get_nodes`函数,位于https://github.com/kubernetes/ingress-nginx/blob/master/rootfs/etc/nginx/lua/util.lua

```lua
function _M.get_nodes(endpoints)
  local nodes = {}
  local weight = 1 --所有后端weight相同都为1

  for _, endpoint in pairs(endpoints) do
    local endpoint_string = endpoint.address .. ":" .. endpoint.port --endpoint为ip+port
    nodes[endpoint_string] = weight
  end

  return nodes
end
```

通过代码可以看到在`ingress-nginx`中,实际的后端(upstream)是包含端口的,通过 hash 计算得到的值也不一样。

## 解决建议

首先确认系统的架构是不是合理，不同的端口提供不同的服务，一般是相互独立的。
如果确实有类似需求：

- 通过同一个端口提供服务，使用 path 来区分不同功能
- 修改代码，也比较简单
