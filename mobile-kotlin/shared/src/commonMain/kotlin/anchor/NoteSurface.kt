package anchor

import androidx.compose.foundation.background
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.translate
import org.jetbrains.compose.resources.painterResource

@Composable
internal fun Modifier.notePattern(pattern: NotePatternTile?, dark: Boolean): Modifier {
    if (pattern == null) return this
    val painter = painterResource(pattern.drawable)
    val ink = Color(if (dark) pattern.darkColor else pattern.lightColor)
    return drawWithCache {
        val tile = painter.intrinsicSize
        val tint = ColorFilter.tint(ink)
        onDrawBehind {
            clipRect {
                var y = 0f
                while (y < size.height) {
                    var x = 0f
                    while (x < size.width) {
                        translate(x, y) {
                            clipRect(right = tile.width, bottom = tile.height) {
                                with(painter) { draw(tile, colorFilter = tint) }
                            }
                        }
                        x += tile.width
                    }
                    y += tile.height
                }
            }
        }
    }
}

@Composable
internal fun Modifier.notePaper(palette: NotePalette?, shape: Shape): Modifier {
    if (palette == null) return this
    val dark = LocalAnchorDarkTheme.current
    val fill = Color(if (dark) palette.darkFill else palette.lightFill)
    return clip(shape).background(fill).notePattern(palette.pattern, dark)
}
