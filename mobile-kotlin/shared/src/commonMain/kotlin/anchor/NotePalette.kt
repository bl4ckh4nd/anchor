// Generated from design/tokens by design/build/build.mjs. Do not edit by hand.
package anchor

import anchor.resources.Res
import anchor.resources.pattern_dots
import anchor.resources.pattern_grid
import anchor.resources.pattern_lines
import anchor.resources.pattern_waves
import anchor.resources.pattern_groceries
import anchor.resources.pattern_music
import anchor.resources.pattern_travel
import anchor.resources.pattern_code
import org.jetbrains.compose.resources.DrawableResource

internal data class NotePatternTile(val drawable: DrawableResource, val lightColor: Long, val darkColor: Long)

internal data class NotePalette(
    val lightFill: Long,
    val lightEdge: Long,
    val darkFill: Long,
    val darkEdge: Long,
    val pattern: NotePatternTile? = null,
)

private val notePalettes = mapOf(
    "color_yellow" to NotePalette(0xFFFFF3CA, 0xFFE6D5A1, 0xFF372904, 0xFF544623),
    "color_orange" to NotePalette(0xFFFFEAD6, 0xFFEFCAB0, 0xFF3F240C, 0xFF5E4029),
    "color_brown" to NotePalette(0xFFFAEDE5, 0xFFE5CDBF, 0xFF352820, 0xFF52453C),
    "color_red" to NotePalette(0xFFFFE8E4, 0xFFF2C7C2, 0xFF431F1D, 0xFF623C39),
    "color_pink" to NotePalette(0xFFFFE8F3, 0xFFEBC7D7, 0xFF3F1F2F, 0xFF5E3B4C),
    "color_purple" to NotePalette(0xFFFAEAFD, 0xFFE0CAE5, 0xFF37223C, 0xFF553E5A),
    "color_dark_blue" to NotePalette(0xFFECEEFF, 0xFFCCD0F0, 0xFF262748, 0xFF414468),
    "color_blue" to NotePalette(0xFFE0F3FF, 0xFFBBD6EF, 0xFF102E45, 0xFF2D4B64),
    "color_teal" to NotePalette(0xFFDAF7F6, 0xFFB1DCDC, 0xFF083232, 0xFF294F4F),
    "color_green" to NotePalette(0xFFE0F7E4, 0xFFBCDCC2, 0xFF17321E, 0xFF344F39),
    "pattern_dots" to NotePalette(
        0xFFEEF0F3, 0xFFCAD4DF, 0xFF282C30, 0xFF44484C,
        NotePatternTile(Res.drawable.pattern_dots, 0xFFD6E3F1, 0xFF39424C),
    ),
    "pattern_grid" to NotePalette(
        0xFFFFF3CA, 0xFFE6D5A1, 0xFF372904, 0xFF544623,
        NotePatternTile(Res.drawable.pattern_grid, 0xFFF6E4AC, 0xFF503F0F),
    ),
    "pattern_lines" to NotePalette(
        0xFFE0F3FF, 0xFFBBD6EF, 0xFF102E45, 0xFF2D4B64,
        NotePatternTile(Res.drawable.pattern_lines, 0xFFC7E6FF, 0xFF1F4462),
    ),
    "pattern_waves" to NotePalette(
        0xFFE0F7E4, 0xFFBCDCC2, 0xFF17321E, 0xFF344F39,
        NotePatternTile(Res.drawable.pattern_waves, 0xFFC8ECCE, 0xFF274A2F),
    ),
    "pattern_groceries" to NotePalette(
        0xFFFFE8E4, 0xFFF2C7C2, 0xFF431F1D, 0xFF623C39,
        NotePatternTile(Res.drawable.pattern_groceries, 0xFFFFD4CF, 0xFF60322F),
    ),
    "pattern_music" to NotePalette(
        0xFFFAEAFD, 0xFFE0CAE5, 0xFF37223C, 0xFF553E5A,
        NotePatternTile(Res.drawable.pattern_music, 0xFFF1D7F6, 0xFF513557),
    ),
    "pattern_travel" to NotePalette(
        0xFFDAF7F6, 0xFFB1DCDC, 0xFF083232, 0xFF294F4F,
        NotePatternTile(Res.drawable.pattern_travel, 0xFFBCECEB, 0xFF124A4A),
    ),
    "pattern_code" to NotePalette(
        0xFFE9F2F7, 0xFFC2D6E2, 0xFF212D35, 0xFF3C4A52,
        NotePatternTile(Res.drawable.pattern_code, 0xFFCEE5F4, 0xFF2F4451),
    ),
)

internal val noteBackgroundNames = linkedMapOf(
    null to "Default",
    "color_yellow" to "Yellow",
    "color_orange" to "Orange",
    "color_brown" to "Brown",
    "color_red" to "Red",
    "color_pink" to "Pink",
    "color_purple" to "Purple",
    "color_dark_blue" to "Indigo",
    "color_blue" to "Blue",
    "color_teal" to "Teal",
    "color_green" to "Green",
    "pattern_dots" to "Dots",
    "pattern_grid" to "Grid",
    "pattern_lines" to "Lines",
    "pattern_waves" to "Waves",
    "pattern_groceries" to "Groceries",
    "pattern_music" to "Music",
    "pattern_travel" to "Travel",
    "pattern_code" to "Code",
)

internal fun notePalette(background: String?): NotePalette? = notePalettes[background]

internal val noteHighlightNames = listOf("yellow", "green", "blue", "pink", "purple")

private val lightHighlightFills = mapOf(
    "yellow" to 0xFFFEEA74,
    "green" to 0xFFAAF5B9,
    "blue" to 0xFFAAE6FF,
    "pink" to 0xFFFFC4E1,
    "purple" to 0xFFECCFFF,
    "color_purple/purple" to 0xFFE7C4FF,
    "pattern_music/purple" to 0xFFE7C4FF,
)

private val darkHighlightFills = mapOf(
    "yellow" to 0xFF805C03,
    "green" to 0xFF047239,
    "blue" to 0xFF0A6899,
    "pink" to 0xFF9F436B,
    "purple" to 0xFF7850A1,
)

internal fun noteHighlightFill(name: String, background: String?, dark: Boolean): Long {
    val fills = if (dark) darkHighlightFills else lightHighlightFills
    return fills["$background/$name"] ?: fills.getValue(name)
}