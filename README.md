# openbee WeChat channel

WeChat (微信) channel for openbee, built on [`@theopenbee/channel-sdk`](https://www.npmjs.com/package/@theopenbee/channel-sdk). It replaces the WeChat channel that used to be built into openbee and keeps its config, session keys and stored conversations.

## Behaviour

- Logs in with a QR code, from the plugin page in the desktop app or the web console, or with `openbee plugin configure weixin` in the terminal. Scan it with WeChat and confirm on the phone; if WeChat shows a number, type it in. The token is saved in the plugin settings.
- Long polling, so openbee needs no public address. The sync cursor is kept in the plugin data directory, so a restart continues where it stopped.
- Handles one-on-one chats with the bot; group messages are ignored. One openbee session per user (`weixin:<user_id>:<user_id>`), the same keys the built-in channel used.
- Text, pictures, voice messages, files and videos up to `max_media_size` bytes are downloaded and decrypted into openbee's media directory. Voice messages are converted from SILK to WAV, and WeChat's transcript becomes the message text.
- A typing indicator is shown when a message arrives.
- Replies longer than 4000 characters are split, preferring line breaks. Text is sent first, then the file. Pictures (`.jpg` `.png` `.gif` `.webp` `.bmp`) and videos (`.mp4` `.mov` `.webm`…) are sent as such, anything else as a file.
- WeChat accepts at most 10 bot messages after each message from the user, scheduled results and split parts included. Further sends fail with `ret=-2 errmsg=prepare failed` until the user writes again.
- When WeChat reports the login as expired, polling pauses for an hour. Log in again from the plugin page or with `openbee plugin configure weixin` to get a new token.
- HTTP proxy variables are not used.

## Install

Install it from **Settings → Plugins → Marketplace**, or run:

```sh
openbee plugin install @theopenbee/channel-weixin
```

Or from a local checkout:

```sh
git clone https://github.com/theopenbee/channel-weixin.git
cd channel-weixin
npm install
openbee plugin install "$(pwd)"
```

Then log in with the **WeChat QR code login** on the plugin page, or run `openbee plugin configure weixin` and scan the code in the terminal, and enable the plugin. Setup guide: https://theopenbee.com/docs/chat-apps/weixin/

Settings, also accepted as `openbee plugin configure weixin --set key=value`:

| Key | Default | |
|---|---|---|
| `token` | | Bot token, filled in by the QR code login. Required. |
| `base_url` | `https://ilinkai.weixin.qq.com` | API server, filled in by the QR code login. |
| `cdn_base_url` | `https://novac2c.cdn.weixin.qq.com/c2c` | CDN for pictures, voice, videos and files. |
| `route_tag` | empty | Sent as the `SKRouteTag` header when set. |
| `max_media_size` | `104857600` | Largest attachment, in bytes, downloaded or sent. |

The login step can also be run by hand; it prints the result as JSON on stdout:

```sh
node dist/setup.js
```

## Development

```sh
npm install
npm test
```

`npm install` also builds `dist/`; run `npm run build` after changing `src/`. The tests run offline against a local fake of the WeChat APIs.
