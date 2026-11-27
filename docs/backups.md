# Back up or move your Bordo library

Log into your Bordo server, go to **Settings**, scroll to **Import and export**, click **Export** and choose the ZIP backup option.

The downloaded ZIP contains:

- `manifest.json` which includes the backup metadata, tags, notes, and attachment references in plain text
- the referenced attachments, stored within the `attachments` folder structure

To restore, go to the same section, click **Import** and pick that file. Import also takes Google Keep exports and Markdown files from Obsidian and Nextcloud Notes.

## Move your notes to a new Bordo server

1. Sync every device with the old server before exporting. Wait for pending notes and attachments to finish uploading.
2. In the old web app, export the personal ZIP backup. Keep the ZIP unchanged until you have verified the new library.
3. Sign into your account on the new server. Open **Settings → Import and export → Import** and choose the ZIP. Check the preview and keep the tab open until the import report appears. Use **Skip notes that already exist** when importing an archive into a library that already contains its notes.
4. Review the import report and open your restored notes and attachments before changing the server address on mobile.

Personal backups carry note content, tags, pinning, archives, trash,
reminders and the attachments present in the ZIP. Shared notes become
copies in your new library. Accounts, sharing permissions and version
history are carried by the [server migration](hosting.md#import-notes-and-accounts-into-convex).
If a connection drops during import, use **Try again** in the open dialog.
Review any attachment errors before closing the dialog. Importing the
ZIP again with **Skip notes that already exist** skips the entire
matching note, including its attachments.
