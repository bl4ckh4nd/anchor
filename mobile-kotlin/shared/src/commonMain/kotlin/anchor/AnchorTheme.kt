package anchor

import anchor.resources.Res
import anchor.resources.dm_sans
import anchor.resources.dm_sans_italic
import anchor.resources.jetbrains_mono
import anchor.resources.jetbrains_mono_bold
import anchor.resources.jetbrains_mono_bold_italic
import anchor.resources.jetbrains_mono_italic
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.Font

// Keep the standard palettes in sync with web/app/styles/tokens.css.
private val light = lightColorScheme(
    primary = Color(0xFF2D3142),
    onPrimary = Color.White,
    secondary = Color(0xFFA44004),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFF2D3142),
    onSecondaryContainer = Color.White,
    background = Color(0xFFF0F4F8),
    onBackground = Color(0xFF2D3142),
    surface = Color.White,
    onSurface = Color(0xFF2D3142),
    onSurfaceVariant = Color(0xFF4F5D75),
    tertiary = Color(0xFFCC5F2D),
    onTertiary = Color.White,
    surfaceContainer = Color(0xFFE8ECF1),
    surfaceContainerHigh = Color.White,
    surfaceContainerLow = Color(0xFFE9EEF3),
    surfaceContainerLowest = Color.White,
    inverseSurface = Color(0xFF2D3142),
    inverseOnSurface = Color(0xFFF5F6F8),
    inversePrimary = Color(0xFFF39A70),
    outline = Color(0xFF788497),
    outlineVariant = Color(0xFFD8DEE6),
    error = Color(0xFFC0392B),
    onError = Color.White,
    scrim = Color(0x5C1C1F2A),
)

private val dark = darkColorScheme(
    primary = Color(0xFFEAEAEA),
    onPrimary = Color(0xFF111214),
    secondary = Color(0xFFFE976C),
    onSecondary = Color(0xFF111214),
    secondaryContainer = Color(0xFFEAEAEA),
    onSecondaryContainer = Color(0xFF111214),
    background = Color(0xFF111214),
    onBackground = Color(0xFFEAEAEA),
    surface = Color(0xFF1C1D21),
    onSurface = Color(0xFFEAEAEA),
    onSurfaceVariant = Color(0xFF9CA8B8),
    tertiary = Color(0xFFEF8354),
    onTertiary = Color(0xFF111214),
    surfaceContainer = Color(0xFF26272C),
    surfaceContainerHigh = Color(0xFF1C1D21),
    surfaceContainerLow = Color(0xFF0A0B0C),
    surfaceContainerLowest = Color(0xFF1C1D21),
    inverseSurface = Color(0xFFE4E6EB),
    inverseOnSurface = Color(0xFF111214),
    inversePrimary = Color(0xFFA8440F),
    outline = Color(0xFF6B7482),
    outlineVariant = Color(0xFF34353A),
    error = Color(0xFFFF8A80),
    onError = Color(0xFF111214),
    scrim = Color(0x9906070A),
)

// Web colors used outside the Material color scheme.
internal class AnchorTones(
    val warn: Color,
    val onWarn: Color,
    val divider: Color,
    val added: Color,
    val addedInk: Color,
    val removedInk: Color,
    val late: Color,
)

private val lightTones = AnchorTones(
    warn = Color(0xFFFDECC8), onWarn = Color(0xFF8A4B08), divider = Color(0xFFE6EBF1), added = Color(0xFF1F9D55),
    addedInk = Color(0xFF166F44), removedInk = Color(0xFFB02237), late = Color(0xFFA61E14),
)
private val darkTones = AnchorTones(
    warn = Color(0xFF4A3413), onWarn = Color(0xFFFCD49A), divider = Color(0xFF26272C), added = Color(0xFF3FCF8E),
    addedInk = Color(0xFF6FE3A8), removedInk = Color(0xFFFF9AA9), late = Color(0xFFFF9D94),
)
internal val LocalAnchorTones = staticCompositionLocalOf { lightTones }

