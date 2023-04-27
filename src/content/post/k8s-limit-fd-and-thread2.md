---
title: k8s中fd与thread限制(二)
date: 2019-07-16 19:21:47
tags:
  - k8s
  - docker
categories:
  - cloud
---

## 背景

在上线 fd 隔离后，多个用户反馈部署有问题，日志显示 `su could not open session`，dolphin（主进程） 启动用户程序时如果用户部署账号为 work，会通过 su 切换到 work 下启动用户程序，报错正是这时产生。

<!--more-->

## 探究

通过复现问题，确实存在 su 切换失败，通过`strace su work`显示：

```sh
sh-4.1# strace -o strace.log su work
could not open session
sh-4.1# vim strace.log
execve("/bin/su", ["su", "work"], [/* 18 vars */]) = 0
brk(0)
/su
...
stat("/etc/pam.d", {st_mode=S_IFDIR|0755, st_size=4096, ...}) = 0
open("/etc/pam.d/su", O_RDONLY)         = 3
...
open("/etc/pam.d/system-auth", O_RDONLY) = 4
...
getrlimit(RLIMIT_CPU, {rlim_cur=RLIM_INFINITY, rlim_max=RLIM_INFINITY}) = 0 # 通过getrlimit获取当前ulimit设置
getrlimit(RLIMIT_FSIZE, {rlim_cur=RLIM_INFINITY, rlim_max=RLIM_INFINITY}) = 0
getrlimit(RLIMIT_DATA, {rlim_cur=RLIM_INFINITY, rlim_max=RLIM_INFINITY}) = 0
getrlimit(RLIMIT_STACK, {rlim_cur=8192*1024, rlim_max=RLIM_INFINITY}) = 0
getrlimit(RLIMIT_CORE, {rlim_cur=RLIM_INFINITY, rlim_max=RLIM_INFINITY}) = 0
getrlimit(RLIMIT_RSS, {rlim_cur=RLIM_INFINITY, rlim_max=RLIM_INFINITY}) = 0
getrlimit(RLIMIT_NPROC, {rlim_cur=2048*1024, rlim_max=2048*1024}) = 0
getrlimit(RLIMIT_NOFILE, {rlim_cur=10*1024, rlim_max=20*1024}) = 0
getrlimit(RLIMIT_MEMLOCK, {rlim_cur=RLIM_INFINITY, rlim_max=RLIM_INFINITY}) = 0
getrlimit(RLIMIT_AS, {rlim_cur=RLIM_INFINITY, rlim_max=RLIM_INFINITY}) = 0
getrlimit(RLIMIT_LOCKS, {rlim_cur=RLIM_INFINITY, rlim_max=RLIM_INFINITY}) = 0
getrlimit(RLIMIT_SIGPENDING, {rlim_cur=256736, rlim_max=256736}) = 0
getrlimit(RLIMIT_MSGQUEUE, {rlim_cur=800*1024, rlim_max=800*1024}) = 0
getrlimit(RLIMIT_NICE, {rlim_cur=0, rlim_max=0}) = 0
getrlimit(RLIMIT_RTPRIO, {rlim_cur=0, rlim_max=0}) = 0
getpriority(PRIO_PROCESS, 0)            = 20
open("/etc/security/limits.conf", O_RDONLY) = 3 # 读取limits.conf配置
fstat(3, {st_mode=S_IFREG|0644, st_size=1973, ...}) = 0
mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x7f2b03deb000
read(3, "# /etc/security/limits.conf\n#\n#E"..., 4096) = 1973
read(3, "", 4096)                       = 0
close(3)                                = 0
munmap(0x7f2b03deb000, 4096)            = 0
open("/etc/security/limits.d", O_RDONLY|O_NONBLOCK|O_DIRECTORY|O_CLOEXEC) = 3
fcntl(3, F_GETFD)                       = 0x1 (flags FD_CLOEXEC)
getdents(3, /* 2 entries */, 32768)     = 48
open("/usr/lib64/gconv/gconv-modules.cache", O_RDONLY) = 4
fstat(4, {st_mode=S_IFREG|0644, st_size=26060, ...}) = 0
mmap(NULL, 26060, PROT_READ, MAP_SHARED, 4, 0) = 0x7f2b03de5000
close(4)                                = 0
futex(0x7f2b037b6f60, FUTEX_WAKE_PRIVATE, 2147483647) = 0
getdents(3, /* 0 entries */, 32768)     = 0
close(3)                                = 0
setrlimit(RLIMIT_CORE, {rlim_cur=RLIM_INFINITY, rlim_max=RLIM_INFINITY}) = 0
setrlimit(RLIMIT_NOFILE, {rlim_cur=150240, rlim_max=300240}) = -1 EPERM (Operation not permitted) # 设置nofile失败，返回权限不足，经查证setrlimit需要CAP_SYS_RESOURCE
...
```

整理下执行 su 的流程

1. 进行 pam 认证，su 配置文件在/etc/pam.d/su，更多 pam 信息可参考 pam.d

2. 根据文件内容逐行认证，下面是线上 centos6 基础镜像的配置

```sh
#%PAM-1.0
auth sufficient pam_rootok.so
# Uncomment the following line to implicitly trust users in the "wheel" group.
#auth sufficient pam_wheel.so trust use_uid
# Uncomment the following line to require a user to be in the "wheel" group.
#auth required pam_wheel.so use_uid
auth include system-auth
account sufficient pam_succeed_if.so uid = 0 use_uid quiet
account include system-auth
password include system-auth
session include system-auth #认证失败出现在这步
session optional pam_xauth.so
```

3. system-auth 真实内容存放在 system-auth-ac，内容为

```sh
# User changes will be destroyed the next time authconfig is run.
auth required pam_env.so
auth sufficient pam_fprintd.so
auth sufficient pam_unix.so nullok try_first_pass
auth requisite pam_succeed_if.so uid >= 500 quiet
auth required pam_deny.so

account required pam_unix.so
account sufficient pam_localuser.so
account sufficient pam_succeed_if.so uid < 500 quiet
account required pam_permit.so

password requisite pam_cracklib.so try_first_pass retry=3 type=
password sufficient pam_unix.so md5 shadow nullok try_first_pass use_authtok
password required pam_deny.so

session optional pam_keyinit.so revoke
session required pam_limits.so # limit 认证
session [success=1 default=ignore] pam_succeed_if.so service in crond quiet use_uid
session required pam_unix.so
```

4. system-auth 调用 pam_limit.so 认证，并且类型为 required，及若认证失败则继续执行最后返回失败信息

5. pam_limit 会调用 getrlimit 获取当前 ulimit 信息，通过读取/etc/security/limits.conf，调用 setrlimit 设置 ulimit，并且 setrlimit 有一定限制

- 任何进程可以将软限制改为小于或等于硬限制
- 任何进程都可以将硬限制降低，但普通用户降低了就无法提高，该值必须等于或大于软限制
- 只有超级用户（拥有 CAP_SYS_RESOURCE 权限）可以提高硬限制

由于显示 docker 设置 nofile 最大 hard 限制为 20480， 而/etc/security/limits.cof 文件中为 300240，在 docker 中 root 用户缺少`CAP_SYS_RESOURCE`，所以出现上述问题。

## 解决办法

由于 limits.conf，以及 pam.so 等配置文件是镜像中的配置，解决冲突必须修改对应配置,有两种方式

- 通过 dolphin 将对应 limits.conf 以及 limits.d 目录下有关 nofile 的配置删除
- 基础镜像修改 limits.conf 配置
