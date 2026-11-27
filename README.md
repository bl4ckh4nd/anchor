<div align="center">

<img src="web/public/icon0.svg" alt="Bordo" width="120" height="120">

# Bordo

Offline-first notes for web, mobile and Chrome.

</div>

Bordo is a self-hostable notes app with rich text, tags, checklists, attachments
and reminders. Keep working offline and sync when you reconnect. Share
individual notes with an editor or viewer, and use version history to recover
earlier edits.

## Get started

- **Web and server.** [Host Bordo with Docker Compose](docs/hosting.md).
  The Web app uses TanStack Start. The backend runs Convex with Effect and PostgreSQL.
- **Android and iOS.** [Build the mobile app](mobile-kotlin/README.md).
  The mobile clients use Kotlin and Compose Multiplatform.
- **Chrome.** [Load the Bordo extension](#bordo-for-chrome) to save a page,
  selected text or an image from the browser.
- **Existing libraries.** [Import a personal ZIP backup](docs/backups.md) or
  [migrate an entire self-hosted server](docs/hosting.md#import-notes-and-accounts-into-convex).

## Bordo for Chrome

Open `chrome://extensions` in Chrome 127 or later. Enable **Developer mode**,
choose **Load unpacked** and select [`chrome-extension/`](chrome-extension/).

Enter your server address and choose **Continue** to confirm the connection
in Bordo. If your server version predates browser pairing, use **Connect
with an API token** and a token from your Bordo account settings.

Open the popup to capture the current page. Use the right-click menu for
selected text or images, or open the side panel to collect multiple clips
in one note. Before saving, review the draft, choose a tag and check the
destination server shown beside **Save note**.

## Development

- [Contributing](.github/CONTRIBUTING.md)
- [Web development](web/README.md)
- [Mobile development](mobile-kotlin/README.md)
- [HTTP and sync contracts](MIGRATION-API.md)
- [Bordo issues](https://github.com/bl4ckh4nd/bordo/issues)
- [Security policy](.github/SECURITY.md)

## License and credits

Bordo is licensed under the [GNU Affero General Public License v3.0](LICENSE).
The original project was created by [ZhFahim](https://github.com/ZhFahim).
