const $ = (id) => document.getElementById(id);
const panel = new URLSearchParams(location.search).has("panel");
document.body.classList.toggle("panel", panel);
$("panel").hidden = panel;
$("panel-intro").hidden = !panel;
if (/Mac/.test(navigator.platform)) $("shortcut").textContent = "⌘ ↵";

let view = "";
let working = false;
let current = {};
let availableTags = [];
let errorText = "";
let expired = false;
let renderedDraftId;
let windowId;
void chrome.windows.getCurrent().then((window) => {
	windowId = window.id;
});

function node(tag, text, className) {
	const el = document.createElement(tag);
	if (text) el.textContent = text;
	if (className) el.className = className;
	return el;
}

function button(text, label, action, className) {
	const el = node("button", text, className);
	el.type = "button";
	el.setAttribute("aria-label", label);
	el.onclick = action;
	return el;
}

async function message(type, args = {}) {
	const result = await chrome.runtime.sendMessage({ type, ...args });
	if (!result.ok) {
		const error = new Error(result.message);
		error.status = result.status;
		throw error;
	}
	return result.data;
}

function error(error) {
	errorText = error.message;
	expired = error.status === 401;
	render();
}

async function perform(type, args, { busy = false, done } = {}) {
	if (busy && working) return;
	if (busy) working = true;
	errorText = "";
	render();
	try {
		const data = await message(type, args);
		if (done) done(data);
		return data;
	} catch (e) {
		error(e);
	} finally {
		if (busy) working = false;
		await refresh();
	}
}

function renderTags() {
	const filter = $("tag-search").value.trim();
	const results = availableTags.filter(
		(tag) =>
			!current.draft?.tags.some((item) => item.id === tag.id) &&
			tag.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
	);
	$("tag-results").replaceChildren(
		...results
			.slice(0, 25)
			.map((tag) =>
				button(
					tag.name,
					"Add tag " + tag.name,
					() =>
						perform(
							"tag",
							{ tag: { id: tag.id, name: tag.name } },
							{ done: closeTags },
						),
					"quiet",
				),
			),
	);
	if (!results.length)
		$("tag-results").append(
			node("p", filter ? "No matching tags" : "No tags yet", "muted"),
		);
	$("create-tag").hidden =
		!filter || availableTags.some((tag) => tag.name === filter);
	$("create-tag").textContent = "Create “" + filter + "”";
}

function closeTags() {
	$("tag-picker").hidden = true;
	$("add-tag").setAttribute("aria-expanded", "false");
	$("add-tag").focus();
}

