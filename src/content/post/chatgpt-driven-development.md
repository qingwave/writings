---
date: 2023-10-30T08:00:19.746Z
title: ChatGPT驱动开发
draft: false
description: '尝试完全由ChatGPT从零实现一个项目'
excerpt: ''
image: '/img/mygpt/mygpt.png'
categories: ['工具']
tags: ['chatgpt']
---

最近公司在搞头脑风暴，研究如何将项目与AIGC结合起来。平常也经常使用`New Bing`、`ChatGPT`做一些辅助开发，大部分是作为一个更智能点的搜索引擎，这次想做个更有意思的尝试，看看能不能通过`ChatGPT`完全独立地实现一个可用的前后端项目。

## 开发流程

### 第一版
没有什么特别明确地需求，也是灵光一闪，决定让`ChatGPT`写一个自己的套壳网站。

首先提了个很概括的需求，ChatGPT(3.5)回复的很详细，包含了`python`的后端和前端的代码，还额外提供了安装依赖、运行方式等。

<table class="flex">
  <tr class="flex items-center">
     <td><img src="/img/mygpt/mygpt1.png"></td>
     <td><img src="/img/mygpt/mygpt2.png"></td>
  </tr>
</table>

我对`Flask`并不熟悉，运行直接报错，继续提问，根据回复添加了模板目录可以正常运行。
![](/img/mygpt/mygpt3.png)

第一次运行结果如下图，可以正常调用openai API并在界面上显示：
![](/img/mygpt/mygpt4.png)

### 界面优化

第一版界面太简单了，所以我提出了页面美化已经连续对话的需求，`ChatGPT`基本能够根据需求做一些调整，但也会遇到一些报错，比如引用过期的API、函数未定义等，通过不断询问也基本能够修复。

添加CSS后，界面如下：
![](/img/mygpt/mygpt5.png)

界面做了一些调整，比如居中，按钮的颜色等。但还需要更精准的调整，提出的需求如下：

- 聊天框占宽度屏幕的1/2，左右`padding 80px`，输入回车可发送消息
- 激活聊天框 button显示为绿色，默认是灰色
- 输入框和对话框对齐，高度和屏幕一致，显示内容包括用户名
- 界面满屏，用户输出背景的是白色，gpt输出的是灰色
- ...

调整UI的过程，非常痛苦，必须给出精确的描述，ChatGPT才有可能生成符合预期的代码，一些非常小的修改需要好几轮对话才能解决，最终效果如图：
![](/img/mygpt/mygpt6.png)

### 功能增强

相对于UI修改，添加逻辑相对简单，也比较符合预期，需求如下：
- `Chatgpt web`应用增加左边栏，显示对话列表，可以创建新对话，每个对话需要存储到浏览器
- 实现点击`New chat`按钮，添加一个对话到侧边栏，多个对话时，最多只有一个对话的edit、delete按钮是激活的
- `conversationList` 旁边显示编辑和删除按钮，可以编辑title，删除item
- ...

<table class="flex">
  <tr class="flex items-center">
     <td><img src="/img/mygpt/mygpt7.png"></td>
     <td><img src="/img/mygpt/mygpt8.png"></td>
     <td><img src="/img/mygpt/mygpt9.png"></td>
  </tr>
</table>

多次调整后得到，还是比较符合预期的
![](/img/mygpt/mygpt.png)


## 总结

示例中生成的代码都放在了[Github](https://github.com/qingwave/mygpt)中，甚至项目中的`ReadMe`都是由`ChatGPT`生成的。

通过这次实验，我们确实可以通过`ChatGPT`来开发一些小型项目，不断地通过**需求 -> 验证 -> 修改**，虽然中间可能会出了不少小错误，但最终达到一个可用状态。

当然前提是需要一个明确地需求，或者说对于`ChatGPT`驱动开发我们唯一要做的就是写一个合适`prompt`。对于逻辑型的功能来说相对好描述，但是对于UI之类的，如果没有量化的数据，很难达到预期，但设想以后是不是可以通过一些原型工具一键生成代码了。

那么，有了类似`ChatGPT`的工具，我们离失业还有多远呢...

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
