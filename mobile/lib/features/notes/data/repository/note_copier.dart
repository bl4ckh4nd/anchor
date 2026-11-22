import 'package:dio/dio.dart';
import 'package:drift/drift.dart' as drift;
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../../core/database/app_database.dart';
import '../../../../core/network/dio_provider.dart';
import '../../../sync/data/sync_manager.dart';
import '../../domain/note_attachment.dart';
import '../local/note_rows.dart';

part 'note_copier.g.dart';

@Riverpod(keepAlive: true)
NoteCopier noteCopier(Ref ref) => NoteCopier(
  ref.watch(dioProvider),
  ref.watch(appDatabaseProvider),
  () => ref.read(syncManagerProvider.notifier).requestSync(),
);

/// The note has changes this phone hasn't sent yet, so a copy would miss them.
class NoteNotSyncedException implements Exception {
  const NoteNotSyncedException();
}

/// The server makes copies; sync brings them to this phone.
class NoteCopier {
  NoteCopier(this._dio, this._db, this._sync);

  final Dio _dio;
  final AppDatabase _db;

  /// Completes with whether everything synced.
  final Future<bool> Function() _sync;

  /// Returns the copy's id. Request errors reach the caller.
  Future<String> copy(String noteId) async {
    if (!await _sync() || !await _isSynced(noteId)) {
      throw const NoteNotSyncedException();
    }
    final response = await _dio.post('/api/notes/$noteId/duplicate');
    final copyId = (response.data as Map<String, dynamic>)['id'] as String;
    await _sync();
    return copyId;
  }

  Future<bool> _isSynced(String noteId) async {
    final note = await _db.noteRow(noteId);
    if (note == null || !note.isSynced) return false;
    final waiting =
        await (_db.select(_db.noteAttachments)
              ..where(
                (tbl) =>
                    tbl.noteId.equals(noteId) &
                    tbl.syncStatus
                        .equals(AttachmentSyncStatus.synced.dbValue)
                        .not(),
              )
              ..limit(1))
            .get();
    return waiting.isEmpty;
  }
}
