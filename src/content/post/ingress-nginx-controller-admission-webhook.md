---
title: 'nginx ingress 启用 webhook'
author: qinng
toc: true
tags:
  - k8s
  - ingress
date: 2020-04-03 18:48:04
categories:
  - cloud
---

## 背景

k8s 中大多使用 nginx-ingress-controller 来实现 ingress, 但是脆弱的 nginx-controller 通过 ingress 解析出 nginx 配置, 对于某些 annotation 会 reload nignx 配置失败, 然后 controller 就卡死了, 不断重启, 除非删除对应的 ingress.

<!--more-->

### 问题复现

创建有问题的`ingress`

```yaml
apiVersion: extensions/v1beta1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/auth-tls-pass-certificate-to-upstream: 'false'
    nginx.ingress.kubernetes.io/auth-tls-verify-client: optional
    nginx.ingress.kubernetes.io/auth-tls-verify-depth: '1'
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header Host $targethost;
      proxy_buffering     off;
      proxy_pass          http://$targetbackend;
      proxy_next_upstream error timeout invalid_header http_500 http_502 http_503 http_504;
      proxy_redirect      off;
      proxy_set_header    X-SSL-Client-Verify $ssl_client_verify;
      proxy_set_header    X-SSL-Client-DN $ssl_client_s_dn;
      proxy_set_header    X-Real-IP       $remote_addr;
      proxy_set_header    X-Forwarded-For $proxy_add_x_forwarded_for;
  creationTimestamp: '2020-03-23T04:57:22Z'
  generation: 1
  name: example-ingress
  namespace: kube-system
  resourceVersion: '57681168'
  selfLink: /apis/extensions/v1beta1/namespaces/kube-system/ingresses/example-ingress
  uid: c7f66385-6cc2-11ea-b6a8-246e96d4b538
spec:
  rules:
    - host: example.com
      http:
        paths:
          - backend:
              serviceName: example-svc
              servicePort: 8008
            path: /
  tls:
    - hosts:
        - example.com
      secretName: example-tls
status:
  loadBalancer: {}
```

查看`nginx-ingress-controller`状态全部为`CrashLoopBackOff`

```bash
# kubectl get po -n kube-system -owide |grep ingress
nginx-ingress-controller-ftfbg                        1/2     CrashLoopBackOff   6          8m27s
nginx-ingress-controller-hp4pf                        1/2     CrashLoopBackOff   11         24m
nginx-ingress-controller-qlb4l                        1/2     CrashLoopBackOff   11         24m
```

查看`nginx-ingress-controller`日志, 显示 reload 失败`"proxy_pass" directive is duplicate in /tmp/nginx-cfg911768424:822`

```bash
-------------------------------------------------------------------------------
W0403 10:26:14.716246       1 queue.go:130] requeuing kube-system/nginx-ingress-controller-4txfk, err
-------------------------------------------------------------------------------
Error: exit status 1
2020/04/03 10:26:14 [notice] 137#137: ModSecurity-nginx v1.0.0
2020/04/03 10:26:14 [warn] 137#137: duplicate value "error" in /tmp/nginx-cfg911768424:815
nginx: [warn] duplicate value "error" in /tmp/nginx-cfg911768424:815
2020/04/03 10:26:14 [warn] 137#137: duplicate value "timeout" in /tmp/nginx-cfg911768424:815
nginx: [warn] duplicate value "timeout" in /tmp/nginx-cfg911768424:815
2020/04/03 10:26:14 [emerg] 137#137: "proxy_pass" directive is duplicate in /tmp/nginx-cfg911768424:822
nginx: [emerg] "proxy_pass" directive is duplicate in /tmp/nginx-cfg911768424:822
nginx: configuration file /tmp/nginx-cfg911768424 test failed

-------------------------------------------------------------------------------
W0403 10:26:16.998897       1 nginx_status.go:207] unexpected error obtaining nginx status info: unexpected error scraping nginx status page: unexpected error scraping nginx : Get http://0.0.0.0:18080/nginx_status: dial tcp 0.0.0.0:18080: connect: connection refused
I0403 10:26:17.526801       1 main.go:167] Received SIGTERM, shutting down
I0403 10:26:17.526827       1 nginx.go:364] Shutting down controller queues
I0403 10:26:17.526845       1 status.go:200] updating status of Ingress rules (remove)
I0403 10:26:17.537511       1 status.go:219] removing address from ingress status ([])
I0403 10:26:17.537593       1 nginx.go:372] Stopping NGINX process
2020/04/03 10:26:17 [notice] 141#141: signal process started
I0403 10:26:20.547669       1 nginx.go:385] NGINX process has stopped
I0403 10:26:20.547692       1 main.go:175] Handled quit, awaiting Pod deletion
I0403 10:26:30.547824       1 main.go:178] Exiting with 0
```

## 解决方案

创建一个有问题的 ingress, 会影响所有新创建的 ingress 规则, 又一个集群级别的 Bug 诞生了.那么有没有办法, 提前检验 ingress 配置, 有问题就不去 reload. 那验证步骤肯定要在请求到达 nginx-controller 之前来做, 是不是想到了[k8s-admission-webhook][1], 可以在 apiserver 持久化对象前拦截请求, 去实现自定义的验证规则. 好在新版本的 nginx-ingress-controller(v0.25.0+)已经实现了相关的功能, 只需开启对应配置就行.

