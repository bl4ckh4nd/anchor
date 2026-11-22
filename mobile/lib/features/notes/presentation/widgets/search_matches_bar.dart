import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/app_typography.dart';
import '../../../../core/theme/context_extensions.dart';
import '../../../../core/theme/tokens/anchor_tokens.dart';
import '../../../../core/widgets/app_buttons.dart';
import '../../../../l10n/l10n.dart';
import 'note_surface.dart';

/// Steps through the matches of the search a note was opened from.
class SearchMatchesBar extends StatelessWidget {
  const SearchMatchesBar({
    super.key,
    required this.query,
    required this.current,
    required this.total,
    required this.appearance,
    required this.onPrevious,
    required this.onNext,
    required this.onStop,
  });

  final String query;

  /// From 0.
  final int current;
  final int total;
  final NoteAppearance appearance;
  final VoidCallback onPrevious;
  final VoidCallback onNext;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final colors = context.anchor;
    final l10n = context.l10n;
    final style = AppTypography.secondary.copyWith(
      color: appearance.colors.muted,
    );
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape): onStop,
        const SingleActivator(LogicalKeyboardKey.enter, shift: true):
            onPrevious,
      },
      child: Container(
        padding: const EdgeInsets.only(
          left: AnchorTokens.space12,
          right: AnchorTokens.space4,
        ),
        decoration: BoxDecoration(
          color: appearance.colors.surface,
          borderRadius: BorderRadius.circular(AnchorTokens.radiusLg),
          border: Border.all(
            color: appearance.colors.border.withValues(alpha: 0.7),
          ),
          boxShadow: colors.shadowFloating,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: Text(
                l10n.noteSearchTerm(query),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: style.copyWith(
                  color: colors.appText,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
            const SizedBox(width: AnchorTokens.space8),
            Semantics(
              liveRegion: true,
              child: Text(
                l10n.noteSearchCount(current + 1, total),
                style: style.copyWith(
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ),
            const SizedBox(width: AnchorTokens.space4),
            BarButton(
              icon: LucideIcons.arrowUp,
              label: l10n.noteSearchPrevious,
              size: BarButtonSize.small,
              onPressed: onPrevious,
            ),
            BarButton(
              icon: LucideIcons.arrowDown,
              label: l10n.noteSearchNext,
              size: BarButtonSize.small,
              onPressed: onNext,
            ),
            BarButton(
              icon: LucideIcons.x,
              label: l10n.noteSearchStop,
              size: BarButtonSize.small,
              onPressed: onStop,
            ),
          ],
        ),
      ),
    );
  }
}
