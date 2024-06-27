---
title: '程序员的浪漫: 婚礼邀请函小程序'
date: 2022-09-06T14:30:30+08:00
draft: false
description: '为自己的婚礼添加点不一样'
tags: ['小程序']
image: /img/wedding/wedding.jpg
categories: ['code', '前端']
---

婚礼将近，作为一个~~有能耐~~好折腾的程序员怎么能不趁机展示下，着手开发个婚礼邀请函微信小程序。

## 总体设计

选用微信小程序，传播方便，相对公众号定制性也更强。原本打算 Github 找一个改改，无奈不是太繁杂、就是审美不过关，还是自己开头开始吧。

主要功能：

- 长页展示，不花里胡哨
- 照片展示，需要各种排版，避免单调
- 婚礼信息展示，日历、地点等
- 背景音乐，没有音乐就好比吃面不就蒜，总是少点味道
- 支持转发、分享

其它锦上添花的功能，比如点赞，评论，需要有数据库的支持，看自己需求了。

小程序地址：

<div class="flex justify-center">
<img src="/img/wedding/wedding-miniproject.jpg" width="200rpx" height="200rpx" />
</div>

效果如下：

<table class="flex">
  <tr class="flex items-center">
     <td><img src="/img/wedding/wedding1.jpg"></td>
     <td><img src="/img/wedding/wedding2.jpg"/></td>
  </tr>
  <tr class="flex items-center">
     <td><img src="/img/wedding/wedding3.jpg"/></td>
     <td><img src="/img/wedding/wedding4.jpg"/></td>
  </tr>
</table>

## 开发过程