private val anchorShapes = Shapes(
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(16.dp),
)

private val anchorBaseTypography = Typography()
internal val LocalAnchorCodeFont = staticCompositionLocalOf<FontFamily> { FontFamily.Monospace }
internal val LocalAnchorDarkTheme = staticCompositionLocalOf { false }
internal val LocalAnchorDensity = staticCompositionLocalOf { AnchorDensity.Standard }

internal enum class AnchorAppearance(val label: String) {
    Light("Light"), Dark("Dark"), System("Match system"),
}

@Composable
private fun anchorTypography(): Typography {
    val regular = Font(Res.font.dm_sans)
    val medium = Font(Res.font.dm_sans, FontWeight.Medium)
    val semibold = Font(Res.font.dm_sans, FontWeight.SemiBold)
    val bold = Font(Res.font.dm_sans, FontWeight.Bold)
    val italic = Font(
        Res.font.dm_sans_italic, FontWeight.Normal, FontStyle.Italic,
        variationSettings = FontVariation.Settings(FontVariation.weight(400)),
    )
    val boldItalic = Font(
        Res.font.dm_sans_italic, FontWeight.Bold, FontStyle.Italic,
        variationSettings = FontVariation.Settings(FontVariation.weight(700)),
    )
    return remember(regular, medium, semibold, bold, italic, boldItalic) {
        val family = FontFamily(regular, medium, semibold, bold, italic, boldItalic)
        with(anchorBaseTypography) {
            copy(
                displayLarge = displayLarge.copy(fontFamily = family),
                displayMedium = displayMedium.copy(fontFamily = family),
                displaySmall = displaySmall.copy(fontFamily = family),
                headlineLarge = headlineLarge.copy(fontFamily = family),
                headlineMedium = headlineMedium.copy(fontFamily = family),
                headlineSmall = headlineSmall.copy(fontFamily = family),
                titleLarge = titleLarge.copy(fontFamily = family),
                titleMedium = titleMedium.copy(fontFamily = family),
                titleSmall = titleSmall.copy(fontFamily = family),
                bodyLarge = bodyLarge.copy(fontFamily = family),
                bodyMedium = bodyMedium.copy(fontFamily = family),
                bodySmall = bodySmall.copy(fontFamily = family),
                labelLarge = labelLarge.copy(fontFamily = family),
                labelMedium = labelMedium.copy(fontFamily = family),
                labelSmall = labelSmall.copy(fontFamily = family),
            )
        }
    }
}

@Composable
internal fun AnchorTheme(
    darkTheme: Boolean,
    noteFont: NoteFont,
    noteTextSize: NoteTextSize,
    density: AnchorDensity,
    content: @Composable () -> Unit,
) {
    val regular = Font(Res.font.jetbrains_mono)
    val bold = Font(Res.font.jetbrains_mono_bold, FontWeight.Bold)
    val italic = Font(Res.font.jetbrains_mono_italic, style = FontStyle.Italic)
    val boldItalic = Font(Res.font.jetbrains_mono_bold_italic, FontWeight.Bold, FontStyle.Italic)
    val codeFont = remember(regular, bold, italic, boldItalic) { FontFamily(regular, bold, italic, boldItalic) }
    val typography = anchorTypography()
    val family = when (noteFont) {
        NoteFont.Sans -> checkNotNull(typography.bodyLarge.fontFamily)
        NoteFont.Serif -> noteSerifFamily()
        NoteFont.Mono -> codeFont
    }
    CompositionLocalProvider(
        LocalAnchorCodeFont provides codeFont,
        LocalAnchorDarkTheme provides darkTheme,
        LocalAnchorDensity provides density,
        LocalAnchorTones provides if (darkTheme) darkTones else lightTones,
        LocalNoteTypography provides NoteTypography(family, noteTextSize.scale * noteFont.editorScale, density.leadingScale),
    ) {
        MaterialTheme(
            colorScheme = if (darkTheme) dark else light,
            shapes = anchorShapes,
            typography = typography,
            content = content,
        )
    }
}
