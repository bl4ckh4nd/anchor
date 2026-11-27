const MAX_IMAGE = 3 * 1024 * 1024;
const MAX_DRAFT_IMAGES = 5 * 1024 * 1024;
const MIME_TYPES = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};
const MENUS = [
	{
		id: "selection",
		title: "Add selection to Bordo note",
		contexts: ["selection"],
	},
	{ id: "image", title: "Add image to Bordo note", contexts: ["image"] },
	{ id: "page", title: "Add page to Bordo note", contexts: ["page"] },
];

function webUrl(value) {
	try {
		const url = new URL(value);
		return ["https:", "http:"].includes(url.protocol) &&
			!url.username &&
			!url.password
			? url.href
			: "";
	} catch {
		return "";
	}
}

function serverOrigin(value) {
	const url = new URL(value.includes("://") ? value : "https://" + value);
	if (
		!webUrl(url.href) ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		(url.protocol === "http:" &&
			!["localhost", "127.0.0.1"].includes(url.hostname))
	) {
		throw new Error(
			"Enter a Bordo server address. Use HTTPS for remote servers.",
		);
	}
	return url.origin;
}

function emptyDraft() {
	return {
		id: crypto.randomUUID(),
		title: "",
		text: "",
		sources: [],
		quotes: [],
		images: [],
		tags: [],
		initialized: false,
	};
}

async function state() {
	return chrome.storage.local.get([
		"connection",
		"draft",
		"saved",
		"pendingOrigin",
	]);
}

async function saveDraft(draft) {
	await chrome.storage.local.set({ draft });
	return draft;
}

let tail = Promise.resolve();
function serial(operation) {
	const result = tail.then(operation);
	tail = result.catch(() => {});
	return result;
}

// The injected functions run in the tab's isolated world.
async function readImage(url, maxBytes) {
	const response = await fetch(url, {
		credentials: "same-origin",
		signal: AbortSignal.timeout(8000),
	});
	if (
		!response.ok ||
		!response.body ||
		Number(response.headers.get("content-length")) > maxBytes
	)
		return null;
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > maxBytes) return null;
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const blob = new Blob(chunks, {
		type: response.headers.get("content-type")?.split(";")[0],
	});
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () =>
			resolve({ data: reader.result, size, mime: blob.type });
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}

async function request(origin, path, { token, method = "GET", body } = {}) {
	const response = await fetch(origin + "/api/" + path, {
		method,
		redirect: "error",
		cache: "no-store",
		credentials: "omit",
		signal: AbortSignal.timeout(20000),
		headers: {
			...(token && { Authorization: "Bearer " + token }),
			...(body &&
				!(body instanceof FormData) && { "Content-Type": "application/json" }),
		},
		body:
			body instanceof FormData
				? body
				: body === undefined
					? undefined
					: JSON.stringify(body),
	});
	if (!response.ok) {
		const error = new Error(
			response.status === 401
				? "Your session has expired. Sign in again to keep working."
				: response.status === 413
					? "That item is too large for your server."
					: response.status >= 500
						? "Couldn’t reach your server. Your draft is still here."
						: "Bordo couldn’t save this change. Your draft is still here.",
		);
		error.status = response.status;
		throw error;
	}
	return response.status === 204 ||
		!response.headers.get("content-type")?.includes("json")
		? undefined
		: response.json();
}

async function authenticated(path, options = {}) {
	const { connection } = await state();
	if (!connection)
		throw Object.assign(new Error("Connect to your Bordo server first."), {
			status: 401,
		});
	try {
		return await request(connection.origin, path, {
			...options,
			token: connection.access,
		});
	} catch (error) {
		if (error.status !== 401 || !connection.refresh) throw error;
	}
	const next = await request(connection.origin, "auth/refresh", {
		method: "POST",
		body: { refresh_token: connection.refresh },
	});
	await chrome.storage.local.set({
		connection: {
			...connection,
			access: next.access_token,
			refresh: next.refresh_token,
		},
	});
	return request(connection.origin, path, {
		...options,
		token: next.access_token,
	});
}

