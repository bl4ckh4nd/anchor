async (page) => {
  const origin = "http://127.0.0.1:3735";
  const provider = "https://host.containers.internal:3742/authorize";
  const isApi = (response, path, method) =>
    response.url() === origin + path && response.request().method() === method;
  let providerVisited = false;
  let providerCallbackVisited = false;
  let tokenInNavigation = false;
  page.on("request", (request) => {
    if (!request.isNavigationRequest()) return;
    const url = request.url();
    providerVisited ||= url.startsWith(provider + "?");
    providerCallbackVisited ||= url.startsWith(origin + "/api/auth/oidc/callback?");
    tokenInNavigation ||= /[?&](access_token|refresh_token)=/.test(url);
  });
  await page.goto(origin + "/login?returnTo=%2Fnotes");
  const [exchange] = await Promise.all([
    page.waitForResponse((response) => isApi(response, "/api/auth/oidc/exchange", "POST"), { timeout: 25_000 }),
    page.getByRole("button", { name: "Continue with Fixture SSO" }).click(),
  ]);
  if (!exchange.ok()) throw new Error("OIDC exchange returned " + exchange.status());
  const credentials = await exchange.json();
  if (credentials.redirectUrl !== "/notes") throw new Error("The validated return path was lost");
  await page.waitForURL(origin + "/notes");
  const account = page.getByRole("button", { name: /OIDC fixture/ });
  await account.waitFor();
  if (!providerVisited || !providerCallbackVisited || tokenInNavigation)
    throw new Error("Unexpected OIDC navigation");

  await page.reload();
  await account.waitFor();
  const headers = { Authorization: "Bearer " + credentials.access_token };
  const me = await page.request.get(origin + "/api/auth/me", { headers });
  if (!me.ok() || (await me.json()).id !== credentials.user.id)
    throw new Error("The provider account did not survive reload");

  await account.click();
  const [logout] = await Promise.all([
    page.waitForResponse((response) => isApi(response, "/api/auth/logout", "POST")),
    page.getByRole("menuitem", { name: "Sign out" }).click(),
  ]);
  if (!logout.ok()) throw new Error("Logout returned " + logout.status());
  await page.waitForURL(origin + "/login");
  const revoked = await page.request.get(origin + "/api/auth/me", { headers });
  if (revoked.status() !== 401) throw new Error("The previous session still grants access");
  return { providerButton: true, providerNavigation: true, callbackOnReleaseOrigin: true,
    returnedToNotes: true, noTokensInNavigation: true, persistedAfterReload: true, logoutRevokedSession: true };
}