function render() {
	const { connection, draft, saved } = current;
	const screen =
		expired || view === "connect" || !connection
			? "connect"
			: view === "account"
				? "account"
				: saved
					? "done"
					: "editor";
	for (const id of ["connect", "editor", "done", "account"])
		$(id).hidden = id !== screen;
	$("status").textContent =
		errorText ||
		(!navigator.onLine ? "You’re offline. Your draft is still here." : "");
	$("status").hidden = !$("status").textContent;
	$("footer").hidden = screen !== "editor";
	$("heading").textContent = screen === "editor" && !panel ? "New note" : "";
	$("settings").hidden = !connection || screen === "account";
	$("panel").disabled = screen === "connect";
	$("sign-in").disabled = working || !navigator.onLine;
	$("sign-in").textContent =
		working && screen === "connect"
			? "Waiting for sign-in…"
			: expired
				? "Sign in again"
				: "Continue";
	if (!$("server").value)
		$("server").value = current.pendingOrigin || connection?.origin || "";
	$("token-form").querySelector(".primary").disabled =
		working || !navigator.onLine;
	if (screen === "account")
		$("account-info").textContent =
			connection.email + " · " + new URL(connection.origin).host;
	if (screen === "done") $("saved-title").textContent = saved.title;
	if (screen !== "editor" || !draft) return;
	$("restrict").hidden = !draft.restricted;
	$("partial").hidden = !draft.saveTarget;
	$("finish-without-images").hidden =
		!draft.saveTarget || !draft.images.length || working || !errorText;
	$("fallback").hidden = !draft.imageFallback || Boolean(draft.saveTarget);
	$("image-link").hidden = typeof draft.imageFallback !== "string";
	$("destination").textContent = "Saves to " + new URL(connection.origin).host;
	$("destination").title = connection.origin;
	const hasContent =
		draft.title.trim() ||
		draft.text.trim() ||
		draft.sources.some((source) => source.include) ||
		draft.quotes.length ||
		draft.images.length;
	$("save").disabled = working || !navigator.onLine || !hasContent;
	$("save").firstChild.textContent = working
		? "Saving… "
		: draft.saveTarget
			? "Try again "
			: "Save note ";
	const locked = Boolean(draft.saveTarget);
	for (const id of [
		"title",
		"text",
		"attach",
		"add-link",
		"add-tag",
		"add-page",
	])
		$(id).disabled = locked;
	for (const id of ["title", "text"]) {
		if (
			(document.activeElement !== $(id) || renderedDraftId !== draft.id) &&
			$(id).value !== draft[id]
		) {
			$(id).value = draft[id];
		}
	}
	renderedDraftId = draft.id;
	$("quotes").replaceChildren(
		...draft.quotes.map((quote) => {
			const block = node("blockquote");
			block.append(node("span", quote.text));
			if (!locked)
				block.append(
					button(
						"×",
						"Remove selection",
						() => perform("remove", { field: "quotes", id: quote.id }),
						"remove",
					),
				);
			return block;
		}),
	);
	$("images").replaceChildren(
		...draft.images.map((file) => {
			const row = node("div", null, "attachment");
			const image = node("img");
			image.src = file.data;
			image.alt = "";
			row.append(image, node("span", file.name));
			if (!locked)
				row.append(
					button(
						"×",
						"Remove " + file.name,
						() => perform("remove", { field: "images", id: file.id }),
						"remove",
					),
				);
			return row;
		}),
	);
	$("sources").replaceChildren(
		...draft.sources.map((source) => {
			const row = node("div", null, "source");
			const details = node("div");
			details.append(node("strong", source.title), node("small", source.url));
			const label = node("label");
			const checkbox = node("input");
			checkbox.type = "checkbox";
			checkbox.checked = source.include;
			checkbox.disabled = locked;
			checkbox.setAttribute(
				"aria-label",
				"Include source link " + source.title,
			);
			checkbox.onchange = () =>
				perform("link", { url: source.url, include: checkbox.checked });
			label.append(checkbox, node("span", "Link"));
			row.append(details, label);
			return row;
		}),
	);
	$("applied-tags").replaceChildren(
		...draft.tags.map((tag) =>
			locked
				? node("span", tag.name, "chip applied")
				: button(
						tag.name + " ×",
						"Remove tag " + tag.name,
						() => perform("untag", { name: tag.name }),
						"chip applied",
					),
		),
	);
}

async function refresh() {
	current = await chrome.storage.local.get([
		"connection",
		"draft",
		"saved",
		"pendingOrigin",
	]);
	render();
}

function installConnection() {
	const raw = $("server").value.trim();
	const url = new URL(raw.includes("://") ? raw : "https://" + raw);
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		(url.protocol === "http:" &&
			!["127.0.0.1", "localhost"].includes(url.hostname))
	) {
		throw new Error(
			"Enter the base address of your Bordo server. Remote servers need HTTPS.",
		);
	}
	return url;
}

function startConnect(token) {
	let url;
	try {
		url = installConnection();
	} catch (e) {
		error(
			new Error(
				e.message.startsWith("Enter")
					? e.message
					: "Enter a valid Bordo server address.",
			),
		);
		return;
	}
	chrome.permissions
		.request({ origins: [url.protocol + "//" + url.hostname + "/*"] })
		.then((granted) => {
			if (!granted)
				throw new Error("Server access was declined. You can try again.");
			return perform(
				token === undefined ? "connect" : "connectToken",
				{ origin: url.origin, token },
				{
					busy: true,
					done: () => {
						expired = false;
						view = "";
						$("token").value = "";
					},
				},
			);
		})
		.catch(error);
}

