import 'package:anchor/app/app_bootstrap.dart';
import 'package:anchor/core/storage/preferences_repository.dart';
import 'package:anchor/core/theme/app_theme.dart';
import 'package:anchor/features/notes/domain/note.dart';
import 'package:anchor/features/notes/presentation/notes_list_controller.dart';
import 'package:anchor/features/notes/presentation/widgets/card_body.dart';
import 'package:anchor/features/notes/presentation/widgets/notes_board.dart';
import 'package:anchor/features/settings/presentation/theme_preferences_controller.dart';
import 'package:anchor/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class _MockPreferences extends Mock implements PreferencesRepository {}

void main() {
  final notes = [for (var i = 0; i < 30; i++) Note(id: 'n$i', title: '$i')];

  Future<ProviderContainer> pumpBoard(
    WidgetTester tester, {
    required bool showCardPictures,
  }) async {
    final preferences = _MockPreferences();
    when(() => preferences.setShowCardPictures(any())).thenAnswer((_) async {});
    final container = ProviderContainer(
      overrides: [
        preferencesRepositoryProvider.overrideWithValue(preferences),
        appBootstrapProvider.overrideWithValue(
          AppBootstrap(showCardPictures: showCardPictures),
        ),
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.light(),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Scaffold(
            body: CustomScrollView(
              slivers: [
                NotesBoard(
                  groups: [NoteGroup(NoteGroupKind.all, notes)],
                  layout: CardLayout.masonry,
                  generation: 0,
                  contentKey: GlobalKey(),
                  // Stands in for a card whose pictures make it taller.
                  cardBuilder: (note, i) => Consumer(
                    builder: (context, ref, _) => SizedBox(
                      height: ref.watch(cardPicturesControllerProvider)
                          ? 300
                          : 100,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    return container;
  }

  double scrollExtent(WidgetTester tester) => tester
      .state<ScrollableState>(find.byType(Scrollable))
      .position
      .maxScrollExtent;

  testWidgets('cards measured before the pictures setting changes take '
      'their new heights', (tester) async {
    await pumpBoard(tester, showCardPictures: false);
    final withoutPictures = scrollExtent(tester);
    await tester.pumpWidget(const SizedBox());

    final container = await pumpBoard(tester, showCardPictures: true);
    final scrollable = find.byType(Scrollable);
    await tester.drag(scrollable, const Offset(0, -100000));
    await tester.pumpAndSettle();
    await tester.drag(scrollable, const Offset(0, 100000));
    await tester.pumpAndSettle();

    await container
        .read(cardPicturesControllerProvider.notifier)
        .setShown(false);
    await tester.pumpAndSettle();

    expect(scrollExtent(tester), withoutPictures);
  });
}
