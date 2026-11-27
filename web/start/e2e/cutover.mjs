async function _checkStartCutover(page) {
  const base = await page.evaluate(() => location.origin);
  const verify = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  verify(base.startsWith("http://127.0.0.1:"), "Expected a loopback fixture");
  const html = await page.request.get(base);
  const document = await html.text();
  verify(
    html.ok() && document.includes("Loading Bordo"),
    "Missing Start document",
  );
  verify(
    !document.includes("/_next/"),
    "Next.js assets are still in the document",
  );

  const manifest = await page.request.get(`${base}/manifest.json`);
  verify(
    manifest.ok() && (await manifest.json()).name === "Bordo",
    "Missing PWA manifest",
  );
  const icon = await page.request.get(`${base}/apple-icon.png`);
  verify(
    icon.ok() && icon.headers()["content-type"].includes("image/png"),
    "Missing app icon",
  );

  const email = `start-${Date.now()}@example.test`;
  const password = "SyntheticStartCutover2026!";
  const registered = await page.request.post(`${base}/api/auth/register`, {
    data: { email, password, name: "TanStack Start fixture" },
  });
  verify(
    registered.status() === 201,
    `Registration returned ${registered.status()}`,
  );
  const { access_token } = await registered.json();

  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/notes/new?search=1`);
  await page.waitForURL((url) => url.pathname === "/login");
  verify(
    (await page.evaluate(() =>
      new URLSearchParams(location.search).get("returnTo"),
    )) === "/notes/new?search=1",
    "Direct note URL was not preserved on the sign-in redirect",
  );
  await page.goto(base);
  await page.waitForURL(`${base}/login`);
  await page.getByRole("heading", { name: "Welcome back" }).waitFor();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${base}/notes`);
  await page.getByRole("heading", { name: "Notes", exact: true }).waitFor();

  await page.locator('[data-new-note="sidebar"]:visible').first().click();
  await page.waitForURL(`${base}/notes/new`);
  const title = page.getByLabel("Title", { exact: true });
  const create = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url() === `${base}/api/notes`,
  );
  await title.fill("TanStack Start browser fixture");
  const created = await create;
  verify(
    created.status() === 201,
    `Note creation returned ${created.status()}`,
  );
  const { id } = await created.json();
  await page.waitForURL(`${base}/notes/${id}`);

  const body = "Web edit visible to Compose";
  const editor = page.getByRole("textbox", { name: "Note text", exact: true });
  const save = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" && r.url() === `${base}/api/notes/${id}`,
  );
  await editor.click();
  await page.keyboard.insertText(body);
  verify((await save).ok(), "Web autosave failed");
  await page.reload();
  await editor.getByText(body, { exact: true }).waitFor();
  verify(
    (await title.inputValue()) === "TanStack Start browser fixture",
    "Title was lost",
  );

  const pull = await page.request.post(`${base}/api/compose/sync`, {
    headers: { Authorization: `Bearer ${access_token}` },
    data: {},
  });
  verify(pull.ok(), `Compose sync returned ${pull.status()}`);
  const note = (await pull.json()).entries.find(
    (entry) => entry.note?.id === id,
  )?.note;
  verify(
    note?.content?.replace(/[\u00a0\u202f]/g, " ").includes(body),
    "Compose did not see the Web edit",
  );

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Move to trash", exact: true })
    .click();
  await page.waitForURL(`${base}/notes`);
  await page.goto(`${base}/trash`);
  await page
    .getByText("TanStack Start browser fixture", { exact: true })
    .waitFor();
  const restore = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url() === `${base}/api/notes/${id}/restore`,
  );
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  verify((await restore).ok(), "Note restore failed");
  await page.goto(`${base}/notes`);
  await page
    .getByText("TanStack Start browser fixture", { exact: true })
    .waitFor();
  await page.goto(`${base}/notes?q=%22literal%22`);
  const search = page.getByPlaceholder("Search notes");
  verify(
    (await search.inputValue()) === '"literal"',
    "Routing changed the search text",
  );
  await search.fill('{"literal":true}');
  await page.waitForURL(
    (url) => url.searchParams.get("q") === '{"literal":true}',
  );
  await page.reload();
  verify(
    (await search.inputValue()) === '{"literal":true}',
    "Reload changed the search text",
  );
  return {
    result: "pass",
    checks: [
      "SSR",
      "PWA assets",
      "login and return URL",
      "Quill autosave",
      "Compose sync",
      "trash and restore",
      "literal search URLs",
    ],
  };
}
