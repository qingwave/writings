export interface Post {
  id: string;
  slug: string;

  publishDate: Date;
  title: string;
  description?: string;

  image?: string;

  canonical?: string | URL;
  permalink?: string;

  draft?: boolean;

  excerpt?: string;
  category?: Array<string>;
  tags?: Array<string>;
  author?: string;

  Content: unknown;
  content?: string;

  readingTime?: number;
}

export interface Project {
  title: string;
  description: string;
  year: number;
  img: string;
  href: string | URL;
  github?: string | URL;
  weight?: number;
}

export interface MetaSEO {
  title?: string;
  description?: string;
  image?: string;

  canonical?: string | URL;
  noindex?: boolean;
  nofollow?: boolean;

  ogTitle?: string;
  ogType?: string;
}
