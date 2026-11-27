async (page) => {
	const origin = new URL(page.url()).origin;
	if (!origin.startsWith("http://127.0.0.1:"))
		throw new Error("Use an isolated local fixture");
	const email = "clipper-browser-" + Date.now() + "@example.test";
	const password = "SyntheticClipper2026!";
	const registered = await page.request.post(origin + "/api/auth/register", {
		data: { name: "Clipboard fixture", email, password },
	});
	if (registered.status() !== 201)
		throw new Error("Fixture registration failed");
	const web = await registered.json();
	const headers = { Authorization: "Bearer " + web.access_token };
	const context = page.context();
	const base = "chrome-extension://lpangogfgpboibjoafampidakcimppck";
	const popup = await context.newPage();
	await popup.goto(base + "/clip.html");
	await popup.getByLabel("Server address").fill(origin);
	const authWindow = context.waitForEvent("page", {
		predicate: (tab) => tab !== popup,
		timeout: 8000,
	});
	await popup.getByRole("button", { name: "Continue", exact: true }).click();
	let popupAuth;
	let loginStatus;
	try {
		popupAuth = await authWindow;
		await popupAuth
			.getByLabel("Email", { exact: true })
			.fill(email, { timeout: 10000 });
		const loginUrl = new URL(popupAuth.url());
		if (
			!loginUrl.searchParams.get("returnTo")?.startsWith("/clipper-connect/")
		) {
			throw new Error("Missing return path in sign-in URL");
		}
		await popupAuth.getByLabel("Password", { exact: true }).fill(password);
		const login = popupAuth.waitForResponse(
			(response) => response.url() === origin + "/api/auth/login",
		);
		await popupAuth
			.getByRole("button", { name: "Sign in", exact: true })
			.click();
		loginStatus = (await login).status();
		await popupAuth
			.getByRole("button", { name: "Connect extension", exact: true })
			.click({ timeout: 9000 });
	} catch (error) {
		const location = popupAuth && new URL(popupAuth.url()).pathname;
		const screenText = await popupAuth
			?.locator("body")
			.innerText({ timeout: 1000 })
			.catch(() => "");
		throw new Error(
			"Chrome browser sign-in did not reach consent: " +
				error.message +
				" | " +
				location +
				" | login " +
				loginStatus +
				" | " +
				screenText?.slice(0, 400),
		);
	}
	await popup.getByLabel("Note title").waitFor({ timeout: 15000 });
	await page.setContent(
		"<p id='sample'>A real selection from the active browser tab.</p>",
	);
	await page.bringToFront();
	await page
		.locator("#sample")
		.evaluate((paragraph) => getSelection().selectAllChildren(paragraph));
	await popup.evaluate(async () => {
		await chrome.runtime.sendMessage({ type: "new" });
		return chrome.runtime.sendMessage({ type: "init", panel: false });
	});
	await popup
		.getByText("A real selection from the active browser tab.", { exact: true })
		.waitFor();
	await popup.bringToFront();
	await popup
		.getByLabel("Note title")
		.fill("Bordo browser clip", { timeout: 15000 });
	await popup.getByLabel("Note text").fill("Some content kept in the draft.");
	await popup.getByRole("button", { name: /Link/ }).first().click();
	await popup.getByLabel("Web address").fill("https://example.test/reading");
	await popup.getByRole("button", { name: "Add link", exact: true }).click();
	await popup.getByRole("button", { name: /Tag/ }).first().click();
	await popup.getByLabel("Find a tag").fill("Reading");
	await popup.getByRole("button", { name: /Create.*Reading/ }).click();
	const priorTags = await (
		await page.request.get(origin + "/api/tags", { headers })
	).json();
	if (priorTags.length) throw new Error("Draft tag was sent before save");

	const image = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2xoAAAAASUVORK5CYII=",
		"base64",
	);
	await popup
		.locator("#file")
		.setInputFiles({ name: "Clip.png", mimeType: "image/png", buffer: image });
	await popup.getByRole("button", { name: "Remove Clip.png" }).waitFor();
	await popup.locator("body").screenshot({ path: "popup.png" });
	await popup.bringToFront();
	await popup.getByRole("button", { name: "Open side panel" }).click();
	await popup.waitForFunction(
		async () => {
			const contexts = await chrome.runtime.getContexts({
				contextTypes: ["SIDE_PANEL"],
			});
			return contexts.length === 1;
		},
		undefined,
		{ timeout: 5000 },
	);
	await context.setOffline(true);
	await popup.getByText(/You’re offline/).waitFor();
	if (!(await popup.getByRole("button", { name: /Save note/ }).isDisabled()))
		throw new Error("Offline save was enabled");
	await popup.reload();
	if (
		(await popup.getByLabel("Note text").inputValue()) !==
		"Some content kept in the draft."
	)
		throw new Error("Draft did not survive reload");
	await context.setOffline(false);
	const panel = await context.newPage();
	await panel.goto(base + "/clip.html?panel");
	await panel.getByRole("heading", { name: "Collect clips" }).waitFor();
	if (
		(await panel.getByLabel("Note title").inputValue()) !== "Bordo browser clip"
	)
		throw new Error("Panel draft did not match popup");
	await panel.getByRole("button", { name: /Save note/ }).click();
	await popup.getByRole("heading", { name: "Note saved" }).waitFor();
	const notes = await (
		await page.request.get(origin + "/api/notes", { headers })
	).json();
	const note = notes.find((entry) => entry.title === "Bordo browser clip");
	if (
		!note ||
		!note.content.includes("https://example.test/reading") ||
		note.tagIds.length !== 1
	) {
		throw new Error("Saved note is missing its source or tag");
	}
	if (!note.content.includes("A real selection from the active browser tab."))
		throw new Error("Selected text was lost");
	const attachments = await (
		await page.request.get(origin + "/api/notes/" + note.id + "/attachments", {
			headers,
		})
	).json();
	const bytes = await (
		await page.request.get(
			origin + "/api/notes/" + note.id + "/attachments/" + attachments[0].id,
			{ headers },
		)
	).body();
	if (attachments.length !== 1 || !bytes.equals(image))
		throw new Error("Clipped image bytes changed");
	await panel.close();
	await popup.close();
	return {
		chromeSignIn: true,
		nativeSidePanelOpened: true,
		activeTabSelectionCaptured: true,
		offlineDraftSurvived: true,
		popupAndPanelSharedDraft: true,
		noteCreated: true,
		tagApplied: true,
		sourceSaved: true,
		attachmentByteMatch: true,
	};
}
