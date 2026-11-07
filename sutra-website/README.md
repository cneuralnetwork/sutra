# Sutra website

The landing page for [Sutra](https://github.com/cneuralnetwork/sutra), the
open-source AI coding agent for the terminal.

This is a plain static site: HTML, CSS and JavaScript only. There is no build
step, no package install and no framework. The folder itself is the document
root, so a host can serve it as-is.

The page explains what Sutra is, shows an example session and the project's
measured benchmark results, and sends visitors to the repository to download it.
The full documentation stays in the repository's [`docs/`](../docs) folder.

## Preview locally

Serve this folder with any static file server:

```bash
cd sutra-website
python3 -m http.server 4321
# open http://localhost:4321
```

Node users can run `npx serve .` instead. Opening `index.html` directly from the
filesystem mostly works, but a local server is closer to production (absolute
paths such as `/styles.css`).

## Deploy

Point the host at this folder. Nothing needs to be compiled or installed.

### Netlify

1. Create a new Netlify site from the repository.
2. Set **Base directory** to `sutra-website`.
3. Leave the **Build command** empty.
4. Deploy. [`netlify.toml`](netlify.toml) sets the publish directory to `.`,
   adds the share redirects (`/github`, `/download`, `/docs`) and sends basic
   security and cache headers.

Do not set the publish directory to `dist`; there is no build output.

### Vercel

1. Import the repository in Vercel.
2. Set **Root Directory** to `sutra-website`.
3. Choose **Framework Preset: Other**.
4. Leave the build command empty and the output directory as `.`.
5. Deploy. [`vercel.json`](vercel.json) adds the same security and cache headers.

### Any other static host

Set the document root (publish directory) to `sutra-website` and upload the
folder's contents. No server-side runtime is required.

## Domain configuration

The site uses root-relative paths for all assets (`/styles.css`, `/og.png`, `/fonts/...`),
so it works on any domain without changes. When you deploy to a domain:

1. The Open Graph and Twitter images use `/og.png` (root-relative).
2. No canonical URLs are set — add `<link rel="canonical" href="https://your-domain.com/">` to each page if desired.
3. Update `robots.txt` with your sitemap URL if you create one.
4. For structured data, you may add `"url": "https://your-domain.com/"` to the `WebSite` and `SoftwareApplication` objects.

## Analytics

Analytics is off by default. To enable [Plausible](https://plausible.io), set
`PLAUSIBLE_DOMAIN` near the top of [`site.js`](site.js), for example:

```js
const PLAUSIBLE_DOMAIN = 'sutra.dev';
```

`site.js` then loads the Plausible script and sends these conversion events:

- `download-header`
- `download-mobile`
- `download-hero`
- `download-quickstart`
- `download-cta`
- `readme-cta`
- `github-header`

For a self-hosted Plausible instance, also set `PLAUSIBLE_SCRIPT_URL`.
Plausible records aggregate page views without cookies or cross-site tracking.

## SEO

The static pages include:

- Per-page titles, descriptions, canonical URLs and robots directives.
- Open Graph and Twitter Card metadata, using `og.png`.
- `SoftwareApplication`, `WebSite` and `FAQPage` structured data on the landing
  page, and `WebPage` on the privacy page.
- A hand-maintained `sitemap.xml` and a `robots.txt` that points to it.
- A web app manifest and SVG/PNG icons.
- Semantic headings, a skip link, reduced-motion support and a `404.html` page.

## Theme

The palette follows [`docs/brand.md`](../docs/brand.md) and the README banner:

| Token | Hex | Use |
| --- | --- | --- |
| Midnight | `#101923` | primary background |
| Saffron gold | `#F5B84B` | accent, mark, highlights |
| Ivory | `#F4F1E8` | foreground on midnight |
| Steel | `#9CAABA` | secondary text |
| Success | `#52B788` | pass states |
| Information | `#6CA8E8` | links and notes |
| Error | `#E76F6F` | failures |

The site defaults to the system theme and has a dark/light toggle. Typography is
Inter for text, JetBrains Mono for code, and Noto Sans Devanagari for सूत्र.
The font files are vendored in `fonts/` under their original OFL licences, so
the page makes no third-party font requests.

Brand assets in `brand/` are copied from the repository's [`assets/`](../assets)
folder. If the brand changes, update the copies here too.

## Structure

```
index.html          landing page
privacy/index.html  privacy note
404.html            not-found page
styles.css          the full theme and responsive layout
site.js             theme toggle, navigation, copy buttons, reveal, analytics
sitemap.xml         the two indexable pages
robots.txt          crawler rules and sitemap location
fonts/              vendored Inter, JetBrains Mono and Noto Sans Devanagari
brand/              logo, banner and social-card assets
netlify.toml        static publish, redirects, security and cache headers
vercel.json         security and cache headers
```

## Editing

- Page copy and links: edit the HTML files directly.
- Colours, spacing and layout: edit `styles.css`.
- Behaviour: edit `site.js`.

There is no generated markup or minification step, so what you edit is what the
host serves.

## License

The website is part of Sutra and is released under the Apache License 2.0.
