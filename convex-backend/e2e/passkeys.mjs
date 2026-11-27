async (page) => {
	const api = "http://127.0.0.1:3987/api";
	const publicOrigin = "http://localhost:3990";
	const password = "PasskeysFixture2026";
	const session = (token) => ({ Authorization: "Bearer " + token });
	const request = (method, path, data, token) =>
		page.request.fetch(api + path, {
			method,
			data,
			headers: token ? session(token) : undefined,
		});
	async function call(method, path, status, data, token) {
		const response = await request(method, path, data, token);
		if (response.status() !== status) {
			throw new Error(
				method +
					" " +
					path +
					" returned " +
					response.status() +
					", expected " +
					status,
			);
		}
		return response.json();
	}
	const register = (name, status = 201) =>
		call("POST", "/auth/register", status, {
			name,
			email: name + "@example.test",
			password,
		});
	async function credential(options, kind) {
		return page.evaluate(
			async ({ options, kind }) => {
				const created =
					kind === "create"
						? await navigator.credentials.create({
								publicKey:
									PublicKeyCredential.parseCreationOptionsFromJSON(options),
							})
						: await navigator.credentials.get({
								publicKey:
									PublicKeyCredential.parseRequestOptionsFromJSON(options),
							});
				return created.toJSON();
			},
			{ options, kind },
		);
	}
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	await page.goto(publicOrigin);

	const capabilities = await call("GET", "/auth/capabilities", 200);
	if (!capabilities.passkeys)
		throw new Error("Passkeys missing from capabilities");
	await call("POST", "/auth/passkeys/register/options", 401);
	const admin = await register("admin");
	const guest = await register("guest");
	const options = await call(
		"POST",
		"/auth/passkeys/register/options",
		200,
		undefined,
		admin.access_token,
	);
	const response = await credential(options.options, "create");
	const proof = { challenge: options.challenge, response, name: "Fixture key" };
	await call(
		"POST",
		"/auth/passkeys/register/verify",
		401,
		proof,
		guest.access_token,
	);
	const { passkey } = await call(
		"POST",
		"/auth/passkeys/register/verify",
		200,
		proof,
		admin.access_token,
	);
	await call(
		"POST",
		"/auth/passkeys/register/verify",
		401,
		proof,
		admin.access_token,
	);
	await call(
		"PATCH",
		"/auth/passkeys/" + passkey.id,
		404,
		{ name: "Guest" },
		guest.access_token,
	);
	const renamed = await call(
		"PATCH",
		"/auth/passkeys/" + passkey.id,
		200,
		{ name: "Renamed" },
		admin.access_token,
	);
	if (renamed.passkey.name !== "Renamed") throw new Error("Rename lost");

	const passwordResult = await call("POST", "/auth/login", 403, {
		email: "admin@example.test",
		password,
	});
	if (!passwordResult.passkeyRequired)
		throw new Error("Password bypassed passkey");
	const login = await call("POST", "/auth/passkeys/login/options", 200);
	const assertion = await credential(login.options, "get");
	const loginProof = { challenge: login.challenge, response: assertion };
	const mismatched = await call("POST", "/auth/passkeys/login/options", 200);
	await call("POST", "/auth/passkeys/login/verify", 401, {
		...loginProof,
		challenge: mismatched.challenge,
	});
	const race = await Promise.all(
		[1, 2].map(() =>
			request("POST", "/auth/passkeys/login/verify", loginProof),
		),
	);
	if (String(race.map((result) => result.status()).sort()) !== "200,401") {
		throw new Error(
			"Concurrent challenge verification issued multiple sessions or refused both requests",
		);
	}
	const authorized = await race.find((result) => result.ok()).json();
	await call("POST", "/auth/passkeys/login/verify", 401, loginProof);
	if (authorized.user.id !== admin.user.id) throw new Error("Wrong account");
	await call("GET", "/auth/me", 200, undefined, authorized.access_token);
	const refresh = await call("POST", "/auth/refresh", 200, {
		refresh_token: authorized.refresh_token,
	});
	await call("GET", "/auth/me", 200, undefined, refresh.access_token);

	await call(
		"PATCH",
		"/admin/settings/two-factor",
		200,
		{ policy: "everyone" },
		refresh.access_token,
	);
	await call(
		"DELETE",
		"/auth/passkeys/" + passkey.id,
		403,
		undefined,
		refresh.access_token,
	);
	const enrollment = await register("enrollment");
	if (
		!enrollment.twoFactorSetupRequired ||
		!enrollment.methods.passkey ||
		enrollment.access_token
	) {
		throw new Error("Passkey enrollment was not mandatory");
	}
	const enrollmentOptions = await call(
		"POST",
		"/auth/enroll/passkey/options",
		200,
		{ challenge: enrollment.challenge },
	);
	const enrollmentResponse = await credential(
		enrollmentOptions.options,
		"create",
	);
	const enrolled = await call("POST", "/auth/enroll/passkey/verify", 200, {
		challenge: enrollment.challenge,
		response: enrollmentResponse,
	});
	await call("GET", "/auth/me", 200, undefined, enrolled.access_token);
	await call("POST", "/auth/enroll/passkey/verify", 401, {
		challenge: enrollment.challenge,
		response: enrollmentResponse,
	});

	await call(
		"PATCH",
		"/admin/settings/two-factor",
		200,
		{ policy: "optional" },
		refresh.access_token,
	);
	const foreign = await call("POST", "/auth/passkeys/login/options", 200);
	await page.goto("http://localhost:3991");
	const wrongOrigin = await credential(
		{
			...foreign.options,
			allowCredentials: [{ type: "public-key", id: response.id }],
		},
		"get",
	);
	await call("POST", "/auth/passkeys/login/verify", 401, {
		challenge: foreign.challenge,
		response: wrongOrigin,
	});
	await page.goto(publicOrigin);
	const pendingLogin = await call("POST", "/auth/passkeys/login/options", 200);
	const pendingAssertion = await credential(
		{
			...pendingLogin.options,
			allowCredentials: [{ type: "public-key", id: response.id }],
		},
		"get",
	);
	await call(
		"DELETE",
		"/auth/passkeys/" + passkey.id,
		200,
		undefined,
		refresh.access_token,
	);
	await call("POST", "/auth/passkeys/login/verify", 401, {
		challenge: pendingLogin.challenge,
		response: pendingAssertion,
	});

	return {
		registration: true,
		login: true,
		challengeReplayDenied: true,
		otherAccountDenied: true,
		refresh: true,
		requiredEnrollment: true,
		lastFactorProtected: true,
		removedKeyDenied: true,
		concurrentReplayDenied: true,
		wrongOriginDenied: true,
	};
}
