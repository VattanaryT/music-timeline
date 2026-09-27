# Music, through time

A public timeline of music history. Entries alternate on both sides of a
central spine. Each one has a date or date range (BCE supported, optional
"c."), a title, a description, links, and an optional image.

Anyone can view it. Only someone holding the editor token can add, edit or
delete entries.

## Stack

| Concern | Where it lives |
|---------|----------------|
| HTML/CSS/JS | `public/`, served by Netlify's CDN |
| API | Netlify Functions (`netlify/functions/`) |
| Entry data | Netlify Blobs store `music-data`, key `index` |
| Images | Netlify Blobs store `music-images` |

There are no other vendors, no database to pause, and no build step.

## Deploy

1. Create a Netlify site from this repo. It needs no build command; `netlify.toml` sets the publish dir.
2. Generate an editor token:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
3. In **Site configuration → Environment variables**, add `MUSIC_ADMIN_TOKEN` with that value.
   Mark it as a secret and scope it to **Functions** only.
4. Deploy. Open the site, click **editor** in the footer, and paste the token.

Keep the token in a password manager. It is never committed or shipped in the
site's code. If it leaks, change the env var and redeploy; every old session stops
working at once.

## Local dev

```bash
npm install
MUSIC_ADMIN_TOKEN="<any 32+ char string>" npm run dev   # http://localhost:8888
```

`scripts/dev.js` runs the real function handlers with a local Blobs store in
`.dev-blobs/` (gitignored). No Netlify account or CLI is needed.

## Security model

The site is public, so it assumes hostile visitors:

- **No secrets in the browser bundle.** Writes need `Authorization: Bearer <MUSIC_ADMIN_TOKEN>`.
  The server compares it in constant time, rejects tokens shorter than 32 characters,
  and waits before answering a bad guess. The token stays in `sessionStorage` for the
  current tab only.
- **No HTML injection.** Entries are rendered with `textContent` and never with `innerHTML`.
  A strict Content-Security-Policy (`script-src 'self'`, no inline scripts, no frames)
  backs that up.
- **Links** must be `http(s)` and can't carry credentials. This is checked on the server
  and again in the browser. They open with `rel="noopener noreferrer nofollow"`.
- **Uploads** are typed by their magic bytes, not the client's claim. Only JPEG, PNG,
  WebP and GIF are accepted (no SVG, which can hold script), up to 5 MB. Images are
  served with `nosniff` and a sandboxing CSP. The browser re-encodes photos before
  upload, which strips EXIF data such as GPS location.
- **Input limits** apply to every field and to the number of entries and links.
- **No CORS.** Other sites can't call the API from a visitor's browser.
- **Only `public/` is published**, so source files, `package.json` and scripts are not
  served.
- **Traffic cost:** `/api/entries` is cached at Netlify's CDN and purged on every write.
  Heavy public traffic doesn't run a function for each view.

## API

- `GET /api/entries`: all entries, sorted by date
- `GET /api/media?id=<key>`: image bytes
- `POST /api/session`: checks a token (auth)
- `POST /api/save`: create an entry, or update one when `id` is sent (multipart; auth).
  Fields are `title`, `year`, `end_year`, `circa`, `description`,
  `links` (a JSON array of `{label, url}`), `image`, `image_alt` and `remove_image`.
  Years are integers; BCE years are negative.
- `POST /api/delete`: JSON `{ id }` (auth)