$("connection-form").onsubmit = (event) => {
	event.preventDefault();
	startConnect();
};
$("token-form").onsubmit = (event) => {
	event.preventDefault();
	startConnect($("token").value);
};
$("web-settings").onclick = () => {
	try {
		void chrome.tabs.create({ url: installConnection().origin + "/settings" });
	} catch (e) {
		error(e);
	}
};
$("panel").onclick = () =>
	chrome.sidePanel.open({ windowId }).catch(() => {
		error(new Error("Open Bordo from Chrome’s side panel menu."));
	});
$("settings").onclick = () => {
	view = "account";
	render();
};
$("back").onclick = () => {
	view = "";
	render();
};
$("change-server").onclick = () => {
	view = "connect";
	render();
	$("server").select();
};
$("disconnect").onclick = () =>
	perform(
		"disconnect",
		{},
		{
			busy: true,
			done: () => {
				view = "";
			},
		},
	);
for (const id of ["title", "text"])
	$(id).oninput = () =>
		message("edit", { field: id, value: $(id).value }).catch(error);
$("add-page").onclick = () => perform("capture");
$("attach").onclick = () => $("file").click();
$("file").onchange = async () => {
	const [file] = $("file").files;
	$("file").value = "";
	if (!file) return;
	if (file.size > 3 * 1024 * 1024) {
		error(new Error("Choose an image up to 3 MB."));
		return;
	}
	const reader = new FileReader();
	reader.onload = () =>
		perform("file", {
			name: file.name,
			file: { mime: file.type, size: file.size, data: reader.result },
		});
	reader.onerror = () => error(new Error("Couldn’t read that image."));
	reader.readAsDataURL(file);
};
$("add-link").onclick = () => {
	$("link-form").hidden = false;
	$("link-input").focus();
};
$("link-form").onsubmit = (event) => {
	event.preventDefault();
	void perform(
		"addLink",
		{ url: $("link-input").value },
		{
			done: () => {
				$("link-input").value = "";
				$("link-form").hidden = true;
				$("add-link").focus();
			},
		},
	);
};
$("image-link").onclick = () => perform("imageLink");
$("dismiss-image").onclick = () => perform("dismissImage");
$("screenshot").onclick = () => perform("screenshot");
$("add-tag").onclick = async () => {
	if (!$("tag-picker").hidden) return closeTags();
	$("tag-picker").hidden = false;
	$("add-tag").setAttribute("aria-expanded", "true");
	$("tag-search").value = "";
	$("tag-search").focus();
	$("tag-results").textContent = "Loading tags…";
	const tags = await perform("tags");
	if (tags) {
		availableTags = tags;
		renderTags();
	}
};
$("tag-search").oninput = renderTags;
$("create-tag").onclick = () =>
	perform("createTag", { name: $("tag-search").value }, { done: closeTags });
$("save").onclick = () => perform("save", {}, { busy: true });
$("finish-without-images").onclick = () =>
	perform("finishWithoutImages", {}, { busy: true });
$("open-note").onclick = () => chrome.tabs.create({ url: current.saved.url });
$("another").onclick = () =>
	perform("new", {}, { done: () => $("title").focus() });
document.addEventListener("keydown", (event) => {
	if (
		(event.ctrlKey || event.metaKey) &&
		event.key === "Enter" &&
		!$("footer").hidden &&
		!$("save").disabled
	) {
		event.preventDefault();
		$("save").click();
	} else if (event.key === "Escape" && !$("tag-picker").hidden) {
		event.preventDefault();
		closeTags();
	}
});
chrome.storage.onChanged.addListener((_, area) => {
	if (area === "local") void refresh();
});
window.addEventListener("online", render);
window.addEventListener("offline", render);
void perform("init", { panel }, { done: () => {} });
