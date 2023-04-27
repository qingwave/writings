---
title: Ingress Header Too Large
author: qinng
toc: true
tags:
  - ingress
  - nginx
  - k8s
date: 2020-06-05 14:17:08
categories:
  - cloud
---

线上遇到多次由 ingress header 过大引起的请求失败, 可能返回 502/400，解决方案如下。

## 502 – too big header

502 错误一般是后端服务不可用，但这里是 nginx-ingress 返回的，在 nginx-ingress 可看到如下日志：
`upstream sent too big header while reading response header from upstream, client...`

需要在 ingress 配置如下参数

```yaml
apiVersion: extensions/v1beta1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffer-size: 128k #根据实际情况配置
    nginx.ingress.kubernetes.io/proxy-buffering: 'on'
    nginx.ingress.kubernetes.io/server-snippet: |
      large_client_header_buffers 16 128K;
      client_header_buffer_size 128k;
```

## 431/400 – too big header

http header 过大也有可能返回 400/431, 可按照上述调整，如果还是有问题需要检查后端服务的 header 设置，比如 golang http header 默认是`1M`;
springboot 应用需要在`application.properties`加上`server.max-http-header-size=32KB`等

## 413 – too large body

如果返回 413，则超过了 body size 的限制（默认`1M`）, 可在 ingress annotation 添加
`nginx.ingress.kubernetes.io/proxy-body-size: 8m`
