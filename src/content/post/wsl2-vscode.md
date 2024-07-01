---
title: WSL2+VSCode+Zsh打造Win开发环境
author: qinng
toc: true
image: /img/blog/wsl-vscode.png
tags:
  - wsl
date: 2020-02-11 23:51:51
categories:
  - 工具
---

一直以来使用 Ubuntu 开发，前两天 Ubuntu 桌面环境崩了，一些工作软件在 Ubuntu 下很不好用，恰好 WSL2(Windows Linux 子系统)发布已经有一段日子，而且支持了 Docker，上手看看可用性如何。

<!--more-->

## 配置 WSL2

### 必要条件

- Windows 10 Build 18917 或更新版本
- 启用虚拟化

### 安装步骤

- 启用“虚拟机平台”可选组件，以管理员身份打开 PowerShell 并运行：
  `Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform`
- 启用安装子系统
  `Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux`
  启用这些更改后，你需要重新启动计算机。
- 应用商店安装 ubuntu，如`Ubuntu-18.04`
- 使用命令行设置要由 WSL 2 支持的发行版，在 PowerShell 中运行：
  `wsl --set-version <Distro> 2`

### 配置 Ubuntu

配置源，配置 Sudo 免密码，安装必要软件 Python、Git、Docker 等，终端美化可通过安装 Zsh...

## 安装 VSCode WSL 插件

VSCode 已经支持了[WSL 插件](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-wsl)

最终界面如下：
![](/img/blog/wsl-vscode.png)

## 总结

可以愉快的使用 VSCode 开发，目前也发现了几点小问题：

- Vscode Terminal 改为 WSL 后，启动会有 1-2 秒延时
- WSL2 中的软件配置开机自启比较麻烦，网上有方案，我是通过快捷命令如启动 Docker `alias sds="sudo service docker start"`
- WSL2 本质是个虚拟机，网络方式和本地有一定差异，对我来说影响不大

目前在家办公已两周，此方案感觉良好。
