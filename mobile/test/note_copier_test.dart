import 'package:anchor/core/database/app_database.dart';
import 'package:anchor/features/notes/data/repository/note_copier.dart';
import 'package:dio/dio.dart';
import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class MockDio extends Mock implements Dio {}

void main() {
  late AppDatabase db;
  late MockDio dio;
  late List<String> calls;
  late bool syncWorks;
  late NoteCopier copier;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    dio = MockDio();
    calls = [];
    syncWorks = true;
    copier = NoteCopier(dio, db, () async {
      calls.add('sync');
      return syncWorks;
    });
    when(() => dio.post(any())).thenAnswer((invocation) async {
      calls.add('post ${invocation.positionalArguments.first}');
      return Response(
        requestOptions: RequestOptions(path: '/api/notes/n1/duplicate'),
        statusCode: 201,
        data: {'id': 'copy-1', 'title': 'Groceries'},
      );
    });
  });

  tearDown(() => db.close());

  Future<void> insertNote({bool isSynced = true}) => db
      .into(db.notes)
      .insert(
        NotesCompanion.insert(
          id: 'n1',
          title: 'Groceries',
          isSynced: Value(isSynced),
        ),
      );

  Future<void> insertPicture(String syncStatus) => db
      .into(db.noteAttachments)
      .insert(
        NoteAttachmentsCompanion.insert(
          id: 'a1',
          noteId: 'n1',
          type: 'image',
          originalFilename: 'a1.jpg',
          mimeType: 'image/jpeg',
          fileSize: 100,
          syncStatus: Value(syncStatus),
        ),
      );

  test('sends the edits first, copies on the server, then brings the copy '
      'in', () async {
    await insertNote();
    await insertPicture('synced');

    expect(await copier.copy('n1'), 'copy-1');
    expect(calls, ['sync', 'post /api/notes/n1/duplicate', 'sync']);
  });

  test(
    'copies nothing while the note has edits that have not synced',
    () async {
      await insertNote(isSynced: false);

      await expectLater(
        copier.copy('n1'),
        throwsA(isA<NoteNotSyncedException>()),
      );
      expect(calls, ['sync']);
    },
  );

  test('copies nothing while a picture waits to upload', () async {
    await insertNote();
    await insertPicture('upload_failed');

    await expectLater(
      copier.copy('n1'),
      throwsA(isA<NoteNotSyncedException>()),
    );
    expect(calls, ['sync']);
  });

  test('copies nothing when the sync fails', () async {
    await insertNote();
    syncWorks = false;

    await expectLater(
      copier.copy('n1'),
      throwsA(isA<NoteNotSyncedException>()),
    );
    expect(calls, ['sync']);
  });
}
