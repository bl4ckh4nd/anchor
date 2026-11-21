import 'package:flutter/material.dart';

import '../../../../core/theme/tokens/anchor_tokens.dart';

/// Where [query] is in [text], matched like the notes list's search.
List<TextRange> findMatches(String text, String query) {
  final term = query.trim().toLowerCase();
  if (term.isEmpty || term.contains('\n')) return const [];
  var lower = text.toLowerCase();
  // Each index of `lower` to the index in `text` it came from.
  List<int>? at;
  if (lower.length != text.length) {
    final buffer = StringBuffer();
    at = [];
    var i = 0;
    for (final rune in text.runes) {
      final char = String.fromCharCode(rune);
      final lowerChar = char.toLowerCase();
      buffer.write(lowerChar);
      for (var k = 0; k < lowerChar.length; k++) {
        at.add(i);
      }
      i += char.length;
    }
    at.add(text.length);
    lower = buffer.toString();
  }
  final matches = <TextRange>[];
  for (
    var i = lower.indexOf(term);
    i != -1;
    i = lower.indexOf(term, i + term.length)
  ) {
    final start = at?[i] ?? i;
    final end = at?[i + term.length] ?? i + term.length;
    if (end > start) matches.add(TextRange(start: start, end: end));
  }
  return matches;
}

/// The fill behind a search match; the current one is stronger.
Color searchMatchFill({required bool isCurrent}) =>
    AnchorTokens.colorAccentFill.withValues(alpha: isCurrent ? 0.55 : 0.24);

/// [text] with [matches] filled in; [current] indexes [matches], or is -1.
TextSpan markedSpan(
  String text,
  List<TextRange> matches, {
  required int current,
  TextStyle? style,
}) {
  final parts = <TextSpan>[];
  var at = 0;
  for (final (i, match) in matches.indexed) {
    if (match.end > text.length) break;
    parts
      ..add(TextSpan(text: text.substring(at, match.start)))
      ..add(
        TextSpan(
          text: match.textInside(text),
          style: TextStyle(
            backgroundColor: searchMatchFill(isCurrent: i == current),
          ),
        ),
      );
    at = match.end;
  }
  parts.add(TextSpan(text: text.substring(at)));
  return TextSpan(style: style, children: parts);
}

/// A text field's text with search matches filled in, without changing it.
class MarkedTextController extends TextEditingController {
  /// Read on the field's next build; set them before it.
  List<TextRange> matches = const [];
  int current = -1;

  @override
  TextSpan buildTextSpan({
    required BuildContext context,
    TextStyle? style,
    required bool withComposing,
  }) => matches.isEmpty
      ? super.buildTextSpan(
          context: context,
          style: style,
          withComposing: withComposing,
        )
      : markedSpan(text, matches, current: current, style: style);
}
