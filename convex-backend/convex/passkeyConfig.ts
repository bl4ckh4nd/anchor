export function passkeyRelyingParty() {
	const configured = process.env.APP_URL?.trim();
	if (!configured) return null;
	try {
		const url = new URL(configured);
		if (url.username || url.password) return null;
		if (
			url.protocol !== "https:" &&
			!(url.protocol === "http:" && url.hostname === "localhost")
		)
			return null;
		return { origin: url.origin, rpID: url.hostname };
	} catch {
		return null;
	}
}
