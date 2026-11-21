import 'package:anchor/features/notes/presentation/editor/search_matches.dart';
import 'package:flutter/services.dart';
import 'package:flutter_quill/flutter_quill.dart';
import 'package:flutter_test/flutter_test.dart';

List<String> found(String text, String query) => [
  for (final match in findMatches(text, query)) match.textInside(text),
];

void main() {
  test('finds nothing for an empty or blank search', () {
    expect(findMatches('bias probe', ''), isEmpty);
    expect(findMatches('bias probe', '   '), isEmpty);
  });

  test('finds every match whatever its case, trimmed like the list', () {
    const text = 'Bias probe, then the BIAS PROBE again';
    expect(findMatches(text, '  bias probe '), const [
      TextRange(start: 0, end: 10),
      TextRange(start: 21, end: 31),
    ]);
    expect(found(text, 'bias PROBE'), ['Bias probe', 'BIAS PROBE']);
  });

  test("doesn't count overlapping matches twice", () {
    expect(findMatches('aaaa', 'aa'), const [
      TextRange(start: 0, end: 2),
      TextRange(start: 2, end: 4),
    ]);
  });

  test('finds nothing across two lines', () {
    expect(findMatches('bias\nprobe', 'bias probe'), isEmpty);
  });

  test(
    'points into the text as written when lower case changes its length',
    () {
      const text = 'İstanbul bias, İzmir bias';
      expect(found(text, 'bias'), ['bias', 'bias']);
      expect(found(text, 'İZMIR'), ['İzmir']);
    },
  );

  test("the document's plain text has its offsets, embeds included", () {
    final document = Document.fromJson([
      {'insert': 'before '},
      {
        'insert': {'divider': true},
      },
      {'insert': '\nbias probe\n'},
    ]);
    final text = document.toPlainText();
    expect(text.length, document.length);
    final match = findMatches(text, 'bias probe').single;
    expect(
      document.getPlainText(match.start, match.end - match.start),
      'bias probe',
    );
  });
}