async function connect(origin) {
	origin = serverOrigin(origin);
	await chrome.storage.local.set({ pendingOrigin: origin });
	const redirect = chrome.identity.getRedirectURL("bordo");
	const stateKey = crypto.randomUUID();
	const response = await chrome.identity.launchWebAuthFlow({
		url: origin + "/clipper-connect/" + stateKey,
		interactive: true,
	});
	if (!response)
		throw new Error("Sign-in was closed. Try again when you’re ready.");
	const result = new URL(response);
	if (result.origin + result.pathname !== redirect)
		throw new Error("Bordo returned an unexpected sign-in address.");
	const data = new URLSearchParams(result.hash.slice(1));
	if (
		data.get("state") !== stateKey ||
		!data.get("access_token") ||
		!data.get("refresh_token")
	) {
		throw new Error("Bordo couldn’t confirm this sign-in. Try again.");
	}
	const access = data.get("access_token");
	const refresh = data.get("refresh_token");
	const user = await request(origin, "auth/me", { token: access });
	await chrome.storage.local.set({
		connection: {
			origin,
			access,
			refresh,
			account: user.id,
			email: user.email,
		},
	});
}

async function connectToken(origin, token) {
	origin = serverOrigin(origin);
	await request(origin, "tags", { token });
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	const account = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	await chrome.storage.local.set({
		connection: { origin, access: token, account, email: "API token" },
		pendingOrigin: origin,
	});
}

function addSource(draft, url, title) {
	if (url && !draft.sources.some((source) => source.url === url)) {
		if (url.length > 4096) throw new Error("That source link is too long.");
		if (draft.sources.length >= 30)
			throw new Error("This draft already has 30 source links.");
		draft.sources.push({
			url,
			title: String(title || new URL(url).hostname).slice(0, 200),
			include: true,
		});
	}
}

function addImage(draft, file, name) {
	if (
		!file ||
		!MIME_TYPES[file.mime] ||
		!file.size ||
		file.size > MAX_IMAGE ||
		draft.images.reduce((sum, item) => sum + item.size, 0) + file.size >
			MAX_DRAFT_IMAGES
	)
		return false;
	const extension = MIME_TYPES[file.mime];
	const base = (name || "Image")
		.replace(/\.[^.]+$/, "")
		.replace(/[\\/\u0000-\u001f]/g, "_")
		.slice(0, 80);
	let filename = base + "." + extension;
	for (let n = 2; draft.images.some((item) => item.name === filename); n++)
		filename = base + "-" + n + "." + extension;
	draft.images.push({ ...file, id: crypto.randomUUID(), name: filename });
	return true;
}

async function capture(draft, tab, info = {}) {
	if (draft.saveTarget)
		throw new Error("Finish saving this note before adding more clips.");
	draft.initialized = true;
	const url = webUrl(info.pageUrl ?? tab?.url);
	if (
		!url ||
		/^https:\/\/chrome\.google\.com\/webstore(?:\/|$)|^https:\/\/chromewebstore\.google\.com\//.test(
			url,
		)
	) {
		draft.restricted = true;
	} else {
		draft.restricted = false;
	}
	if (!draft.title && tab?.title) draft.title = tab.title.slice(0, 200);
	addSource(draft, url, tab?.title);
	let selection = info.selectionText;
	if (!info.menuItemId && !draft.restricted && tab?.id !== undefined) {
		const results = await chrome.scripting
			.executeScript({
				target: { tabId: tab.id },
				func: () => window.getSelection()?.toString().slice(0, 50000),
			})
			.catch(() => null);
		if (results) selection = results[0]?.result;
		else draft.restricted = true;
	}
	if (selection?.trim() && draft.quotes.length < 30) {
		const remaining =
			250000 - draft.quotes.reduce((sum, quote) => sum + quote.text.length, 0);
		const text = selection.trim().slice(0, Math.min(50000, remaining));
		if (
			text &&
			!draft.quotes.some((quote) => quote.text === text && quote.url === url)
		) {
			draft.quotes.push({ id: crypto.randomUUID(), text, url });
		}
	}
	if (info.srcUrl && tab?.id !== undefined) {
		let found;
		const src = webUrl(info.srcUrl);
		if (src) {
			found = await chrome.scripting
				.executeScript({
					target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
					func: readImage,
					args: [src, MAX_IMAGE],
				})
				.then(
					(results) => results[0]?.result,
					() => null,
				);
		}
		if (addImage(draft, found, src && new URL(src).pathname.split("/").pop()))
			delete draft.imageFallback;
		else draft.imageFallback = src || true;
	}
	return saveDraft(draft);
}

