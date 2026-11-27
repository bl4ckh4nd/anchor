package anchor

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.withStyle

@Composable
internal fun rememberNoteHighlights(background: String? = null): Map<String, SpanStyle> {
    val dark = LocalAnchorDarkTheme.current
    val text = MaterialTheme.colorScheme.onSurface
    return remember(background, dark, text) {
        noteHighlightNames.associateWith { name ->
            val fill = Color(noteHighlightFill(name, background, dark))
            val low = minOf(fill.luminance(), text.luminance())
            val high = maxOf(fill.luminance(), text.luminance())
            val ink = when {
                (high + 0.05f) / (low + 0.05f) >= 4.5f -> text
                fill.luminance() > 0.179f -> Color.Black
                else -> Color.White
            }
            SpanStyle(color = ink, background = fill)
        }
    }
}

private data class LinePrefix(val original: Int, val transformed: Int, val insertedThroughLine: Int)

private val romanDigits = listOf(
    1000 to "m", 900 to "cm", 500 to "d", 400 to "cd", 100 to "c", 90 to "xc",
    50 to "l", 40 to "xl", 10 to "x", 9 to "ix", 5 to "v", 4 to "iv", 1 to "i",
)

private fun orderedMarker(count: Int, indent: Int): String = when (indent % 3) {
    1 -> ('a' + (count - 1) % 26).toString()
    2 -> buildString {
        var remaining = count
        for ((value, digit) in romanDigits) {
            repeat(remaining / value) { append(digit) }
            remaining %= value
        }
    }
    else -> count.toString()
}

internal data class RenderedNoteBlock(
    val content: AnnotatedString,
    val format: BlockFormat = BlockFormat.Paragraph,
    val indent: Int = 0,
    val prefix: String = "",
) {
    val key get() = Triple(content, format, indent)

    fun displayText() = buildAnnotatedString {
        append(prefix)
        append(content)
    }
}

private fun EditableDelta.renderedBlocks(
    headingStyles: List<SpanStyle>, codeFont: FontFamily, highlights: Map<String, SpanStyle>, describeEmbeds: Boolean,
): List<RenderedNoteBlock> {
    val inline = formattedText(codeFont, highlights)
    val embeds = if (describeEmbeds) embedLabels() else emptyList()
    var nextEmbed = 0
    val ordered = IntArray(9)
    return blocks.map { block ->
        val format = block.format
        val indent = block.indent.coerceIn(0, 8)
        val marker = when (format) {
            BlockFormat.Bullet -> "• "
            BlockFormat.Checklist -> "☐ "
            BlockFormat.Checked -> "☑ "
            BlockFormat.Numbered -> {
                ordered.fill(0, fromIndex = indent + 1)
                "${orderedMarker(++ordered[indent], indent)}. "
            }
            BlockFormat.Quote -> "│ "
            else -> ""
        }
        if (!block.isList) ordered.fill(0)
        val prefix = "\u00a0\u00a0".repeat(indent) + marker
        val style = when (format) {
            BlockFormat.Heading1 -> headingStyles[0]
            BlockFormat.Heading2 -> headingStyles[1]
            BlockFormat.Heading3 -> headingStyles[2]
            BlockFormat.Code -> SpanStyle(fontFamily = codeFont)
            BlockFormat.Quote -> SpanStyle(fontStyle = FontStyle.Italic)
            else -> SpanStyle()
        }
        val content = buildAnnotatedString {
            withStyle(style) {
                var start = block.start
                while (nextEmbed < embeds.size && embeds[nextEmbed].first < block.end) {
                    val (position, label) = embeds[nextEmbed++]
                    append(inline.subSequence(start, position))
                    append(label)
                    start = position + 1
                }
                append(inline.subSequence(start, block.end))
            }
        }
        RenderedNoteBlock(content, format, indent, prefix)
    }
}

internal fun revisionBlocks(
    content: String?, headingStyles: List<SpanStyle>, codeFont: FontFamily = FontFamily.Monospace,
    highlights: Map<String, SpanStyle> = emptyMap(),
): List<RenderedNoteBlock> =
    EditableDelta.read(content, preview = true)?.renderedBlocks(headingStyles, codeFont, highlights, describeEmbeds = true)
        ?: content.orEmpty().lineSequence().map { RenderedNoteBlock(AnnotatedString(it)) }.toList()

internal fun notePreviewText(
    content: String?, headingStyles: List<SpanStyle>, codeFont: FontFamily = FontFamily.Monospace,
    highlights: Map<String, SpanStyle> = emptyMap(),
) = buildAnnotatedString {
    revisionBlocks(content, headingStyles, codeFont, highlights).forEachIndexed { index, block ->
        if (index != 0) append('\n')
        append(block.displayText())
    }
}

internal fun EditableDelta.editorText(
    headingStyles: List<SpanStyle>, codeFont: FontFamily = FontFamily.Monospace,
    highlights: Map<String, SpanStyle> = emptyMap(),
): TransformedText {
    val prefixes = mutableListOf<LinePrefix>()
    var inserted = 0
    val rendered = buildAnnotatedString {
        renderedBlocks(headingStyles, codeFont, highlights, describeEmbeds = false).forEachIndexed { index, line ->
            val block = blocks[index]
            if (line.prefix.isNotEmpty()) {
                inserted += line.prefix.length
                prefixes.add(LinePrefix(block.start, length, inserted))
            }
            append(line.prefix)
            append(line.content)
            if (block.end < text.length) append('\n')
        }
    }
    val mapping = object : OffsetMapping {
        override fun originalToTransformed(offset: Int): Int {
            val match = prefixes.binarySearchBy(offset) { it.original }
            val prefix = prefixes.getOrNull(if (match >= 0) match else -match - 2)
            return offset + (prefix?.insertedThroughLine ?: 0)
        }

        override fun transformedToOriginal(offset: Int): Int {
            val match = prefixes.binarySearchBy(offset) { it.transformed }
            val prefix = prefixes.getOrNull(if (match >= 0) match else -match - 2) ?: return offset
            return maxOf(prefix.original, offset - prefix.insertedThroughLine)
        }
    }
    return TransformedText(rendered, mapping)
}
