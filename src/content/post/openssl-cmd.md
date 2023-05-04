---
title: openssl常用命令
author: qinng
draft: true
toc: true
tags:
  - openssl
date: 2019-05-10 22:45:12
categories:
  - 工具
---

### 输出 x509 证书信息

```bash
openssl x509 -noout -text  -in ca.pem
```

结果如下

```bash
Certificate:
    Data:
        Version: 3 (0x2)
        Serial Number:
            5f:11:aa:b3:70:18:fd:89:b0:25:7a:9e:36:c5:e7:ce:33:5a:cc:b7
    Signature Algorithm: sha256WithRSAEncryption
        Issuer: C=CN, ST=BeiJing, L=BeiJing, O=xx, OU=xx, CN=xx
        Validity
            Not Before: Dec 26 06:17:00 2019 GMT
            Not After : Dec  2 06:17:00 2119 GMT #过期时间
        Subject: C=CN, ST=BeiJing, L=BeiJing, O=xx, OU=xx, CN=xx
        Subject Public Key Info:
        ...
```

### 验证公钥私钥是否匹配

```bash
diff -eq <(openssl x509 -pubkey -noout -in cert.crt) <(openssl rsa -pubout -in cert.key)
```

正常会输出

```bash
writing RSA key
```

### 验证证书 CA

```bash
openssl verify -CAfile ca.pem client.pem
```

正常输出

```bash
client.pem: OK
```
