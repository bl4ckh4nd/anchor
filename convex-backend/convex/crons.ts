import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.daily(
	"expire trashed notes",
	{ hourUTC: 3, minuteUTC: 0 },
	internal.notes.expireTrashBatch,
	{},
);
crons.daily(
	"purge expired tombstones",
	{ hourUTC: 3, minuteUTC: 15 },
	internal.tombstones.purgeExpired,
	{},
);
crons.daily(
	"prune expired sync removals",
	{ hourUTC: 4, minuteUTC: 0 },
	internal.notes.pruneSyncRemovals,
	{},
);
crons.daily(
	"prune note revisions",
	{ hourUTC: 4, minuteUTC: 15 },
	internal.revisionRetention.prune,
	{},
);
crons.interval(
	"collect expired sessions",
	{ hours: 6 },
	internal.sessions.collectExpired,
	{},
);
crons.interval(
	"collect abandoned attachment uploads",
	{ hours: 6 },
	internal.attachments.collectOrphanUploads,
	{},
);

crons.interval(
	"collect expired OIDC flows",
	{ minutes: 15 },
	internal.oidc.collectExpired,
	{},
);

export default crons;
