# Contributing to PageArm

Hey. Glad you are here.

Fork the repo. Make a branch. Open a pull request against `main`. That is the whole dance.

## A good PR

- Keep `scripts/wrap.mjs` boring. The interesting part lives in `agents/`.
- Host pattern changes need a new zip and an extension Reload. Say so in the PR.
- American English. No em dashes. Warm comments.
- One zip for Mac, Windows, and Linux. Do not add a `.app`, an `.exe`, or a distro package.
- Chrome, Edge, Brave, Chromium. Not Safari. Not Firefox.
- Do not add a Store listing, analytics, or stealth claims.

```
npm run check
npm run pack
```

Both should pass before you ping me.

## License

The source is public so you can read it and send a PR. It is licensed under the Business Source License 1.1. See `LICENSE`. Use it yourself. Do not flip this into a Store clone or a competing product.
