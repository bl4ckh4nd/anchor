async (page) => {
  const origin = await page.evaluate(() => location.origin);
  const email = `legacy-backup-${Date.now()}@example.test`;
  const password = "BackupFixture2026!";
  const account = await page.request.post(origin + "/api/auth/register", {
    data: { name: "Backup restore fixture", email, password },
  });
  if (account.status() !== 201) throw new Error(`Registration: ${account.status()}`);
  const session = await account.json();
  const headers = { Authorization: `Bearer ${session.access_token}` };

  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(origin + "/notes");
  await page.goto(origin + "/settings");

  const dialog = page.getByRole("dialog", { name: "Import notes" });
  async function chooseBackup() {
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await dialog.locator('input[type="file"]').setInputFiles("legacy-backup.zip");
    const skip = dialog.getByRole("checkbox", { name: "Skip notes that already exist" });
    await skip.check();
    await dialog.getByRole("button", { name: "Import 1 note", exact: true }).click();
  }
  await chooseBackup();
  await dialog.getByText("1 note imported", { exact: true }).waitFor();
  await dialog.getByText("1 attachments uploaded", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Done" }).click();
  await chooseBackup();
  await dialog.getByText("0 notes imported", { exact: true }).waitFor();

  const library = await page.request.get(origin + "/api/notes", { headers });
  if (!library.ok()) throw new Error(`Library: ${library.status()}`);
  const notes = await library.json();
  if (notes.length !== 1 || notes[0].title !== "Existing note") {
    throw new Error("Expected a single copy of the legacy note");
  }
  const noteUrl = origin + "/api/notes/" + notes[0].id;
  const noteResponse = await page.request.get(noteUrl, { headers });
  const note = await noteResponse.json();
  if (JSON.parse(note.content).ops[0].insert !== "Before cutover\n") {
    throw new Error("The Quill content changed");
  }
  const files = await page.request.get(noteUrl + "/attachments", { headers });
  const attachments = await files.json();
  if (attachments.length !== 1 || attachments[0].originalFilename !== "Cutover.wav") {
    throw new Error("Expected a single copy of the legacy attachment");
  }
  const response = await page.request.get(noteUrl + "/attachments/" + attachments[0].id, { headers });
  if (!response.ok()) throw new Error(`Attachment: ${response.status()}`);
  const sha256 = await page.evaluate(async (bytes) => {
    const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }, [...await response.body()]);
  const exchange = await page.request.post(origin + "/api/auth/convex-token", { headers });
  if (!exchange.ok()) throw new Error(`Token exchange: ${exchange.status()}`);
  const sync = await page.request.post(origin + "/api/compose/sync", {
    headers: { Authorization: `Bearer ${(await exchange.json()).token}` },
    data: {},
  });
  if (!sync.ok()) throw new Error(`Compose sync: ${sync.status()}`);
  const entries = (await sync.json()).entries;
  if (!entries.some((entry) => entry.note?.id === note.id && entry.note?.content === note.content)) {
    throw new Error("The imported note was missing from the Compose snapshot");
  }
  const cleanup = session.user?.isAdmin === false;
  if (cleanup) {
    const deleted = await page.request.post(origin + "/api/auth/delete-account", { headers, data: { password } });
    if (!deleted.ok()) throw new Error(`Fixture account cleanup: ${deleted.status()}`);
  }
  return { legacyZipImportedInBrowser: true, quillPreserved: true, duplicateSkipped: true, composeSync: true, fixtureAccountDeleted: cleanup, sha256 };
}
