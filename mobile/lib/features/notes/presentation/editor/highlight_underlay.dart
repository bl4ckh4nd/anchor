import 'package:flutter/material.dart';
import 'package:flutter_quill/flutter_quill.dart';

import '../../../../core/theme/note_typography.dart';
import '../../../../core/widgets/marker_stroke.dart';
import 'checklist_fold.dart';
import 'editor_format.dart';
import 'list_markers.dart';
import 'search_matches.dart';

class HighlightUnderlay extends CustomPainter {
  HighlightUnderlay({
    required Listenable repaint,
    required this.controller,
    required this.editor,
    required this.stack,
    required this.colors,
    required this.isDragged,
    required this.typography,
    required this.textScaler,
    this.searchMatches = const [],
    this.searchIndex = -1,
  }) : super(repaint: repaint);

  final QuillController controller;
  final RenderEditor? Function() editor;
  final RenderBox? Function() stack;
  final Color Function(String name) colors;

  final bool Function(Line line) isDragged;

  final NoteTypography typography;
  final TextScaler textScaler;

  /// Filled in over the text, apart from folded lines.
  final List<TextRange> searchMatches;
  final int searchIndex;

  @override
  void paint(Canvas canvas, Size size) {
    final render = editor();
    final host = stack();
    if (render == null || host == null || !render.attached || !render.hasSize) {
      return;
    }
    var offset = 0;
    for (final node in controller.document.root.children) {
      _paintNode(canvas, node, render, host, offset);
      offset += node.length;
    }
    _paintSearchMatches(canvas, render, host);
  }

  void _paintSearchMatches(Canvas canvas, RenderEditor render, RenderBox host) {
    final length = controller.document.length;
    for (final (i, match) in searchMatches.indexed) {
      if (match.end > length) return;
      final line = controller.document.queryChild(match.start).node;
      if (line is! Line || isFoldedLine(line)) continue;
      final fill = Paint()
        ..color = searchMatchFill(isCurrent: i == searchIndex);
      for (final rect in _lineRects(
        render,
        host,
        match.start,
        match.end,
        line,
      )) {
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            rect.inflate(1),
            const Radius.circular(3), // off-scale: hugs the letters
          ),
          fill,
        );
      }
    }
  }

  /// Where the text from [start] to [end] is, one rectangle per screen line,
  /// as tall as the letters of [line].
  Iterable<Rect> _lineRects(
    RenderEditor render,
    RenderBox host,
    int start,
    int end,
    Line line,
  ) sync* {
    final level = line.style.attributes[Attribute.header.key]?.value;
    final style = level is int ? typography.heading(level) : typography.body;
    final font = typography.font;
    final fontSize = textScaler.scale(style.fontSize!);
    final textHeight = (font.ascent + font.descent) * fontSize;
    var position = start;
    var guard = 0;
    while (position < end && guard++ < 200) {
      final screenLine = render.getLineAtOffset(TextPosition(offset: position));
      final segmentEnd = screenLine.end.clamp(position, end);
      if (segmentEnd <= position) break;
      final startRect = render.getLocalRectForCaret(
        TextPosition(offset: position),
      );
      final endRect = render.getLocalRectForCaret(
        TextPosition(offset: segmentEnd, affinity: TextAffinity.upstream),
      );
      final topLeft = host.globalToLocal(
        render.localToGlobal(startRect.topLeft),
      );
      final right = host
          .globalToLocal(
            render.localToGlobal(Offset(endRect.left, startRect.top)),
          )
          .dx;
      // The caret is as tall as the line, and the letters sit in its middle.
      final top = topLeft.dy + (startRect.height - textHeight) / 2;
      yield Rect.fromLTWH(topLeft.dx, top, right - topLeft.dx, textHeight);
      position = segmentEnd;
    }
  }

  void _paintNode(
    Canvas canvas,
    Node node,
    RenderEditor render,
    RenderBox host,
    int start,
  ) {
    if (node is Block) {
      var at = start;
      for (final child in node.children) {
        _paintNode(canvas, child, render, host, at);
        at += child.length;
      }
      return;
    }
    if (node is! Line || isFoldedLine(node)) return;
    final isDimmed = isDragged(node);
    var at = start;
    // Runs next to each other with the same highlight are one mark.
    String? name;
    var runStart = 0;
    var runText = StringBuffer();
    void flush(int end) {
      final highlightName = name;
      if (highlightName != null && end > runStart) {
        _paintRange(
          canvas,
          render,
          host,
          runStart,
          end,
          highlightName,
          runText.toString(),
          line: node,
          isDimmed: isDimmed,
        );
      }
      name = null;
      runText = StringBuffer();
    }

    for (final leaf in node.children) {
      final value = leaf.style.attributes[highlightKey]?.value;
      if (value is String && value == name) {
        runText.write(leaf.toPlainText());
      } else {
        flush(at);
        if (value is String) {
          name = value;
          runStart = at;
          runText.write(leaf.toPlainText());
        }
      }
      at += leaf.length;
    }
    flush(at);
  }

  void _paintRange(
    Canvas canvas,
    RenderEditor render,
    RenderBox host,
    int start,
    int end,
    String name,
    String text, {
    required Line line,
    required bool isDimmed,
  }) {
    final color = isDimmed ? draggedColor(colors(name)) : colors(name);
    final key = '$name|${text.length > 14 ? text.substring(0, 14) : text}';
    final level = line.style.attributes[Attribute.header.key]?.value;
    final style = level is int ? typography.heading(level) : typography.body;
    final fontSize = textScaler.scale(style.fontSize!);
    for (final (index, rect) in _lineRects(
      render,
      host,
      start,
      end,
      line,
    ).indexed) {
      MarkerStroke.paint(
        canvas,
        rect,
        color,
        key: key,
        index: index,
        fontSize: fontSize,
      );
    }
  }

  @override
  bool shouldRepaint(HighlightUnderlay old) => true;
}
