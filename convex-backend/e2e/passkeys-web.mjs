async (page) => {
  const origin = "http://localhost:3735";
  const accountName = "Web passkey fixture";
  const keyName = "Browser test key";
  const email = "web-passkey@example.test";
  const password = "PasskeyWebFixture2026!";
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  const created = await page.request.post(origin + "/api/auth/register", {
    data: { name: accountName, email, password },
  });
  if (created.status() !== 201) throw new Error("Fixture registration returned " + created.status());
  const expected = (await created.json()).user.id;

  async function clickAndCheck(path, button) {
    const [response] = await Promise.all([
      page.waitForResponse((response) =>
        response.url() === origin + "/api/auth/" + path && response.request().method() === "POST",
        { timeout: 25_000 }),
      button.click(),
    ]);
    if (!response.ok()) throw new Error(path + " returned " + response.status());
    return response;
  }

  await page.goto(origin + "/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await clickAndCheck("login", page.getByRole("button", { name: "Sign in", exact: true }));
  await page.waitForURL(origin + "/notes");
  await page.goto(origin + "/settings");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a passkey" });
  await dialog.getByLabel("Name", { exact: true }).fill(keyName);
  await clickAndCheck("passkeys/register/verify", dialog.getByRole("button", { name: "Continue" }));
  await page.getByText(keyName, { exact: true }).waitFor();
  await page.reload();
  await page.getByText(keyName, { exact: true }).waitFor();

  const accountMenu = page.getByRole("button", { name: /Web passkey fixture/ });
  await accountMenu.click();
  await clickAndCheck("logout", page.getByRole("menuitem", { name: "Sign out" }));
  await page.waitForURL(origin + "/login");
  const response = await clickAndCheck("passkeys/login/verify", page.getByRole("button", { name: "Sign in with a passkey" }));
  if ((await response.json()).user.id !== expected) throw new Error("Passkey signed in to another account");
  await page.waitForURL(origin + "/notes");
  await accountMenu.waitFor();

  return { passkeyEnrollmentThroughSettings: true, passkeyListedAfterReload: true,
    passwordlessBrowserSignIn: true, sameAccount: true };
}
