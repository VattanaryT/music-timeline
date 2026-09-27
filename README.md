# Music, through time

A public timeline of music history. Entries alternate on both sides of a
central spine. Each one has a date or date range (BCE supported, optional
"c."), a title, a description, links, and an optional image.

It's a plain static site on **GitHub Pages**, with no server. Anyone can view it.
Editing happens in the page itself: the editor signs in with a GitHub token, and
every save is a commit to this repo. Pages republishes about a minute later.

## Layout

| Path | What |
|------|------|
| `public/` | the whole website (only this folder is published) |
| `public/data/entries.json` | every entry |
| `public/media/` | uploaded images |
| `.github/workflows/pages.yml` | deploys `public/` on every push to `main` |

You can also edit `public/data/entries.json` by hand and push. Years are
integers, and BCE years are negative.

## Editing from the site

1. On GitHub, create a **fine-grained** personal access token under
   **Settings → Developer settings → Personal access tokens → Fine-grained tokens**:
   - Repository access: **Only select repositories → music-timeline**
   - Permissions: **Contents → Read and write** (nothing else)
   - Expiration: whatever you're comfortable with (e.g. 90 days)
2. Open the site, click **editor** in the footer, and paste the token.

The token stays in that browser tab's `sessionStorage` and is cleared when the tab
closes. It is never committed or written into the site's code. Classic tokens
(`ghp_…`) are refused because they can reach every repo on the account.

If a token leaks, revoke it on GitHub. It can only touch this one repo, and every
change it made is in the git history.

## Local preview

```bash
python3 -m http.server -d public 8000   # http://localhost:8000
```

Signing in locally commits to the real repo, just like the live site.

## Security model

The site is public, so it assumes hostile visitors:

- **Nobody can write without a token.** There's no server or password to
  attack, and GitHub enforces who can change the repo.
- **No HTML injection.** Entries are rendered with `textContent`, never with
  `innerHTML`. A strict Content-Security-Policy (`script-src 'self'`, no inline
  scripts, no frames) backs that up. Editing is disabled if the page is loaded
  inside a frame.
- **Links** must be `http(s)` and can't carry credentials. They open with
  `rel="noopener noreferrer nofollow"`.
- **Images** are typed by their bytes. Only JPEG, PNG, WebP and GIF are accepted
  (no SVG, which can hold script). The browser re-encodes photos before upload,
  which strips EXIF data such as GPS location, and the site only displays images
  from its own `media/` folder.
- **Only `public/` is published.**
- Deleted entries disappear from the site but remain in the git history.
