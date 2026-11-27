async function _checkFirstRunTour(page) {
  const base = new URL(page.url()).origin;
  if (!base.startsWith("http://127.0.0.1:"))
    throw new Error("Use an isolated local fixture");
  const password = "SyntheticBordoTour2026!";
  async function signIn(tab, name) {
    const email = `tour-${Date.now()}-${name}@example.test`;
    const registration = await tab.request.post(`${base}/api/auth/register`, {
      data: { email, password, name },
    });
    if (registration.status() !== 201)
      throw new Error("Fixture registration failed");
    await tab.goto(`${base}/login`);
    await tab.getByLabel("Email", { exact: true }).fill(email);
    await tab.getByLabel("Password", { exact: true }).fill(password);
    await tab.getByRole("button", { name: "Sign in", exact: true }).click();
    await tab.waitForURL(`${base}/notes`);
  }

  async function expectTourDismissed() {
    await page.reload();
    await page.getByRole("heading", { name: "No notes yet" }).waitFor();
    await page
      .getByRole("heading", { name: "Get started with Bordo" })
      .waitFor({ state: "hidden" });
    const seen = await page.evaluate(() => {
      const { state } = JSON.parse(localStorage.getItem("auth-storage"));
      return localStorage.getItem(`bordo:notes-tour:v1:${state.user.id}`);
    });
    if (seen !== "seen")
      throw new Error(
        "Tour preference was not saved for the signed-in account",
      );
  }

  async function signOut() {
    await page.evaluate(() => {
      for (const key of ["access_token", "refresh_token", "auth-storage"])
        localStorage.removeItem(key);
    });
  }

  async function expectTourInViewport() {
    const box = await tour.boundingBox();
    const { width, height } = page.viewportSize();
    if (
      !box ||
      box.x < 0 ||
      box.y < 0 ||
      box.x + box.width > width ||
      box.y + box.height > height
    ) {
      throw new Error(
        `Tour extends outside the viewport: ${JSON.stringify(box)}`,
      );
    }
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, "desktop");
  await page.getByRole("heading", { name: "Get started with Bordo" }).waitFor();
  await page.getByRole("button", { name: "Start tour" }).click();
  const tour = page.getByRole("alertdialog");
  await tour.getByRole("heading", { name: "Create a note" }).waitFor();
  await expectTourInViewport();
  await page.screenshot({ path: "bordo-tour-desktop.png" });
  await tour.getByRole("button", { name: "Next" }).click();
  await tour.getByRole("heading", { name: "Organize with tags" }).waitFor();
  await expectTourInViewport();
  await tour.getByRole("button", { name: "Back" }).click();
  await tour.getByRole("heading", { name: "Create a note" }).waitFor();
  await tour.getByRole("button", { name: "Next" }).click();
  await tour.getByRole("button", { name: "Done" }).click();
  await tour.waitFor({ state: "hidden" });
  await expectTourDismissed();

  await signOut();
  await page.setViewportSize({ width: 390, height: 780 });
  await signIn(page, "phone");
  await page.getByRole("button", { name: "Start tour" }).click();
  await tour.getByRole("heading", { name: "Create a note" }).waitFor();
  await expectTourInViewport();
  await page.screenshot({ path: "bordo-tour-mobile.png" });
  await tour.getByRole("button", { name: "Next" }).click();
  await tour.getByText(/Use the menu/).waitFor();
  await expectTourInViewport();
  await page.keyboard.press("Escape");
  await tour.waitFor({ state: "hidden" });
  await expectTourDismissed();

  await signOut();
  await signIn(page, "skip");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expectTourDismissed();

  await signOut();
  await signIn(page, "skip-step");
  await page.getByRole("button", { name: "Start tour" }).click();
  await tour.getByRole("button", { name: "Skip tour" }).click();
  await tour.waitFor({ state: "hidden" });
  await expectTourDismissed();

  return {
    desktopTour: true,
    mobileTour: true,
    completePersists: true,
    escapedPersists: true,
    skipPersists: true,
    inTourSkipPersists: true,
    isolatedAccounts: true,
  };
}
