# create-appflare

## 0.1.1

### Patch Changes

- bbbe11d: The Usage data page in Settings is now called Anonymous report, at `/settings/anonymous-report`. Its switch reads **Send the anonymous report**. Bookmarks and links to the old address, `/settings/usage-data`, still open it, at the same section. The installer's README names the new page.

## 0.1.0

### Minor Changes

- 346d608: The first public release of the Appflare installer. `npx create-appflare` checks your Cloudflare login, picks the account, downloads the latest signed Appflare release, verifies it and deploys it, then prints the address where you finish setup. `npx create-appflare recover` lets whoever controls the Cloudflare account get an admin back in after a forgotten password.
