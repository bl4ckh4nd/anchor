/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountDeletion from "../accountDeletion.js";
import type * as apiTokenHttp from "../apiTokenHttp.js";
import type * as attachmentActions from "../attachmentActions.js";
import type * as attachmentFiles from "../attachmentFiles.js";
import type * as attachmentStorage from "../attachmentStorage.js";
import type * as attachments from "../attachments.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as importState from "../importState.js";
import type * as legacyListsHttp from "../legacyListsHttp.js";
import type * as legacyNoteWritesHttp from "../legacyNoteWritesHttp.js";
import type * as migrations from "../migrations.js";
import type * as notes from "../notes.js";
import type * as oidc from "../oidc.js";
import type * as oidcActions from "../oidcActions.js";
import type * as oidcConfig from "../oidcConfig.js";
import type * as oidcHttp from "../oidcHttp.js";
import type * as oidcSettings from "../oidcSettings.js";
import type * as oidcSettingsHttp from "../oidcSettingsHttp.js";
import type * as passkeyActions from "../passkeyActions.js";
import type * as passkeyConfig from "../passkeyConfig.js";
import type * as passkeyHttp from "../passkeyHttp.js";
import type * as passkeys from "../passkeys.js";
import type * as profiles from "../profiles.js";
import type * as revisionRetention from "../revisionRetention.js";
import type * as sessionActions from "../sessionActions.js";
import type * as sessionHttp from "../sessionHttp.js";
import type * as sessions from "../sessions.js";
import type * as syncEvents from "../syncEvents.js";
import type * as tags from "../tags.js";
import type * as tombstones from "../tombstones.js";
import type * as userExportActions from "../userExportActions.js";
import type * as userExportHttp from "../userExportHttp.js";
import type * as userImportHttp from "../userImportHttp.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountDeletion: typeof accountDeletion;
  apiTokenHttp: typeof apiTokenHttp;
  attachmentActions: typeof attachmentActions;
  attachmentFiles: typeof attachmentFiles;
  attachmentStorage: typeof attachmentStorage;
  attachments: typeof attachments;
  crons: typeof crons;
  http: typeof http;
  importState: typeof importState;
  legacyListsHttp: typeof legacyListsHttp;
  legacyNoteWritesHttp: typeof legacyNoteWritesHttp;
  migrations: typeof migrations;
  notes: typeof notes;
  oidc: typeof oidc;
  oidcActions: typeof oidcActions;
  oidcConfig: typeof oidcConfig;
  oidcHttp: typeof oidcHttp;
  oidcSettings: typeof oidcSettings;
  oidcSettingsHttp: typeof oidcSettingsHttp;
  passkeyActions: typeof passkeyActions;
  passkeyConfig: typeof passkeyConfig;
  passkeyHttp: typeof passkeyHttp;
  passkeys: typeof passkeys;
  profiles: typeof profiles;
  revisionRetention: typeof revisionRetention;
  sessionActions: typeof sessionActions;
  sessionHttp: typeof sessionHttp;
  sessions: typeof sessions;
  syncEvents: typeof syncEvents;
  tags: typeof tags;
  tombstones: typeof tombstones;
  userExportActions: typeof userExportActions;
  userExportHttp: typeof userExportHttp;
  userImportHttp: typeof userImportHttp;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
