/// <reference path="../.astro/types.d.ts" />
/// <reference types="@astro/client" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PUBLIC_GISCUS_REPO_ID: string;
  readonly PUBLIC_GISCUS_CATEGORAY_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
