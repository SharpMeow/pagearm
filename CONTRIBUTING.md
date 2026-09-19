# Contributing to PageArm

Hey. Glad you are here.

Fork the repo. Make a branch. Open a pull request against `main`. That is the whole dance.

## A good PR

- Keep `scripts/wrap.mjs` boring. The interesting part lives in `agents/`.
- Host pattern changes need a new zip and an extension reload. Say so in the PR.
- American English. No em dashes. Warm comments.
- One zip per browser, each good on Mac, Windows, and Linux. Do not add a `.app`, an `.exe`, or a distro package.
- Chromium, Firefox, and Safari all matter. Shell code goes through the `api` shim, never `chrome.` directly.
- Do not add a store listing, analytics, or stealth claims.

```
npm run check
npm run pack
```

Both should pass before you ping me.

## License

The source is public so you can read it and send a PR. It is licensed under the PolyForm Small Business License 1.0.0. See `LICENSE`. Individuals and small businesses may use it. Larger companies need a separate license.
