# Bordo Web

Bordo's web app uses TanStack Start, React and TypeScript. It supports rich text, tags, attachments and offline editing.

## Features

- **Rich Text Editor** - Create and edit notes with a powerful Quill-based editor
- **Tags System** - Organize notes with custom tags and colors
- **Note Backgrounds** - Customize notes with solid colors and patterns
- **Pin Notes** - Pin important notes for quick access
- **Archive Notes** - Archive notes for later reference
- **Attachments** - Attach images and audio to notes with drag & drop
- **Import & Export** - Bring notes in from another Bordo instance or Google Keep and export your full library
- **Search** - Quickly find notes by title or content
- **Trash** - Soft delete notes with 30-day recovery period
- **Dark Mode** - Beautiful dark and light themes
- **Responsive Design** - Works seamlessly on desktop and mobile devices
- **Authentication** - Secure user authentication and session management
- **Admin Panel** - User management, registration control, and system statistics

## Tech Stack

- **Framework**: TanStack Start and TanStack Router
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **UI Components**: [shadcn/ui](https://ui.shadcn.com/) (Radix UI primitives)
- **State Management**: [Zustand](https://zustand-demo.pmnd.rs/)
- **Data Fetching**: [TanStack Query](https://tanstack.com/query)
- **HTTP Client**: [ky](https://github.com/sindresorhus/ky)
- **Rich Text Editor**: [react-quill-new](https://github.com/zenoamaro/react-quill)
- **Icons**: [Lucide React](https://lucide.dev/)
- **Date Formatting**: [date-fns](https://date-fns.org/)

## Getting Started

### Prerequisites

- Node.js 26, matching CI and Docker
- pnpm 12

### Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd bordo/web
```

2. Start the backend (required):
   Ensure you have a database and backend running. From the project root:

```bash
docker compose -f docker-compose.dev.yml up -d
```

3. Install dependencies:

```bash
pnpm install
```

3. Set up environment variables (optional):
   The Web server proxies API requests. For development, you can optionally set:

```bash
# Create .env.local if needed
```

Edit `.env.local` (if using a custom server URL):

```env
SERVER_URL=http://localhost:3001
```

**Note**: By default, the app proxies `/api/*` requests to `http://127.0.0.1:3001/api/*` through the Web server. The `SERVER_URL` environment variable is only needed if your backend runs on a different host/port.

4. Run the development server:

```bash
pnpm dev
```

5. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
web/
├── start/                   # TanStack routes and production server
├── app/                     # Page components
│   ├── (app)/               # Authenticated routes
│   │   ├── notes/           # Notes pages
│   │   ├── archive/         # Archive page
│   │   ├── trash/           # Trash page
│   │   └── admin/           # Admin page (if admin user)
│   └── (auth)/              # Authentication routes
│       ├── login/
│       └── register/
│
├── components/              # Shared UI components
│   ├── layout/              # App layout (header, sidebar)
│   └── ui/                  # shadcn/ui primitives
│
├── features/                # Feature modules (self-contained)
│   ├── auth/                # Authentication
│   │   ├── components/      # AuthGuard, GuestGuard
│   │   ├── hooks/           # useAuth hook
│   │   ├── api.ts           # API calls
│   │   ├── types.ts         # TypeScript types
│   │   └── store.ts         # Zustand store
│   ├── notes/               # Notes feature
│   │   ├── components/      # NoteCard, RichTextEditor, attachments, etc.
│   │   ├── hooks/           # useAttachmentBlob, useSelectionMode
│   │   ├── backgrounds/     # Background data & utils
│   │   ├── api.ts
│   │   ├── constants.ts    # Accepted MIME types, validation
│   │   ├── types.ts
│   │   └── quill.ts         # Editor utilities
│   ├── tags/                # Tags feature
│   │   ├── components/      # TagSelector
│   │   ├── api.ts
│   │   └── types.ts
│   └── import-export/       # Import personal backups and Google Keep, and export notes
│       ├── adapters/        # Format detection and mapping
│       ├── components/      # ImportDialog, DataCard
│       ├── hooks/           # useImport
│       ├── api.ts
│       └── types.ts
│
└── lib/                     # Shared utilities
    ├── api/                 # API client configuration
    └── utils.ts             # General utilities
```

## Environment Variables

| Variable     | Description                    | Default                 |
| ------------ | ------------------------------ | ----------------------- |
| `SERVER_URL` | Backend API and uploads origin | `http://127.0.0.1:3001` |

**Note**: The Web server forwards `/api/*` and `/uploads/*` requests to the backend. Client-side code makes requests to `/api/*` which are automatically rewritten to the backend. The `SERVER_URL` environment variable is only needed if your backend runs on a different host/port than the default.

## Development

### Adding a New Feature

1. Create a new folder in `features/[feature-name]/`
2. Add the following files:
   - `api.ts` - API calls
   - `types.ts` - TypeScript interfaces
   - `index.ts` - Public exports
3. Add `components/` folder for feature-specific UI
4. Add `store.ts` if state management is needed
5. Export everything through `index.ts`

### Linting & Formatting

This project uses [Biome](https://biomejs.dev/) for linting and formatting.

```bash
pnpm check       # lint + format + imports, read-only
pnpm check:fix   # fix everything (safe lint fixes + format + import sort)
```

### Testing

[Vitest](https://vitest.dev/) for unit tests. Co-locate test files next to the
code they cover as `*.test.ts` / `*.test.tsx`, with shared test data under a
`fixtures/` folder.

```bash
pnpm test        # run once
pnpm test:watch  # watch mode
```

### First-run tour

The notes overview offers a two-step tour. Start it, skip it, or dismiss it
with Escape. The browser remembers the choice for each account.

`vendor/react-sherpa-1.0.0.tgz` is the built package from
[React Sherpa commit `ed744f2`](https://github.com/bl4ckh4nd/react-sherpa/commit/ed744f22acd6026e281fff533f61933005bc8fb9).
To rebuild it, check out that commit in the React Sherpa repository and run
the following commands there. Replace the archive in `vendor/` and refresh
`pnpm-lock.yaml` from `web/` when updating the package.

```sh
HUSKY=0 pnpm install --frozen-lockfile --ignore-scripts
pnpm build
npm pack --ignore-scripts
```

With the local Convex fixture below running, use the same Playwright CLI
commands and replace `start/e2e/cutover.mjs` with
`start/e2e/first-run-tour.mjs` to check the tour at desktop and phone widths.

## Contributing

1. Create a feature branch
2. Make your changes
3. Ensure the build passes: `pnpm build`
4. Run linting: `pnpm check` (auto-fix with `pnpm check:fix`)
5. Submit a pull request

## Production

Build the client and server with `pnpm build` and run `pnpm start` from
`web`. Set `SERVER_URL` in the runtime environment to point at the API.
The Convex Docker release uses the same server with a Convex site origin.

To check the production build against a disposable Convex fixture, run
`convex-backend/e2e/local-compose-fixture.sh` with the local backend binary
and the following command from `web`:

```sh
bash ../convex-backend/e2e/local-compose-fixture.sh /path/to/convex-local-backend \
  bash -c 'SERVER_URL="$ANCHOR_COMPOSE_FIXTURE_URL" PORT=3972 HOSTNAME=127.0.0.1 pnpm start'
```

In another terminal from `web`:

```sh
playwright-cli -s=bordo-start open http://127.0.0.1:3972/
playwright-cli -s=bordo-start run-code --filename=start/e2e/cutover.mjs
playwright-cli -s=bordo-start close
```

The browser check covers sign-in, note creation, rich text autosave, reload,
readback through the Compose API, trash and restore. It creates a synthetic
account in the disposable backend.
