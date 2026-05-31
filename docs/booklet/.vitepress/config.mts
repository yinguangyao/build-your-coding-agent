import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: '从零实现 pi',
  description: '一本写给 web 工程师的 Coding Agent 小册：从一次 HTTP fetch 到完整的编码 agent',

  // GitHub Pages 项目站点的基础路径，对应 https://yinguangyao.github.io/build-your-coding-agent/
  base: '/build-your-coding-agent/',

  lastUpdated: true,
  cleanUrls: true,

  // code/ 下是配套示例代码与其 node_modules，里面有大量无关 .md，必须排除
  srcExclude: ['**/code/**', '**/node_modules/**'],

  head: [
    ['meta', { name: 'theme-color', content: '#646cff' }],
    ['meta', { property: 'og:title', content: '从零实现 pi — Coding Agent 小册' }],
    ['meta', { property: 'og:description', content: '从一次 HTTP fetch 一步步带你写出一个完整的 coding agent' }],
  ],

  themeConfig: {
    nav: [
      { text: '前言', link: '/README' },
      { text: '第 1 章', link: '/01-hello-llm' },
      {
        text: '配套代码',
        link: 'https://github.com/yinguangyao/build-your-coding-agent/tree/main/docs/booklet/code',
      },
    ],

    sidebar: [
      {
        text: '开始之前',
        items: [{ text: '前言：这本小册写给谁', link: '/README' }],
      },
      {
        text: '第一部分 · 协议层',
        collapsed: false,
        items: [
          { text: '1 · 一次 LLM 调用', link: '/01-hello-llm' },
          { text: '2 · 让响应流起来', link: '/02-streaming' },
          { text: '3 · 第一个工具调用', link: '/03-first-tool' },
        ],
      },
      {
        text: '第二部分 · Agent 核心循环',
        collapsed: false,
        items: [
          { text: '4 · ReAct 循环', link: '/04-react-loop' },
          { text: '5 · 真实的编码工具', link: '/05-real-tools' },
          { text: '6 · 并行工具调用', link: '/06-parallel-tools' },
        ],
      },
      {
        text: '第三部分 · 长寿命会话',
        collapsed: false,
        items: [
          { text: '7 · 会话持久化与多会话', link: '/07-sessions' },
          { text: '8 · 上下文压缩', link: '/08-compaction' },
          { text: '9 · 取消与恢复', link: '/09-abort-resume' },
          { text: '10 · 排队：steering 和 follow-up', link: '/10-queueing' },
        ],
      },
      {
        text: '第四部分 · 做成产品',
        collapsed: false,
        items: [
          { text: '11 · 系统提示与项目上下文', link: '/11-system-prompt' },
          { text: '12 · 多供应商抽象', link: '/12-providers' },
          { text: '13 · 终端 UI 与交互模式', link: '/13-tui' },
          { text: '14 · 扩展系统', link: '/14-extensions' },
          { text: '15 · 组装 mini-pi', link: '/15-mini-pi' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/yinguangyao/build-your-coding-agent' },
    ],

    docFooter: {
      prev: '上一章',
      next: '下一章',
    },

    outline: {
      label: '本页目录',
      level: [2, 3],
    },

    lastUpdated: {
      text: '最后更新于',
    },

    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',

    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索文档',
          },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },

    footer: {
      message: '基于 pi 的开源教程 · 用 VitePress 构建',
      copyright: 'Released under the MIT License.',
    },
  },
})