function noteContent(draft) {
	const ops = [];
	for (const quote of draft.quotes) {
		for (const line of quote.text.split(/\r?\n/)) {
			if (line) ops.push({ insert: line });
			ops.push({ insert: "\n", attributes: { blockquote: true } });
		}
	}
	if (draft.text.trim()) ops.push({ insert: draft.text.trim() + "\n" });
	for (const source of draft.sources.filter((item) => item.include)) {
		ops.push(
			{ insert: source.title, attributes: { link: source.url } },
			{ insert: "\n" },
		);
	}
	return JSON.stringify({ ops: ops.length ? ops : [{ insert: "\n" }] });
}

async function saveNote() {
	const { draft, connection } = await state();
	if (!draft || !connection)
		throw new Error("Connect to your Bordo server first.");
	if (
		!(
			draft.title.trim() ||
			draft.text.trim() ||
			draft.quotes.length ||
			draft.images.length ||
			draft.sources.some((source) => source.include)
		)
	) {
		throw new Error("Add something to your note first.");
	}
	const target = { origin: connection.origin, account: connection.account };
	if (
		draft.saveTarget &&
		(draft.saveTarget.origin !== target.origin ||
			draft.saveTarget.account !== target.account)
	) {
		throw new Error(
			"Reconnect to the account where this note was started to finish saving.",
		);
	}
	// Keep a stable ID through network failures. A retried POST returns the same owned note.
	draft.saveTarget = target;
	await saveDraft(draft);
	const title = draft.title.trim() || "Untitled note";
	const tagIds = [];
	for (const tag of draft.tags) {
		if (tag.id) {
			tagIds.push(tag.id);
			continue;
		}
		const tags = await authenticated("tags");
		const existing = tags.find((item) => item.name === tag.name);
		const savedTag =
			existing ??
			(await authenticated("tags", {
				method: "POST",
				body: { name: tag.name },
			}));
		tagIds.push(savedTag.id);
	}
	await authenticated("notes", {
		method: "POST",
		body: {
			id: draft.id,
			title,
			content: noteContent(draft),
			tagIds,
		},
	});
	if (draft.images.length) {
		const existing = await authenticated(`notes/${draft.id}/attachments`);
		for (const [position, image] of draft.images.entries()) {
			if (
				existing.some(
					(file) =>
						file.position === position &&
						file.originalFilename === image.name &&
						file.fileSize === image.size,
				)
			)
				continue;
			const form = new FormData();
			form.set("file", await (await fetch(image.data)).blob(), image.name);
			form.set("position", String(position));
			await authenticated(`import/notes/${draft.id}/attachments`, {
				method: "POST",
				body: form,
			});
		}
	}
	await chrome.storage.local.set({
		draft: emptyDraft(),
		saved: {
			title,
			url: connection.origin + "/notes/" + draft.id,
		},
	});
	await chrome.action.setBadgeText({ text: "" });
}

