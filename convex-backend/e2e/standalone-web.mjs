async (page) => {
  const origin = await page.evaluate(() => location.origin);
  const email = `standalone-${Date.now()}@example.test`;
  const password = "StandaloneFixture2026";
  const capabilities = await page.request.get(origin + "/api/auth/capabilities");
  if (!capabilities.ok()) throw new Error(`Auth capabilities returned ${capabilities.status()}`);
  const factors = await capabilities.json();
  if (factors.totp !== false || factors.passkeys !== false) {
    throw new Error("The fixture should advertise neither two-factor method");
  }
  const account = await page.request.post(origin + "/api/auth/register", {
    data: { name: "Standalone fixture", email, password },
  });
  if (account.status() !== 201) throw new Error(`Registration returned ${account.status()}`);
  const session = (await account.json()).access_token;
  const exchange = await page.request.post(origin + "/api/auth/convex-token", {
    headers: { Authorization: `Bearer ${session}` },
  });
  if (!exchange.ok()) throw new Error(`Token exchange returned ${exchange.status()}`);
  const headers = { Authorization: `Bearer ${(await exchange.json()).token}` };

  await page.goto(origin + "/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(origin + "/notes");

  await page.locator('[data-new-note="sidebar"]:visible').first().click();
  const title = page.getByLabel("Title", { exact: true });
  const matchesWrite = (method, path) => (response) =>
    response.request().method() === method && response.url() === origin + path;
  const creating = page.waitForResponse(matchesWrite("POST", "/api/notes"));
  await title.fill("Standalone browser note");
  const created = await creating;
  if (created.status() !== 201) throw new Error(`Web create returned ${created.status()}`);
  const { id } = await created.json();
  await page.waitForURL(`${origin}/notes/${id}`);

  const editor = page.locator(".ql-editor[contenteditable=true]");
  const body = "Standalone Convex autosave";
  const saving = page.waitForResponse(matchesWrite("PATCH", "/api/notes/" + id));
  await editor.click();
  await page.keyboard.insertText(body);
  const saved = await saving;
  if (!saved.ok()) throw new Error(`Autosave returned ${saved.status()}`);
  await page.reload();
  await editor.getByText(body, { exact: true }).waitFor();

  const pull = await page.request.post(origin + "/api/compose/sync", { data: {}, headers });
  if (!pull.ok()) throw new Error(`Compose pull returned ${pull.status()}`);
  const snapshot = await pull.json();
  const browserNote = snapshot.entries.find((entry) => entry.note?.id === id)?.note;
  if (!browserNote?.content?.replace(/[\u00a0\u202f]/g, " ").includes(body)) {
    throw new Error("Compose did not receive the Web edit");
  }

  const composeId = await page.evaluate(() => crypto.randomUUID());
  const writing = await page.request.post(origin + "/api/compose/notes", {
    headers,
    data: { id: composeId, title: "Standalone Compose note" },
  });
  if (writing.status() !== 200 || (await writing.json()).id !== composeId) {
    throw new Error(`Compose create did not return the client-supplied ID (${writing.status()})`);
  }
  await page.goto(origin + "/notes");
  await page.getByText("Standalone Compose note", { exact: true }).waitFor();
  return {
    authCapabilities: true, browserSignIn: true, quillAutosaveAfterReload: true,
    composeSawWebEdit: true, webSawComposeNote: true,
  };
}
