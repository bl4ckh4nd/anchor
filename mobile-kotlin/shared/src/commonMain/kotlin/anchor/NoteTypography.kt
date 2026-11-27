package anchor

import anchor.resources.Res
import anchor.resources.literata
import anchor.resources.literata_bold
import anchor.resources.literata_bold_italic
import anchor.resources.literata_italic
import anchor.resources.literata_medium
import anchor.resources.literata_semibold
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.isSpecified
import org.jetbrains.compose.resources.Font

internal enum class NoteFont(val label: String, val editorScale: Float = 1f) {
    Sans("Sans"), Serif("Serif"), Mono("Mono", 0.9f),
}

internal enum class NoteTextSize(val label: String, val scale: Float) {
    Small("Small", 0.88f), Default("Default", 1f), Large("Large", 1.12f),
}

internal data class NoteTypography(val family: FontFamily, val scale: Float, val leadingScale: Float = 1f) {
    fun style(base: TextStyle, scaled: Boolean = false): TextStyle = base.copy(
        fontFamily = family,
        fontSize = if (scaled && base.fontSize.isSpecified) base.fontSize * scale else base.fontSize,
        lineHeight = if (scaled && base.lineHeight.isSpecified) base.lineHeight * (scale * leadingScale) else base.lineHeight,
    )

    fun headings(base: Typography, scaled: Boolean = false) =
        listOf(base.headlineSmall, base.titleLarge, base.titleMedium).map { style(it, scaled).toSpanStyle() }
}

internal val LocalNoteTypography = staticCompositionLocalOf { NoteTypography(FontFamily.SansSerif, 1f) }

@Composable
internal fun noteSerifFamily(): FontFamily {
    val regular = Font(Res.font.literata)
    val italic = Font(Res.font.literata_italic, style = FontStyle.Italic)
    val medium = Font(Res.font.literata_medium, FontWeight.Medium)
    val semibold = Font(Res.font.literata_semibold, FontWeight.SemiBold)
    val bold = Font(Res.font.literata_bold, FontWeight.Bold)
    val boldItalic = Font(Res.font.literata_bold_italic, FontWeight.Bold, FontStyle.Italic)
    return remember(regular, italic, medium, semibold, bold, boldItalic) {
        FontFamily(regular, italic, medium, semibold, bold, boldItalic)
    }
}
