const CONFIG = {
  name: 'Qingwave',

  origin: 'https://qingwave.github.io',
  basePathname: '',
  trailingSlash: false,

  title: 'Qingwave',
  description: "Qingwave's Blog.",
  defaultImage: '',

  defaultTheme: 'light', // Values: "system" | "light" | "dark" | "light:only" | "dark:only"

  language: 'zh',
  textDirection: 'ltr',

  dateFormatter: new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }),

  googleAnalyticsId: 'UA-134548083-1', // or "G-XXXXXXXXXX",
  googleSiteVerificationId: '-8bOgP-V4XsxXZtXVx9DIXkdIuruvAYiY37vBg26acI',

  blog: {
    disabled: false,
    postsPerPage: 100,

    post: {
      permalink: '/%slug%', // Variables: %slug%, %year%, %month%, %day%, %hour%, %minute%, %second%, %category%
      noindex: false,
      disabled: false,
    },

    list: {
      pathname: 'blog', // Blog main path, you can change this to "articles" (/articles)
      noindex: false,
      disabled: false,
    },

    category: {
      pathname: 'categories', // Category main path /category/some-category
      noindex: true,
      disabled: false,
    },

    tag: {
      pathname: 'tags', // Tag main path /tag/some-tag
      noindex: true,
      disabled: false,
    },
  },
};

export const SITE = { ...CONFIG, blog: undefined };
export const BLOG = CONFIG.blog;
export const DATE_FORMATTER = CONFIG.dateFormatter;