async function handle(message) {
	const current = await state();
	const draft = current.draft ?? emptyDraft();
	switch (message.type) {
		case "init": {
			if (!message.panel && !draft.initialized && !current.saved) {
				const [tab] = await chrome.tabs.query({
					active: true,
					currentWindow: true,
				});
				await capture(draft, tab);
			}
			await chrome.action.setBadgeText({ text: "" });
			break;
		}
		case "connect":
			return connect(message.origin);
		case "connectToken":
			return connectToken(message.origin, message.token.trim());
		case "disconnect":
			if (current.connection?.refresh) {
				await request(current.connection.origin, "auth/logout", {
					method: "POST",
					body: { refreshToken: current.connection.refresh },
				});
			}
			return chrome.storage.local.remove("connection");
		case "tags":
			return authenticated("tags");
		case "createTag": {
			if (draft.saveTarget) break;
			const name = message.name.trim().slice(0, 50);
			if (!name) break;
			if (!draft.tags.some((item) => item.name === name))
				draft.tags.push({ id: null, name });
			return saveDraft(draft);
		}
		case "tag":
			if (draft.saveTarget) break;
			if (!draft.tags.some((tag) => tag.id === message.tag.id))
				draft.tags.push(message.tag);
			return saveDraft(draft);
		case "untag":
			if (draft.saveTarget) break;
			draft.tags = draft.tags.filter((tag) => tag.name !== message.name);
			return saveDraft(draft);
		case "edit":
			if (draft.saveTarget) break;
			if (message.field === "title") draft.title = message.value.slice(0, 200);
			if (message.field === "text") draft.text = message.value.slice(0, 50000);
			return saveDraft(draft);
		case "link":
			if (draft.saveTarget) break;
			for (const source of draft.sources)
				if (source.url === message.url) source.include = message.include;
			return saveDraft(draft);
		case "addLink": {
			if (draft.saveTarget) break;
			const url = webUrl(message.url);
			if (!url) throw new Error("Use an HTTP or HTTPS link.");
			addSource(draft, url);
			return saveDraft(draft);
		}
		case "remove":
			if (draft.saveTarget) break;
			if (["quotes", "images"].includes(message.field))
				draft[message.field] = draft[message.field].filter(
					(item) => item.id !== message.id,
				);
			return saveDraft(draft);
		case "imageLink":
			if (draft.saveTarget) break;
			addSource(draft, webUrl(draft.imageFallback), "Image link");
			delete draft.imageFallback;
			return saveDraft(draft);
		case "dismissImage":
			delete draft.imageFallback;
			return saveDraft(draft);
		case "file":
			if (draft.saveTarget) break;
			if (!addImage(draft, message.file, message.name))
				throw new Error(
					"Choose a PNG, JPEG, WebP or GIF up to 3 MB. A draft can hold 5 MB of images.",
				);
			delete draft.imageFallback;
			return saveDraft(draft);
		case "screenshot": {
			if (draft.saveTarget) break;
			const data = await chrome.tabs.captureVisibleTab({
				format: "jpeg",
				quality: 82,
			});
			if (
				!addImage(
					draft,
					{
						data,
						mime: "image/jpeg",
						size: (await (await fetch(data)).blob()).size,
					},
					"Page capture",
				)
			) {
				throw new Error(
					"The capture is too large. You can save the page link instead.",
				);
			}
			delete draft.imageFallback;
			return saveDraft(draft);
		}
		case "capture": {
			const [tab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});
			await chrome.storage.local.remove("saved");
			return capture(draft, tab, { menuItemId: "page" });
		}
		case "save":
			return saveNote();
		case "finishWithoutImages":
			if (
				!draft.saveTarget ||
				!current.connection ||
				draft.saveTarget.origin !== current.connection.origin ||
				draft.saveTarget.account !== current.connection.account
			)
				break;
			await authenticated("notes/" + draft.id);
			draft.images = [];
			await saveDraft(draft);
			return saveNote();
		case "new":
			await chrome.storage.local.remove("saved");
			return saveDraft(emptyDraft());
	}
	return undefined;
}

chrome.runtime.onInstalled.addListener(() => {
	void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
	chrome.contextMenus.removeAll(() => {
		for (const { id, title, contexts } of MENUS)
			chrome.contextMenus.create({ id, title, contexts });
	});
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
	void serial(async () => {
		const draft = (await state()).draft ?? emptyDraft();
		await capture(draft, tab, info);
		await chrome.storage.local.remove("saved");
		const panels = await chrome.runtime.getContexts({
			contextTypes: ["SIDE_PANEL"],
			windowIds: [tab.windowId],
		});
		if (!panels.length) {
			await chrome.action.setBadgeText({ text: "1" });
			await chrome.action.openPopup({ windowId: tab.windowId });
		}
	}).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
	if (!sender.url?.startsWith(chrome.runtime.getURL("clip.html"))) return false;
	// An interactive auth window can remain open for minutes. It must not stall draft writes.
	const operation =
		message.type === "connect"
			? handle(message)
			: serial(() => handle(message));
	operation.then(
		(data) => reply({ ok: true, data }),
		(error) =>
			reply({
				ok: false,
				status: error.status,
				message:
					error instanceof TypeError
						? "Couldn’t reach your server. Your draft is still here."
						: error.message,
			}),
	);
	return true;
});