### ApiServer 配置

Apiserver 开启 webhook 相关配置, 必须包含`MutatingAdmissionWebhook`与`ValidatingAdmissionWebhook`

```
--admission-control=MutatingAdmissionWebhook,ValidatingAdmissionWebhook
```

### 创建 webhook 相关配置

启用 ValidatingAdmissionWebhook 必须使用 https, 需要配置对应证书

- 手动生成:
  ```bash
  openssl req -x509 -newkey rsa:2048 -keyout certificate.pem -out key.pem -days 365 -nodes -subj "/CN=ingress-validation-webhook.ingress-nginx.svc"
  ```
- CertificateSigningRequest
  通过 k8s `CertificateSigningRequest`来创建(controller-manager 需要开启`--cluster-signing-cert-file`与`--cluster-signing-key-file`)
  可通过如下脚本创建, namespace 与 service 替换成自己的

  ```bash
  SERVICE_NAME=ingress-nginx
  NAMESPACE=ingress-nginx

  TEMP_DIRECTORY=$(mktemp -d)
  echo "creating certs in directory ${TEMP_DIRECTORY}"

  cat <<EOF >> ${TEMP_DIRECTORY}/csr.conf
  [req]
  req_extensions = v3_req
  distinguished_name = req_distinguished_name
  [req_distinguished_name]
  [ v3_req ]
  basicConstraints = CA:FALSE
  keyUsage = nonRepudiation, digitalSignature, keyEncipherment
  extendedKeyUsage = serverAuth
  subjectAltName = @alt_names
  [alt_names]
  DNS.1 = ${SERVICE_NAME}
  DNS.2 = ${SERVICE_NAME}.${NAMESPACE}
  DNS.3 = ${SERVICE_NAME}.${NAMESPACE}.svc
  EOF

  openssl genrsa -out ${TEMP_DIRECTORY}/server-key.pem 2048
  openssl req -new -key ${TEMP_DIRECTORY}/server-key.pem \
      -subj "/CN=${SERVICE_NAME}.${NAMESPACE}.svc" \
      -out ${TEMP_DIRECTORY}/server.csr \
      -config ${TEMP_DIRECTORY}/csr.conf

  cat <<EOF | kubectl create -f -
  apiVersion: certificates.k8s.io/v1beta1
  kind: CertificateSigningRequest
  metadata:
    name: ${SERVICE_NAME}.${NAMESPACE}.svc
  spec:
    request: $(cat ${TEMP_DIRECTORY}/server.csr | base64 | tr -d '\n')
    usages:
    - digital signature
    - key encipherment
    - server auth
  EOF

  kubectl certificate approve ${SERVICE_NAME}.${NAMESPACE}.svc

  for x in $(seq 10); do
      SERVER_CERT=$(kubectl get csr ${SERVICE_NAME}.${NAMESPACE}.svc -o jsonpath='{.status.certificate}')
      if [[ ${SERVER_CERT} != '' ]]; then
          break
      fi
      sleep 1
  done
  if [[ ${SERVER_CERT} == '' ]]; then
      echo "ERROR: After approving csr ${SERVICE_NAME}.${NAMESPACE}.svc, the signed certificate did not appear on the resource. Giving up after 10 attempts." >&2
      exit 1
  fi
  echo ${SERVER_CERT} | openssl base64 -d -A -out ${TEMP_DIRECTORY}/server-cert.pem

  kubectl create secret generic ingress-nginx.svc \
      --from-file=key.pem=${TEMP_DIRECTORY}/server-key.pem \
      --from-file=cert.pem=${TEMP_DIRECTORY}/server-cert.pem \
      -n ${NAMESPACE}
  ```

### 配置 ingress controller

ingress controller 需要启用如下参数, 挂载需要的 tls 证书

| flag                               | description              | example usage                                        |
| ---------------------------------- | ------------------------ | ---------------------------------------------------- |
| `--validating-webhook`             | admission webhook 的地址 | `:8080`                                              |
| `--validating-webhook-certificate` | webhook 证书             | `/usr/local/certificates/validating-webhook.pem`     |
| `--validating-webhook-key`         | webhook 私钥             | `/usr/local/certificates/validating-webhook-key.pem` |

## 验证

更新后, 创建有问题的 ingress 则会拦截, 符合预期

```bash
# kubectl apply -f ing.yaml
Error from server: error when creating "ing.yaml": admission webhook "validate.nginx.ingress.kubernetes.io" denied the request:
-------------------------------------------------------------------------------
Error: exit status 1
2020/04/02 10:26:04 [emerg] 331#331: directive "proxy_pass" is not terminated by ";" in /tmp/nginx-cfg461116913:2165
nginx: [emerg] directive "proxy_pass" is not terminated by ";" in /tmp/nginx-cfg461116913:2165
nginx: configuration file /tmp/nginx-cfg461116913 test failed
```

[1]: https://kubernetes.io/zh/docs/reference/access-authn-authz/extensible-admission-controllers/

## 引用

- https://kubernetes.io/zh/docs/reference/access-authn-authz/extensible-admission-controllers/
- https://kubernetes.github.io/ingress-nginx/deploy/validating-webhook/
