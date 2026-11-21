import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Actor, createE2EApp, E2EApp, entryFor } from '../support';

/**
 * The note lifecycle over the REST API: what each state transition does to the
 * listings, to the row, and to the feed.
 */
describe('notes', () => {
  let ctx: E2EApp;
  let user: Actor;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    user = await ctx.registerUser();
  });

  it('trash and restore round-trip through listings', async () => {
    const note = await user.notes.create({ title: 'trash me' });
    await user.notes.trash(note.id);

    expect((await user.notes.listTrashed()).map((n) => n.id)).toEqual([
      note.id,
    ]);
    expect(await user.notes.list()).toEqual([]);

    await user.notes.restore(note.id);
    const row = await ctx.prisma.note.findUnique({ where: { id: note.id } });
    expect(row!.state).toBe('active');

    await user.http.patch(`/api/notes/${note.id}/restore`).expect(404);
  });

  it('permanent delete hides the note from reads and removes it from the feed', async () => {
    const note = await user.notes.create({ title: 'tombstone' });
    const { cursor } = await user.sync.drain();

    await user.notes.purge(note.id);

    await user.http.get(`/api/notes/${note.id}`).expect(404);

    const { entries } = await user.sync.drain({ cursor });
    expect(entryFor(entries, 'note', note.id)).toMatchObject({ op: 'remove' });
  });

  it('a tombstone stays gone across every write path', async () => {
    const note = await user.notes.create({ title: 'tombstone' });
    await user.notes.purge(note.id);

    await user.http
      .patch(`/api/notes/${note.id}`)
      .send({ title: 'back from the dead' })
      .expect(404);
    await user.http.delete(`/api/notes/${note.id}`).expect(404);
    expect(await user.notes.bulkTrash([note.id])).toEqual({ count: 0 });

    expect(
      await ctx.prisma.note.findUniqueOrThrow({ where: { id: note.id } }),
    ).toMatchObject({ state: 'deleted', title: 'tombstone' });
  });

  it('state transitions stamp stateChangedAt; other edits leave it alone', async () => {
    const note = await user.notes.create({ title: 'clock' });
    const created = await ctx.prisma.note.findUniqueOrThrow({
      where: { id: note.id },
    });

    await user.notes.update(note.id, { title: 'edited' });
    const edited = await ctx.prisma.note.findUniqueOrThrow({
      where: { id: note.id },
    });
    expect(edited.stateChangedAt).toEqual(created.stateChangedAt);

    await user.notes.trash(note.id);
    const trashed = await ctx.prisma.note.findUniqueOrThrow({
      where: { id: note.id },
    });
    expect(trashed.stateChangedAt.getTime()).toBeGreaterThan(
      created.stateChangedAt.getTime(),
    );
  });

  it('pins are per-user on shared notes', async () => {
    const sharee = await ctx.registerUser();
    const note = await user.notes.create({ title: 'shared pin' });
    await user.shares.grant(note.id, sharee.id, 'viewer');
    await sharee.notes.bulkPin([note.id], true);

    const shareeView = await sharee.sync.drain();
    expect(entryFor(shareeView.entries, 'note', note.id).note!.isPinned).toBe(
      true,
    );

    const ownerView = await user.sync.drain();
    expect(entryFor(ownerView.entries, 'note', note.id).note!.isPinned).toBe(
      false,
    );
  });

  it('bulk trash propagates through the delta feed', async () => {
    const note = await user.notes.create({ title: 'bulk trashed' });
    const { cursor } = await user.sync.drain();

    await user.notes.bulkTrash([note.id]);

    const { entries } = await user.sync.drain({ cursor });
    expect(entryFor(entries, 'note', note.id).note).toMatchObject({
      state: 'trashed',
    });
  });

  it('notes trashed together come back in a stable order', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push((await user.notes.create({ title: `note ${i}` })).id);
    }

    await user.notes.bulkTrash(ids);

    const stamps = await ctx.prisma.note.findMany({
      where: { id: { in: ids } },
      select: { updatedAt: true },
    });
    expect(new Set(stamps.map((n) => n.updatedAt.getTime())).size).toBe(1);

    const trashOrder = async () =>
      (await user.notes.listTrashed()).map((n) => n.id);

    const expected = [...ids].sort().reverse();
    expect(await trashOrder()).toEqual(expected);
    expect(await trashOrder()).toEqual(expected);
  });

  it('notes archived together keep their order', async () => {
    for (let i = 0; i < 6; i += 1) {
      await user.notes.create({ title: `note ${i}` });
    }
    const listed = (await user.notes.list()).map((n) => n.id);

    await user.notes.bulkArchive(listed);

    expect((await user.notes.listArchived()).map((n) => n.id)).toEqual(listed);
  });

  describe('make a copy', () => {
    const storedFilenames = async (noteId: string) =>
      (
        await ctx.prisma.noteAttachment.findMany({
          where: { noteId },
          orderBy: { position: 'asc' },
        })
      ).map((row) => row.storedFilename);

    it('copies the title, text, background, tags and attachments in order', async () => {
      const tag = await user.tags.create({ name: 'work' });
      const note = await user.notes.create({
        title: 'Packing list',
        content: '[{"insert":"socks\\n"}]',
        background: 'sand',
        tagIds: [tag.id],
      });
      await user.attachments.upload(note.id, 'first.png');
      await user.attachments.upload(note.id, 'second.png');
      const { cursor } = await user.sync.drain();

      const copy = await user.notes.duplicate(note.id);

      expect(copy.id).not.toBe(note.id);
      expect(copy).toMatchObject({
        title: 'Packing list',
        content: '[{"insert":"socks\\n"}]',
        background: 'sand',
        tagIds: [tag.id],
        permission: 'owner',
        userId: user.id,
        state: 'active',
        version: 1,
        attachmentCount: 2,
      });
      const originals = await user.attachments.list(note.id);
      const copies = await user.attachments.list(copy.id);
      expect(copies.map((a) => a.originalFilename)).toEqual(
        originals.map((a) => a.originalFilename),
      );
      expect(copies.map((a) => a.type)).toEqual(originals.map((a) => a.type));
      expect(copies.map((a) => a.id)).not.toContain(originals[0].id);
      const copiedFiles = await storedFilenames(copy.id);
      expect(copiedFiles).not.toEqual(await storedFilenames(note.id));

      // The files are copies: they outlive the original's.
      for (const attachment of originals) {
        await user.http
          .delete(`/api/notes/${note.id}/attachments/${attachment.id}`)
          .expect(200);
      }
      for (const attachment of copies) {
        await user.http
          .get(`/api/notes/${copy.id}/attachments/${attachment.id}`)
          .expect(200);
      }

      const { entries } = await user.sync.drain({ cursor });
      expect(entryFor(entries, 'note', copy.id).note).toMatchObject({
        title: 'Packing list',
        tagIds: [tag.id],
      });
      expect(
        entryFor(entries, 'attachments', copy.id).attachments,
      ).toHaveLength(2);
    });

    it('leaves the shares, pin, archive, reminder and history behind', async () => {
      const friend = await ctx.registerUser('Friend');
      const note = await user.notes.create({
        title: 'kept to myself',
        isPinned: true,
        isArchived: true,
        reminder: { remindAt: '2026-10-01T09:00' },
      });
      await user.shares.grant(note.id, friend.id, 'editor');
      await user.notes.update(note.id, { content: 'an edit with history' });

      const copy = await user.notes.duplicate(note.id);

      expect(copy).toMatchObject({
        content: 'an edit with history',
        isPinned: false,
        isArchived: false,
        reminder: null,
        shareIds: [],
      });
      const where = { noteId: copy.id };
      expect(await ctx.prisma.noteShare.count({ where })).toBe(0);
      expect(await ctx.prisma.notePin.count({ where })).toBe(0);
      expect(await ctx.prisma.noteArchive.count({ where })).toBe(0);
      expect(await ctx.prisma.noteReminder.count({ where })).toBe(0);
      expect(await ctx.prisma.noteRevision.count({ where })).toBe(0);
      const friendFeed = await friend.sync.drain();
      expect(entryFor(friendFeed.entries, 'note', copy.id)).toBeUndefined();
    });

    it('gives someone the note is shared with a copy of their own', async () => {
      const friend = await ctx.registerUser('Friend');
      const ownerTag = await user.tags.create({ name: 'owner tag' });
      const friendTag = await friend.tags.create({ name: 'friend tag' });
      const note = await user.notes.create({
        title: 'shared recipe',
        tagIds: [ownerTag.id],
      });
      await user.attachments.upload(note.id, 'photo.png');
      await user.shares.grant(note.id, friend.id, 'viewer');
      await friend.notes.update(note.id, { tagIds: [friendTag.id] });
      const ownerFeed = await user.sync.drain();

      const copy = await friend.notes.duplicate(note.id);

      expect(copy).toMatchObject({
        title: 'shared recipe',
        userId: friend.id,
        permission: 'owner',
        tagIds: [friendTag.id],
        attachmentCount: 1,
      });
      const rows = await ctx.prisma.noteAttachment.findMany({
        where: { noteId: copy.id },
      });
      expect(rows.map((row) => row.uploadedByUserId)).toEqual([friend.id]);
      await user.http.get(`/api/notes/${copy.id}`).expect(404);
      const { entries } = await user.sync.drain({ cursor: ownerFeed.cursor });
      expect(entryFor(entries, 'note', copy.id)).toBeUndefined();
    });

    it('copies only a note the person can read and that is not in the trash', async () => {
      const stranger = await ctx.registerUser('Stranger');
      const note = await user.notes.create({ title: 'private' });
      await stranger.http.post(`/api/notes/${note.id}/duplicate`).expect(404);

      await user.notes.trash(note.id);
      await user.http.post(`/api/notes/${note.id}/duplicate`).expect(404);

      await user.notes.purge(note.id);
      await user.http.post(`/api/notes/${note.id}/duplicate`).expect(404);

      expect(await ctx.prisma.note.count()).toBe(1);
    });
  });
});
