# Anchor two-factor + passkeys: browser e2e evidence

Run on the final code (server build 2026-11-16 13:50, fresh Postgres 16 DB, `APP_URL=http://localhost:3000`, random `TOTP_ENCRYPTION_KEY`).
Headless Chromium (Playwright 1.58) with a CDP virtual authenticator for passkeys. TOTP codes were computed from the setup key shown in the UI.
Mobile is NOT covered here (no device or emulator available); it is covered by widget/unit tests only.

## Result: all scenarios pass (no 5xx, no page errors)

| # | Scenario | Video | Screenshots |
|---|---|---|---|
| 1 | Register first user, turn on authenticator app (QR, setup key, wrong code, recovery codes) | videos/01-enable-authenticator-app.mp4 | 01-07 |
| 2 | Sign in with code, then with a recovery code; reuse rejected | videos/02-sign-in-with-code-and-recovery-code.mp4 | 08-14 |
| 3 | Lockout after wrong codes (429), correct code refused while locked | videos/03-lockout-after-wrong-codes.mp4 | 15-21 |
| 4 | Replace authenticator, new recovery codes, turn off | videos/04-replace-recovery-codes-turn-off.mp4 (waiting time sped up, marked in video) | 22-29 |
| 5 | Passkeys: add, rename, sign in without password, delete | videos/05-passkeys.mp4 | 30-38 |
| 6 | Admin policy: refused without own factor (409), then optional/admins/everyone with coverage | videos/06-admin-policy.mp4 | 39-44 |
| 6b | New user under policy "everyone" goes through the enrollment gate | videos/07-policy-everyone-enrollment-gate.mp4 | 45-49 |
| 8 | Passkey-only user under policy: password login says "Sign in with your passkey" | videos/08-passkey-only-under-policy.mp4 | 50-52 |
| 7 | Admin people list badges and "Reset two-factor" | videos/09-admin-people-and-reset.mp4 | 53-56 |
| 7b | Reset user lands in the gate again | videos/10-after-reset-enroll-again.mp4 | 57-58 |
| 11 | Replace authenticator using a recovery code | videos/11-replace-with-recovery-code.mp4 | 70-72 |
| - | Dark mode | | 59-63, 73, 74 |
| - | Phone 390x844 | | 64-69 |

`raw-network-log.json` has every API call and console message; `scripts/` has the Playwright scripts (`run.mjs` runs everything from an empty DB).

## Key API statuses seen in the browser
login 401 "Two-factor code required" / 403 "Two-factor setup required" / 403 "Sign in with your passkey";
login/2fa 200, 401 "Invalid code", 429 lockout; 2fa/enable wrong code 400; 2fa/disable wrong password 403;
admin policy without own factor 409; reset-2fa 200; all passkey and enroll calls 200.

## Notes and known minor points
- Lockout was cleared with SQL in scenario 3 instead of waiting 10 minutes (`UPDATE "User" SET "twoFactorFailedAttempts"=0,"twoFactorLockedUntil"=NULL ...`).
- Lockout covers recovery codes too, so the UI only says "Try again in N minutes".
- While locked the typed digits stay in the (disabled) boxes instead of being cleared. Minor.
- The "None" badge in the people list is not shown in a screenshot (covered by server e2e specs).
- Console errors are only the intended 4xx responses; a Next warning about an unused preloaded CSS chunk on /settings is framework noise.
- Not verified in a browser: that an old access token is rejected after enabling TOTP (covered by server e2e: two-factor-hardening.e2e-spec.ts).
