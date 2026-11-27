import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
	httpAction,
	internalMutation,
	internalQuery,
} from "./_generated/server";
import { legacyReadCredential } from "./apiTokenHttp";
import { feedHead } from "./notes";
import { reply } from "./sessionHttp";
import { legacyReadIdentity } from "./sessions";

const checkMs = 2000;
const maxChecks = 60;
const heartbeatChecks = 12;
const maxStreamsPerAccount = 8;
const leaseMs = maxChecks * checkMs + 15_000;
const connection = { id: v.string(), apiTokenHash: v.optional(v.string()) };

export const openStream = internalMutation({
	args: connection,
	handler: async (ctx, { id, apiTokenHash }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return null;
		const { issuer, subject } = identity;
		const head = await feedHead(ctx, issuer, subject);
		const now = Date.now();
		const eventStreams = (head?.eventStreams ?? [])
			.filter(({ expiresAt }) => expiresAt > now)
			.slice(-(maxStreamsPerAccount - 1));
		eventStreams.push({ id, expiresAt: now + leaseMs });
		if (head) await ctx.db.patch("noteFeedHeads", head._id, { eventStreams });
		else
			await ctx.db.insert("noteFeedHeads", {
				issuer,
				subject,
				lastSeq: 0n,
				eventStreams,
			});
		return { issuer, subject, seq: (head?.lastSeq ?? 0n).toString() };
	},
});

export const streamSequence = internalQuery({
	args: connection,
	handler: async (ctx, { id, apiTokenHash }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return null;
		const head = await feedHead(ctx, identity.issuer, identity.subject);
		return head?.eventStreams?.some((entry) => entry.id === id)
			? head.lastSeq.toString()
			: null;
	},
});

export const closeStream = internalMutation({
	args: { id: v.string(), issuer: v.string(), subject: v.string() },
	handler: async (ctx, { id, issuer, subject }) => {
		const head = await feedHead(ctx, issuer, subject);
		if (!head?.eventStreams) return;
		const eventStreams = head.eventStreams.filter((entry) => entry.id !== id);
		if (eventStreams.length !== head.eventStreams.length)
			await ctx.db.patch("noteFeedHeads", head._id, { eventStreams });
	},
});

export const syncEvents = httpAction(async (ctx, request) => {
	const credential = await legacyReadCredential(request);
	if (!credential.apiTokenHash) return reply({ code: "UNAUTHENTICATED" }, 401);
	const id = crypto.randomUUID();
	const args = { id, ...credential };
	const lease = await ctx.runMutation(internal.syncEvents.openStream, args);
	if (!lease) return reply({ code: "UNAUTHENTICATED" }, 401);

	let seq = lease.seq;
	let checks = 0;
	let lastFrame = 0;
	let closed = false;
	const encoder = new TextEncoder();
	const release = async () => {
		if (closed) return;
		closed = true;
		await ctx
			.runMutation(internal.syncEvents.closeStream, {
				id,
				issuer: lease.issuer,
				subject: lease.subject,
			})
			.catch(() => {}); // The lease expires if the client disconnects before cleanup.
	};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(": connected\n\n"));
		},
		async pull(controller) {
			try {
				while (!closed && checks < maxChecks) {
					await new Promise<void>((resolve) => setTimeout(resolve, checkMs));
					if (closed) return;
					checks++;
					const next = await ctx.runQuery(
						internal.syncEvents.streamSequence,
						args,
					);
					if (closed) return;
					if (next === null) break;
					if (next !== seq) {
						seq = next;
						lastFrame = checks;
						controller.enqueue(
							encoder.encode(
								`event: sync\ndata: ${JSON.stringify({ seq })}\n\n`,
							),
						);
						return;
					}
					if (checks - lastFrame >= heartbeatChecks) {
						lastFrame = checks;
						controller.enqueue(encoder.encode("event: ping\ndata: \n\n"));
						return;
					}
				}
				if (!closed) {
					controller.enqueue(encoder.encode("event: reconnect\ndata: \n\n"));
					controller.close();
				}
			} catch (error) {
				if (!closed) controller.error(error);
			}
			await release();
		},
		cancel: release,
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "private, no-store, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
});
