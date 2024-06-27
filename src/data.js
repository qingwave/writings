import { getBlogPermalink, getHomePermalink, getPermalink, getAsset } from './utils/permalinks';

export const headerData = {
  links: [
    {
      text: '文章',
      href: getBlogPermalink(),
    },
    {
      text: '项目',
      href: getPermalink('/project'),
    },
    // {
    //   text: '其他',
    //   links: [
    //     {
    //       text: '标签',
    //       href: '/tags',
    //     },
    //     {
    //       text: '分类',
    //       href: '/categories',
    //     },
    //   ]
    // },
    {
      text: '阅读',
      href: getPermalink('/reading'),
    },
    {
      text: '关于我',
      href: getPermalink('/about'),
    }
  ],
  actions: [
    // { type: 'button', text: 'Github', href: 'https://github.com/qingwave' }
  ],
};

export const footerData = {
  links: [],
  secondaryLinks: [],
  socialLinks: [
    { ariaLabel: 'RSS', icon: 'tabler:rss', href: getAsset('/rss.xml') },
    // { ariaLabel: 'Github', icon: 'tabler:brand-github', href: 'https://github.com/onwidget/astrowind' },
  ],
  footNote: `
    <span class="w-5 h-5 md:-mt-0.5 bg-cover mr-1.5 float-left rounded-sm bg-[url(/favicon.ico)]"></span>
    <span class="text-slate-700 dark:text-slate-300">
    <a class="hover:brightness-50" href="https://qingwave.github.io"> Qingwave</a> · All rights reserved.</span>
  `,
};

export const projectData = [
  {
    title: 'Weave',
    description: 'Golang 与 Vue 实现的前后端管理系统，集成多种常用功能',
    year: 2022,
    img: '/img/blog/weave.png',
    href: 'https://github.com/qingwave/weave',
    github: 'https://github.com/qingwave/weave',
    weight: 2,
  },
  {
    title: 'MossDB',
    description: 'MossDB 是一个纯Golang实现可嵌入、支持事务、过期删除、可监听的内存键值型数据库',
    year: 2023,
    img: getAsset('/img/blog/mossdb.jpg'),
    href: 'https://github.com/qingwave/mossdb',
    weight: 1,
  },
  {
    title: 'MyCNI',
    description: 'MyCNI 是基于 Linux Bridge、Route 开发的 K8s CNI 网络插件',
    year: 2022,
    img: getAsset('/img/blog/mycni.jpg'),
    href: 'https://github.com/qingwave/mycni',
  },
  {
    title: 'MyGame',
    description: 'MyGame 是一个简单 K8s Operator, 可以创建2048游戏，旨在供初学者参考',
    year: 2021,
    img: getAsset('/img/blog/crd_mygame.png'),
    href: 'https://github.com/qingwave/mygame',
  },
  {
    title: '婚礼请柬小程序',
    description: '简洁优雅的婚礼邀请函微信小程序',
    year: 2022,
    img: getAsset('/img/wedding/wedding.jpg'),
    href: getPermalink('/wedding-invitation'),
  },
  {
    title: 'Gocorex',
    description: '集成了 Golang 微服务、分布式开发中的常用工具库',
    year: 2022,
    img: getAsset('/img/blog/gocorex.jpg'),
    href: 'https://github.com/qingwave/gocorex',
  },
  {
    title: 'qingwave.github.io',
    description: '基于 Astro 与 Tailwind CSS 开发的个人网站',
    year: 2023,
    img: getAsset('/img/blog/blog-2023.jpg'),
    href: getHomePermalink(),
  },
  {
    title: 'MyGPT',
    description: 'ChatGPT驱动开发的聊天应用',
    year: 2023,
    img: getAsset('/img/mygpt/mygpt.png'),
    href: 'https://github.com/qingwave/mygpt',
  },
  {
    title: 'MoveMate 久坐提醒',
    description: '一个久坐提醒浏览器扩展',
    year: 2023,
    img: getAsset('/img/blog/movemate.png'),
    href: 'https://github.com/qingwave/movemate',
  },
  {
    title: 'Ring',
    description: 'Rust + Ping -> Ring, Rust 实现的 Ping',
    year: 2023,
    img: getAsset('/img/blog/ring.jpg'),
    href: 'https://github.com/qingwave/ring',
  },
];
