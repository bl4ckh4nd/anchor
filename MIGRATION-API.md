# Bordo HTTP and SSE handlers

The inventory records the 95 NestJS HTTP and SSE routes, their controller methods and request bindings. Explicit decorators list the guards, status overrides and protocol exemptions. The linked handler and DTOs define request validation. The client and fixture references below document exercised response and error contracts.

| Method | Path | Handler | Request bindings | Explicit contract decorators |
| --- | --- | --- | --- | --- |
| GET | `/api/admin/settings/oidc` | [getOidcSettings](server/src/admin/admin.controller.ts#L127) | — | `UseGuards(AdminGuard)` |
| PATCH | `/api/admin/settings/oidc` | [updateOidcSettings](server/src/admin/admin.controller.ts#L132) | Body `UpdateOidcSettingsDto` | `UseGuards(AdminGuard)` |
| GET | `/api/admin/settings/registration` | [getRegistrationSettings](server/src/admin/admin.controller.ts#L36) | — | `UseGuards(AdminGuard)` |
| PATCH | `/api/admin/settings/registration` | [updateRegistrationMode](server/src/admin/admin.controller.ts#L41) | Body `UpdateRegistrationModeDto` | `UseGuards(AdminGuard)` |
| GET | `/api/admin/settings/two-factor` | [getTwoFactorSettings](server/src/admin/admin.controller.ts#L46) | — | `UseGuards(AdminGuard)` |
| PATCH | `/api/admin/settings/two-factor` | [updateTwoFactorPolicy](server/src/admin/admin.controller.ts#L51) | Body `UpdateTwoFactorPolicyDto` | `UseGuards(AdminGuard)` |
| GET | `/api/admin/stats` | [getStats](server/src/admin/admin.controller.ts#L31) | — | `UseGuards(AdminGuard)` |
| GET | `/api/admin/users` | [findUsers](server/src/admin/admin.controller.ts#L59) | Query skip `string`<br>Query take `string`<br>Query q `string`<br>Query status `string` | `UseGuards(AdminGuard)` |
| POST | `/api/admin/users` | [createUser](server/src/admin/admin.controller.ts#L84) | Body `CreateUserDto` | `UseGuards(AdminGuard)` |
| DELETE | `/api/admin/users/:id` | [deleteUser](server/src/admin/admin.controller.ts#L98) | Param id `string` | `UseGuards(AdminGuard)` |
| PATCH | `/api/admin/users/:id` | [updateUser](server/src/admin/admin.controller.ts#L89) | Param id `string`<br>Body `UpdateUserDto` | `UseGuards(AdminGuard)` |
| POST | `/api/admin/users/:id/approve` | [approveUser](server/src/admin/admin.controller.ts#L117) | Param id `string` | `UseGuards(AdminGuard)` |
| POST | `/api/admin/users/:id/reject` | [rejectUser](server/src/admin/admin.controller.ts#L122) | Param id `string` | `UseGuards(AdminGuard)` |
| POST | `/api/admin/users/:id/reset-2fa` | [resetTwoFactor](server/src/admin/admin.controller.ts#L112) | Param id `string` | `UseGuards(AdminGuard), HttpCode(HttpStatus.OK)` |
| POST | `/api/admin/users/:id/reset-password` | [resetPassword](server/src/admin/admin.controller.ts#L103) | Param id `string`<br>Body `ResetPasswordDto` | `UseGuards(AdminGuard)` |
| GET | `/api/admin/users/pending` | [getPendingUsers](server/src/admin/admin.controller.ts#L79) | — | `UseGuards(AdminGuard)` |
| GET | `/api/auth/2fa` | [status](server/src/auth/two-factor/two-factor.controller.ts#L122) | — | `UseGuards(JwtAuthGuard)` |
| POST | `/api/auth/2fa/disable` | [disable](server/src/auth/two-factor/two-factor.controller.ts#L145) | Body `DisableTotpDto` | `UseGuards(JwtAuthGuard), HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/2fa/enable` | [enable](server/src/auth/two-factor/two-factor.controller.ts#L136) | Body `EnableTotpDto` | `UseGuards(JwtAuthGuard), HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/2fa/recovery-codes` | [recoveryCodes](server/src/auth/two-factor/two-factor.controller.ts#L153) | Body `RegenerateRecoveryCodesDto` | `UseGuards(JwtAuthGuard), HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/2fa/setup` | [setup](server/src/auth/two-factor/two-factor.controller.ts#L129) | Body `SetupTotpDto` | `UseGuards(JwtAuthGuard), HttpCode(HttpStatus.OK)` |
| DELETE | `/api/auth/api-token` | [revokeApiToken](server/src/auth/auth.controller.ts#L87) | — | `UseGuards(JwtAuthGuard)` |
| GET | `/api/auth/api-token` | [getApiToken](server/src/auth/auth.controller.ts#L81) | — | `UseGuards(JwtAuthGuard)` |
| POST | `/api/auth/api-token/regenerate` | [regenerateApiToken](server/src/auth/auth.controller.ts#L94) | — | `UseGuards(JwtAuthGuard), HttpCode(HttpStatus.OK)` |
| GET | `/api/auth/capabilities` | [capabilities](server/src/auth/two-factor/two-factor.controller.ts#L47) | — | `—` |
| POST | `/api/auth/change-password` | [changePassword](server/src/auth/auth.controller.ts#L101) | Body `ChangePasswordDto` | `UseGuards(JwtAuthGuard), HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/convex-token` | [getConvexToken](server/src/auth/auth.controller.ts#L75) | — | `UseGuards(JwtAuthGuard), HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/delete-account` | [deleteAccount](server/src/auth/auth.controller.ts#L111) | Body `DeleteAccountDto` | `UseGuards(JwtAuthGuard), HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/enroll/passkey/options` | [enrollPasskeyOptions](server/src/auth/two-factor/two-factor.controller.ts#L103) | Body `ChallengeDto` | `HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/enroll/passkey/verify` | [enrollPasskeyVerify](server/src/auth/two-factor/two-factor.controller.ts#L109) | Body `EnrollPasskeyVerifyDto` | `HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/enroll/totp/enable` | [enrollTotpEnable](server/src/auth/two-factor/two-factor.controller.ts#L90) | Body `EnrollEnableDto` | `HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/enroll/totp/setup` | [enrollTotpSetup](server/src/auth/two-factor/two-factor.controller.ts#L83) | Body `ChallengeDto` | `HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/login` | [login](server/src/auth/auth.controller.ts#L49) | Body `LoginDto` | `HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/login/2fa` | [loginTwoFactor](server/src/auth/two-factor/two-factor.controller.ts#L55) | Body `LoginTwoFactorDto` | `HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/logout` | [logout](server/src/auth/auth.controller.ts#L61) | Body `LogoutDto` | `HttpCode(HttpStatus.OK)` |
| GET | `/api/auth/me` | [getMe](server/src/auth/auth.controller.ts#L67) | — | `UseGuards(JwtAuthGuard)` |
| GET | `/api/auth/oidc/callback` | [callback](server/src/auth/oidc/oidc.controller.ts#L61) | Query code `string \| undefined`<br>Query state `string \| undefined`<br>Query error `string \| undefined`<br>Query error_description `string \| undefined` | `—` |
| GET | `/api/auth/oidc/config` | [getConfig](server/src/auth/oidc/oidc.controller.ts#L29) | — | `—` |
| POST | `/api/auth/oidc/exchange` | [exchange](server/src/auth/oidc/oidc.controller.ts#L110) | Body code `string \| undefined` | `—` |
| POST | `/api/auth/oidc/exchange/mobile` | [exchangeMobile](server/src/auth/oidc/oidc.controller.ts#L121) | Body access_token `string \| undefined` | `—` |
| GET | `/api/auth/oidc/initiate` | [initiate](server/src/auth/oidc/oidc.controller.ts#L37) | Query redirect `string \| undefined` | `—` |
| DELETE | `/api/auth/passkeys/:id` | [deletePasskey](server/src/auth/two-factor/two-factor.controller.ts#L198) | Param id `string` | `UseGuards(JwtAuthGuard)` |
| PATCH | `/api/auth/passkeys/:id` | [renamePasskey](server/src/auth/two-factor/two-factor.controller.ts#L188) | Param id `string`<br>Body `RenamePasskeyDto` | `UseGuards(JwtAuthGuard)` |
| POST | `/api/auth/passkeys/login/options` | [passkeyLoginOptions](server/src/auth/two-factor/two-factor.controller.ts#L65) | — | `HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/passkeys/login/verify` | [passkeyLoginVerify](server/src/auth/two-factor/two-factor.controller.ts#L71) | Body `PasskeyLoginVerifyDto` | `HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/passkeys/register/options` | [passkeyRegisterOptions](server/src/auth/two-factor/two-factor.controller.ts#L165) | — | `UseGuards(JwtAuthGuard), HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/passkeys/register/verify` | [passkeyRegisterVerify](server/src/auth/two-factor/two-factor.controller.ts#L172) | Body `PasskeyRegisterVerifyDto` | `UseGuards(JwtAuthGuard), HttpCode(HttpStatus.OK)` |
| PATCH | `/api/auth/profile` | [updateProfile](server/src/auth/auth.controller.ts#L120) | Body `UpdateProfileDto` | `UseGuards(JwtAuthGuard)` |
| DELETE | `/api/auth/profile/image` | [removeProfileImage](server/src/auth/auth.controller.ts#L150) | — | `UseGuards(JwtAuthGuard)` |
| POST | `/api/auth/profile/image` | [uploadProfileImage](server/src/auth/auth.controller.ts#L130) | Multipart file | `UseGuards(JwtAuthGuard)` |
| POST | `/api/auth/refresh` | [refresh](server/src/auth/auth.controller.ts#L55) | Body `RefreshTokenDto` | `HttpCode(HttpStatus.OK)` |
| POST | `/api/auth/register` | [register](server/src/auth/auth.controller.ts#L43) | Body `RegisterDto` | `—` |
| GET | `/api/auth/registration-mode` | [getRegistrationMode](server/src/auth/auth.controller.ts#L38) | — | `—` |
| GET | `/api/export` | [export](server/src/import-export/export.controller.ts#L14) | Query `ExportQueryDto` | `UseGuards(AuthGuard)` |
| GET | `/api/health` | [check](server/src/health/health.controller.ts#L11) | — | `SkipProtocolGate()` |
| POST | `/api/import/notes` | [importNotes](server/src/import-export/import.controller.ts#L26) | Body `ImportNotesDto` | `UseGuards(AuthGuard)` |
| POST | `/api/import/notes/:noteId/attachments` | [importAttachment](server/src/import-export/import.controller.ts#L37) | Param noteId `string`<br>Multipart file<br>Body `ImportAttachmentDto` | `UseGuards(AuthGuard)` |
| GET | `/api/notes` | [findAll](server/src/notes/controllers/notes.controller.ts#L41) | Query search `string`<br>Query tagId `string`<br>Query limit `string` | `UseGuards(AuthGuard)` |
| POST | `/api/notes` | [create](server/src/notes/controllers/notes.controller.ts#L33) | Body `CreateNoteDto` | `UseGuards(AuthGuard)` |
| DELETE | `/api/notes/:id` | [remove](server/src/notes/controllers/notes.controller.ts#L85) | Param id `string`<br>Query trashedAt `string` | `UseGuards(AuthGuard)` |
| GET | `/api/notes/:id` | [findOne](server/src/notes/controllers/notes.controller.ts#L61) | Param id `string` | `UseGuards(AuthGuard)` |
| PATCH | `/api/notes/:id` | [update](server/src/notes/controllers/notes.controller.ts#L66) | Param id `string`<br>Body `UpdateNoteDto` | `UseGuards(AuthGuard)` |
| POST | `/api/notes/:id/duplicate` | [duplicate](server/src/notes/controllers/notes.controller.ts#L75) | Param id `string` | `UseGuards(AuthGuard)` |
| DELETE | `/api/notes/:id/permanent` | [permanentDelete](server/src/notes/controllers/notes.controller.ts#L94) | Param id `string` | `UseGuards(AuthGuard)` |
| PATCH | `/api/notes/:id/restore` | [restore](server/src/notes/controllers/notes.controller.ts#L80) | Param id `string` | `UseGuards(AuthGuard)` |
| GET | `/api/notes/:id/shares` | [getNoteShares](server/src/notes/controllers/note-shares.controller.ts#L32) | Param id `string` | `UseGuards(AuthGuard)` |
| POST | `/api/notes/:id/shares` | [shareNote](server/src/notes/controllers/note-shares.controller.ts#L23) | Param id `string`<br>Body `ShareNoteDto` | `UseGuards(AuthGuard)` |
| DELETE | `/api/notes/:id/shares/:shareId` | [revokeShare](server/src/notes/controllers/note-shares.controller.ts#L55) | Param id `string`<br>Param shareId `string` | `UseGuards(AuthGuard)` |
| PATCH | `/api/notes/:id/shares/:shareId` | [updateNoteSharePermission](server/src/notes/controllers/note-shares.controller.ts#L40) | Param id `string`<br>Param shareId `string`<br>Body `UpdateNoteSharePermissionDto` | `UseGuards(AuthGuard)` |
| GET | `/api/notes/:noteId/attachments` | [findAll](server/src/notes/controllers/note-attachments.controller.ts#L94) | Param noteId `string` | `UseGuards(AuthGuard)` |
| POST | `/api/notes/:noteId/attachments` | [upload](server/src/notes/controllers/note-attachments.controller.ts#L69) | Param noteId `string`<br>Multipart file | `UseGuards(AuthGuard)` |
| DELETE | `/api/notes/:noteId/attachments/:id` | [remove](server/src/notes/controllers/note-attachments.controller.ts#L160) | Param noteId `string`<br>Param id `string` | `UseGuards(AuthGuard), HttpCode(HttpStatus.OK)` |
| GET | `/api/notes/:noteId/attachments/:id` | [serveFile](server/src/notes/controllers/note-attachments.controller.ts#L101) | Param noteId `string`<br>Param id `string`<br>Headers range `string` | `UseGuards(AuthGuard)` |
| PATCH | `/api/notes/:noteId/attachments/reorder` | [reorder](server/src/notes/controllers/note-attachments.controller.ts#L171) | Param noteId `string`<br>Body `ReorderAttachmentsDto` | `UseGuards(AuthGuard)` |
| GET | `/api/notes/:noteId/revisions` | [list](server/src/notes/controllers/note-revisions.controller.ts#L22) | Param noteId `string`<br>Query `ListNoteRevisionsDto` | `UseGuards(AuthGuard)` |
| GET | `/api/notes/:noteId/revisions/:id` | [findOne](server/src/notes/controllers/note-revisions.controller.ts#L31) | Param noteId `string`<br>Param id `string` | `UseGuards(AuthGuard)` |
| POST | `/api/notes/:noteId/revisions/:id/restore` | [restore](server/src/notes/controllers/note-revisions.controller.ts#L41) | Param noteId `string`<br>Param id `string` | `UseGuards(AuthGuard), HttpCode(HttpStatus.OK)` |
| GET | `/api/notes/archive` | [findArchived](server/src/notes/controllers/notes.controller.ts#L56) | — | `UseGuards(AuthGuard)` |
| POST | `/api/notes/bulk/archive` | [bulkArchive](server/src/notes/controllers/notes.controller.ts#L107) | Body `BulkActionDto` | `UseGuards(AuthGuard)` |
| POST | `/api/notes/bulk/delete` | [bulkDelete](server/src/notes/controllers/notes.controller.ts#L99) | Body `BulkActionDto` | `UseGuards(AuthGuard)` |
| POST | `/api/notes/bulk/pin` | [bulkPin](server/src/notes/controllers/notes.controller.ts#L124) | Body `BulkPinDto` | `UseGuards(AuthGuard)` |
| POST | `/api/notes/bulk/tags` | [bulkAddTags](server/src/notes/controllers/notes.controller.ts#L133) | Body `BulkTagsDto` | `UseGuards(AuthGuard)` |
| PUT | `/api/notes/positions` | [setPositions](server/src/notes/controllers/notes.controller.ts#L116) | Body `SetNotePositionsDto` | `UseGuards(AuthGuard)` |
| GET | `/api/notes/trash` | [findTrashed](server/src/notes/controllers/notes.controller.ts#L51) | — | `UseGuards(AuthGuard)` |
| POST | `/api/sync` | [sync](server/src/sync/sync.controller.ts#L22) | Body `SyncRequestDto` | `UseGuards(AuthGuard), HttpCode(HttpStatus.OK)` |
| SSE | `/api/sync/events` | [events](server/src/sync/sync-events.controller.ts#L22) | — | `UseGuards(AuthGuard)` |
| GET | `/api/tags` | [findAll](server/src/tags/tags.controller.ts#L33) | — | `UseGuards(AuthGuard)` |
| POST | `/api/tags` | [create](server/src/tags/tags.controller.ts#L25) | Body `CreateTagDto` | `UseGuards(AuthGuard)` |
| DELETE | `/api/tags/:id` | [remove](server/src/tags/tags.controller.ts#L66) | Param id `string` | `UseGuards(AuthGuard)` |
| GET | `/api/tags/:id` | [findOne](server/src/tags/tags.controller.ts#L47) | Param id `string` | `UseGuards(AuthGuard)` |
| PATCH | `/api/tags/:id` | [update](server/src/tags/tags.controller.ts#L57) | Param id `string`<br>Body `UpdateTagDto` | `UseGuards(AuthGuard)` |
| GET | `/api/tags/:id/notes` | [getNotesByTag](server/src/tags/tags.controller.ts#L52) | Param id `string` | `UseGuards(AuthGuard)` |
| PUT | `/api/tags/positions` | [setPositions](server/src/tags/tags.controller.ts#L39) | Body `SetTagPositionsDto` | `UseGuards(AuthGuard)` |
| GET | `/api/users/recent-contacts` | [getRecentContacts](server/src/users/users.controller.ts#L20) | — | `UseGuards(AuthGuard)` |
| GET | `/api/users/search` | [searchUsers](server/src/users/users.controller.ts#L12) | Query q `string` | `UseGuards(AuthGuard)` |

## Client call sites and contract fixtures

The NestJS HTTP setup and exception filter define the shared validation
and error envelope. The Convex fixtures exercise individual response
shapes and errors against the migrated API. The table above records
controller bindings, and the fixtures below cover the listed behaviors.
[NestJS setup](server/src/app.setup.ts) · [exception filter](server/src/common/filters/global-exception.filter.ts)

| API area | Client call sites | Covered response and error contracts |
| --- | --- | --- |
| Administration | [Web admin API](web/features/admin/api.ts) | Admin access, pending users, approval and rejection, account mutation and policy settings. [Admin overview](convex-backend/e2e/admin-overview.mjs) · [Admin policy](convex-backend/e2e/admin-policy.mjs) |
| Accounts and sessions | [Web auth API](web/features/auth/api.ts) · [Compose API](mobile-kotlin/shared/src/commonMain/kotlin/anchor/AnchorApi.kt) | Access and refresh tokens, refresh replay and account revocation. Profile mutations and API-token management have separate fixtures. [Sessions](convex-backend/e2e/native-auth.mjs) · [Profile](convex-backend/e2e/account-profile.mjs) · [API token](convex-backend/e2e/api-tokens.mjs) |
| OIDC and second factors | [Web auth API](web/features/auth/api.ts) · [Compose browser callback](mobile-kotlin/shared/src/commonMain/kotlin/anchor/OidcBrowser.kt) | Browser code exchange, legacy mobile token exchange and rejection of invalid tokens. Passkey and TOTP challenges, recovery and enforcement. [OIDC](convex-backend/e2e/oidc-login.mjs) · [Passkeys](convex-backend/e2e/passkeys.mjs) · [TOTP management](convex-backend/e2e/totp-manage.mjs) |
| Notes, tags, ordering and shares | [Web notes API](web/features/notes/api.ts) · [Web tags API](web/features/tags/api.ts) · [Compose API](mobile-kotlin/shared/src/commonMain/kotlin/anchor/AnchorApi.kt) | Note versions and conflicts, bulk actions, list shapes, personal ordering and access checks. [Note writes](convex-backend/e2e/legacy-note-writes.mjs) · [Bulk actions](convex-backend/e2e/legacy-note-bulk.mjs) · [Listings](convex-backend/e2e/legacy-lists.mjs) · [Tags](convex-backend/e2e/legacy-tag-writes.mjs) · [Shares](convex-backend/e2e/legacy-shares.mjs) |
| History and attachments | [Web notes API](web/features/notes/api.ts) · [Web upload client](web/lib/api/upload.ts) · [Compose API](mobile-kotlin/shared/src/commonMain/kotlin/anchor/AnchorApi.kt) | Revision pagination and restore, multipart and raw uploads, byte ranges and access revocation. [History](convex-backend/e2e/legacy-history.mjs) · [Legacy attachments](convex-backend/e2e/legacy-attachments.mjs) · [Compose attachments](convex-backend/e2e/attachments.mjs) |
| Health and synchronization | [Compose API](mobile-kotlin/shared/src/commonMain/kotlin/anchor/AnchorApi.kt) · Installed Flutter builds use the archived `features/sync/data/sync_api.dart` | Protocol negotiation, push receipts, cursor resets and SSE reconnect. [Legacy sync](convex-backend/e2e/flutter-sync.mjs) · [Compose sync](convex-backend/e2e/compose-note.mjs) · [SSE](convex-backend/e2e/legacy-live-sync.mjs) |
| User import and export | [Web import and export API](web/features/import-export/api.ts) | Note import, export manifest and attachment bytes. [Import](convex-backend/e2e/user-import.mjs) · [Export](convex-backend/e2e/user-export.mjs) |

## Erster Wechsel zu manueller Notizreihenfolge

`POST /api/compose/notes/order` akzeptiert `noteId`, `step` und `notes`
in der sichtbaren Reihenfolge. Für den ersten Wechsel zu „Custom order“
mit zwei Gruppen sendet Compose stattdessen `groups.moved` und
`groups.other`. Beide Listen enthalten `{ id, position }` für dieselbe
Ansicht. Das Backend prüft Berechtigungen, Gruppen und die erwarteten
Positionswerte und speichert beide Reihenfolgen in einer Transaktion.
Das gemeinsame Limit liegt bei 500 Einträgen. Ein veralteter Snapshot
liefert `409 STALE_ORDER`. Die App wechselt nach erfolgreichem Schreiben
und Sync zu „Custom order“. Ältere Backends weisen die Anfrage mit
`groups` ab, da sie `notes` erwarten.

## Einzelne Tag-Zuordnung in Convex

`PATCH /api/notes/:id` akzeptiert in Convex optional
`"tagAssignment": {"id": "<tag-id>", "assigned": true}`.
`assigned: false` entfernt die Zuordnung. Der Server prüft den
Notizzugriff und das Eigentum am Tag. Die Änderung betrifft das
aufrufende Konto und ändert die Inhaltsversion der Notiz nicht.
`tagAssignment` und `tagIds` sind im selben Request unzulässig.

## Konflikte bei Erinnerungen

Eine Erinnerung behält über Löschen und Neuanlegen hinweg eine
steigende Version. Beim Entfernen schickt der Feed weiterhin ein
`remove`-Ereignis. Wird eine bereits gelöschte Erinnerung mit
einer alten Version geändert, meldet der Sync `conflict` mit
`serverCopy: null`.

## Herkunft wartender Compose-Änderungen

Ein erfolgreicher Pull über `POST /api/compose/sync` gibt
`X-Anchor-Sync-Scope` zurück, wenn für das Konto eine dauerhafte
Kennung vorliegt. Die App speichert die Kennung beim Einreihen
eines Entwurfs, Uploads oder importierten Flutter-Vorgangs.
Der Cursor bleibt für die laufende App ein opaker Wert.

Wartende Schreibvorgänge senden die gespeicherte Kennung als
`X-Anchor-Outbox-Scope`. Vor dem Versand fragt die App die
Kennung mit einem Compose-Pull ohne Änderungen ab. Der
Schreibendpunkt prüft sie erneut. Eine abweichende Kennung
führt zu HTTP 409 mit `OUTBOX_SCOPE_CHANGED`. Der Entwurf
bleibt in der lokalen Prüfung. Ein vollständiger Convex-Restore
erhält die Kennung. Der Proxy muss beide Header weiterleiten.
Anfragen ohne die Kennung bleiben für frühere Clients verfügbar.
Importierte Tag-Zuordnungen verwenden `PATCH /api/notes/:id`
mit `tagIds` und der gespeicherten Kennung. Sie senden keinen
Titel und keine Notizversion.