首先是大体过下[开发文档](https://developers.weixin.qq.com/miniprogram/dev/framework/)，熟悉前端的应该都比较好上手，一些用法和 Vue 比较相似，就是容易写混，经常把`wx:if`写成`v-if`之类的。

### 背景音乐

通过 BackgroundAudioManager 实现背景音乐，暂停、续播都比较方便。

获取实例后，设置对应的标题、音乐链接即可直接播放

```js
const bgm = wx.getBackgroundAudioManager();
bgm.title = conf.BASE.bgmName;
bgm.coverImgUrl = conf.BASE.share;
bgm.src = conf.BASE.bgm;
```

暂停与播放可以绑定到对应的音乐图标上了，点击切换，主要逻辑如下：

```js
var t = this;

bgm.onStop(function () {
  t.setData({ playing: false });
});

bgm.onEnded(function () {
  t.setData({ playing: false });
});

bgm.onPause(function () {
  t.setData({ playing: false });
});

bgm.onPlay(function () {
  t.setData({ playing: true });
});
```

将音乐图标与事件绑定，当播放时展示 rotate 动画，暂停时停止动画`animation-play-state: paused`

```html
<image class="player-img {{playing ? '': 'player-stop'}}" lazyLoad="false" mode="aspectFit" src="{{static}}"></image>
```

### 图片展示

图片主要是要考虑到各种排版，避免审美疲劳，可以参考一些婚礼应用的排版设计，比如婚礼乎、婚礼纪之类的，这里大量参考了小程序我的婚礼邀请的设计。

**圆形图片**

展示新郎新娘名称时可以用到，通过设置`border-radius: 50%;`来实现

**排版**

横版照片可以直接填充，竖版照片填充过大，可以一行两张或三张，如果直接对齐太严肃，可以通过 margin-top 来设置落差，下面设置为三等分的图片设置

```css
.triple-img {
  border-radius: 10rpx;
  height: 300rpx;
  width: 30%;
}

.img-1 {
  margin-top: -100rpx;
}

.img-2: {
  margin-top: 0;
}

.img-3 {
  margin-top: 100rpx;
}
```

设置相框

```css
 {
  border: 6rpx solid #cbd5e1;
}
```

照片周围装饰线，可通过伪元素设置

```css
img::before {
  border: 4rpx solid #cbd5e1;
  border-bottom: none;
  border-right: none;
}
```

然后就是组合这些排列，添加对应的文字标题

**图片预览**
微信提供了图片预览的 API，可以直接使用，将方法绑定到对应图片或图片组上

```js
function viewImg() {
  wx.previewImage({
    urls: imgs, // 预览的图片列表
    current: src, // 初始预览的图片url
    success: function (res) {},
    fail: function (res) {},
    complete: function (res) {},
  });
}
```

图片开发可以先使用本地图片，开发完成后可以将图片压缩后（我使用的是图压）上传到对象存储或者云开发的存储中。

### 地图展示

小程序提供了原生组件 map，在[腾讯地图](https://lbs.qq.com/getPoint/)上选取所在酒店的经纬度，填充到 markers 中

```html
<map
  bindtap="openMap"
  style="width: 100%; height: 400rpx;"
  data-info="{{item}}"
  enablePoi="true"
  scale="16"
  enableRotate="true"
  latitude="{{item.latitude}}"
  longitude="{{item.longitude}}"
  markers="{{item.markers}}"
></map>
```

其中 openMap 用来打开地图

```js
function(e) {
      let info = e.target.dataset.info;
      wx.openLocation({ // 填充对应的信息
        name: info.address,
        address: info.address,
        latitude: info.latitude,
        longitude: info.longitude,
        fail: function(res) {
          console.log("failed to open location", res)
        }
      });
}
```

### 锦上添花

通过上面的步骤已经完成了邀请函，如果需要添加一些交互功能，就需要使用到服务器，或者直接使用云开发更简单点。

**点赞实现**

点赞很简单，数据库中设置一个 likes 字段，当用户点击时加 1，如果点赞过再点击减 1，可以通过云开发提供的原子操作实现

```js
function () {
      var num = 0
      var likes = this.data.likes
      if (!this.data.liked) {
        num = 1 // 未点赞，加1
        likes++
      } else {
        num = -1 // 已点赞，减1
        likes--
      }

      const _ = this.data.db.command
      this.setData({
        liked: !this.data.liked,
        likes: likes
      })

      this.data.db.collection('wedding').doc('config').update({
        data: {
          likes: _.inc(num) // 原子操作，更新点赞值
        },
        fail: function (err) {
          console.log("set failed", err)
        }
      })
    }
```

如果需要记录点赞的用户，首先需要用户登录，相对不太友好，点赞后可以记录用户 OpenID 到对应表。

**发送通知**

首先要申请消息模板，在小程序管理界面可申请，记录模板 id 和内容 key 值。

这里通过云函数实现发送婚礼邀请的通知，只是当用户点击时，实时出发。如果需要延时触发（比如婚礼一天前提醒），则需要服务器支持，通过延时任务或者定期轮询来实现。

云函数实现通知

```js
const cloud = require('wx-server-sdk');

cloud.init();

// 云函数入口函数
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const result = await cloud.openapi.subscribeMessage.send({
    touser: wxContext.OPENID, // 获取用户id
    page: event.page,
    data: event.data, // 添加对应的数据，值要与模板中的对应
    templateId: event.templateId, // 模板id
  });
  return result;
};
```

在小程序中调用

```js
function(e) {
      if (!conf.BASE.cloudEnable) {
        return
      }

      let info = e.target.dataset.info;
      wx.requestSubscribeMessage({
        tmplIds: [conf.BASE.msgId],
        success: function(res) {
          wx.cloud.callFunction({
            name: "sendMsg", // 云函数名称
            data: {
              page: indexPage,
              templateId: conf.BASE.msgId, // 模板id
              data: { // 对应数据
                "time2": {
                  "value": `${info.year}年${info.month}月${info.day}日 12:00`
                },
                "thing5": {
                  "value": `${conf.BASE.msgTitle}`
                },
                "thing6": {
                  "value": `${info.city}${info.address}`
                },
                "thing7": {
                  "value": info.room
                }
              }
            }
          })
        }
      })
}
```

## 一些坑

- 小程序的双向绑定，必须通过 this.setData 来设置，否则页面不会更新
- 部分功能在 IOS 与安卓上表现不一致，需要真机测试下
- 云开发的权限问题，会造成小程序的操作失败
- 分享到朋友圈中的小程序，直接打开会进入到单页模式，一些功能会受限比如更新云数据库，需要配置云开发权限设置

## 后记

前前后后小一周时间，算是搞定了，效果也符合预期。不过终究怎么展现只是个形式，内容更重要。

> Explore more in [https://qingwave.github.io](https://qingwave.github.io)
