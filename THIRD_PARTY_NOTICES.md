# Third-party notices

This repository's original code is licensed under the MIT License (see `LICENSE`).
The following third-party components are bundled or referenced; each remains under
its own license. Links point to the upstream license text.

| Component | Version | License | Upstream license |
|---|---|---|---|
| markdown-it | 14.1.0 | MIT | https://github.com/markdown-it/markdown-it/blob/master/LICENSE |
| KaTeX | 0.16.11 | MIT | https://github.com/KaTeX/KaTeX/blob/main/LICENSE |
| JSZip | 3.10.1 | MIT or GPLv3 | https://github.com/Stuk/jszip/blob/main/LICENSE.markdown |
| pdf.js | 3.11 | Apache-2.0 | https://github.com/mozilla/pdf.js/blob/master/LICENSE |
| Shiki | 3.23.0 | MIT | https://github.com/shikijs/shiki/blob/main/LICENSE |
| Inter | bundled | SIL Open Font License 1.1 | https://github.com/rsms/inter/blob/master/LICENSE.txt |

`app/vendor/markdown-it.LICENSE` carries the upstream markdown-it notice; other
minified files retain their upstream headers where applicable.

`app/vendor/shiki/` is a self-built, minified bundle of `shiki@3.23.0`
(`@shikijs/core`, `@shikijs/engine-javascript`, `@shikijs/langs`) using the
`css-variables` theme. Sources and the build entry live in `tools/shiki-build/`;
rebuild with `node build.mjs` after `npm install` (needs esbuild).

DeepSeek and the DeepSeek whale mark are trademarks of their respective owner.
This project is an unofficial community plugin and is not affiliated with,
endorsed by, or sponsored by DeepSeek.

## DSH brand and icon assets

The DeepSeek whale/logo assets under `app/assets/`, and the plugin icon
`icon.svg`, are derived from the DeepSeek Harness (DSH) open-source project:

- Project: https://github.com/deepseek-ai/deepseek-harness
- License: MIT
- Attribution: DeepSeek Harness (DSH), Copyright DeepSeek

They are included with attribution for use by individual developers. DeepSeek
names and marks remain trademarks of DeepSeek; this project is not an official
DeepSeek product.
