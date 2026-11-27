package anchor

import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

private const val embeddedObject = '\uFFFC'

internal enum class InlineFormat(val key: String, val label: String, val glyph: String) {
    Bold("bold", "Bold", "B"),
    Italic("italic", "Italic", "I"),
    Underline("underline", "Underline", "U"),
    Strike("strike", "Strikethrough", "S"),
    Code("code", "Inline code", "</>"),
}

internal enum class BlockFormat(val label: String, val key: String? = null, val value: JsonPrimitive? = null) {
    Paragraph("Paragraph"),
    Heading1("Heading 1", "header", JsonPrimitive(1)),
    Heading2("Heading 2", "header", JsonPrimitive(2)),
    Heading3("Heading 3", "header", JsonPrimitive(3)),
    Bullet("Bullet list", "list", JsonPrimitive("bullet")),
    Numbered("Numbered list", "list", JsonPrimitive("ordered")),
    Checklist("Checklist", "list", JsonPrimitive("unchecked")),
    Checked("Checked item", "list", JsonPrimitive("checked")),
    Quote("Quote", "blockquote", JsonPrimitive(true)),
    Code("Code block", "code-block", JsonPrimitive("plain")),
}

private val blockKeys = BlockFormat.entries.mapNotNull { it.key }.toSet()
private val inlineKeys = InlineFormat.entries.map { it.key }.toSet() +
    setOf("link", "highlight", "font", "size", "color", "background", "script", "small", "placeholder")

internal data class DeltaBlock(val start: Int, val end: Int, val attributes: JsonObject?) {
    val indent get() = (attributes?.get("indent") as? JsonPrimitive)?.intOrNull?.coerceAtLeast(0) ?: 0
    val isList get() = format in listOf(BlockFormat.Bullet, BlockFormat.Numbered, BlockFormat.Checklist, BlockFormat.Checked)
    val isChecked get() = attributes?.get("list") == BlockFormat.Checked.value
    val isChecklist get() = isChecked || attributes?.get("list") == BlockFormat.Checklist.value
    val format: BlockFormat
        get() {
            val code = attributes?.get("code-block") as? JsonPrimitive
            if (code?.booleanOrNull == true || (code?.isString == true && code.content.isNotEmpty())) {
                return BlockFormat.Code
            }
            return BlockFormat.entries.firstOrNull { it.key != null && attributes?.get(it.key) == it.value }
                ?: BlockFormat.Paragraph
        }
}

internal data class NoteLinkTarget(val start: Int, val end: Int, val url: String?)

private fun JsonObject?.withBlock(format: BlockFormat): JsonObject? {
    val values = this.orEmpty() - blockKeys
    val key = format.key
    val value = format.value
    val updated = if (key == null || value == null) values else values + (key to value)
    return updated.takeIf { it.isNotEmpty() }?.let(::JsonObject)
}

private fun DeltaBlock.continuation(): JsonObject? = when (format) {
    BlockFormat.Checked -> JsonObject(attributes.orEmpty().filterKeys { it == "indent" }).withBlock(BlockFormat.Checklist)
    BlockFormat.Checklist, BlockFormat.Bullet, BlockFormat.Numbered, BlockFormat.Code ->
        JsonObject(attributes.orEmpty().filterKeys { it in blockKeys || it == "indent" })
    else -> null
}

private fun JsonObject?.hasFormat(format: InlineFormat) =
    (this?.get(format.key) as? JsonPrimitive)?.booleanOrNull == true

private fun JsonObject?.withFormats(formats: Map<InlineFormat, Boolean>): JsonObject? {
    if (formats.isEmpty()) return this
    val values = this?.toMutableMap() ?: mutableMapOf()
    for ((format, enabled) in formats) {
        if (enabled) values[format.key] = JsonPrimitive(true) else values.remove(format.key)
    }
    return values.takeIf { it.isNotEmpty() }?.let(::JsonObject)
}

internal class EditableDelta private constructor(
    private val root: JsonObject,
    private val segments: List<Segment>,
    private val terminalAttributes: JsonObject? = null,
) {
    private data class Segment(val op: JsonObject, val body: String?, val embed: JsonObject? = null) {
        val length get() = body?.length ?: 1
        val attributes get() = op["attributes"] as? JsonObject

        fun withText(value: String): Segment = Segment(JsonObject(op + ("insert" to JsonPrimitive(value))), value)

        fun withAttributes(value: String, updated: JsonObject?): Segment {
            val fields = (op + ("insert" to JsonPrimitive(value))) - "attributes"
            return Segment(JsonObject(if (updated == null) fields else fields + ("attributes" to updated)), value)
        }

        fun joinWith(next: Segment): Segment? {
            val left = body ?: return null
            val right = next.body ?: return null
            if ('\n' in left || '\n' in right || attributes != next.attributes) return null
            if ((op.keys + next.op.keys).any { it != "insert" && it != "attributes" }) return null
            return withText(left + right)
        }
    }

    val text = buildString {
        for (segment in segments) append(segment.body ?: embeddedObject.toString())
    }

    val blocks: List<DeltaBlock> by lazy {
        buildList {
            var start = 0
            var offset = 0
            for (segment in segments) {
                segment.body?.forEachIndexed { index, char ->
                    if (char == '\n') {
                        add(DeltaBlock(start, offset + index, segment.attributes))
                        start = offset + index + 1
                    }
                }
                offset += segment.length
            }
            add(DeltaBlock(start, text.length, terminalAttributes))
        }
    }

    fun embedLabels(): List<Pair<Int, String>> = buildList {
        var offset = 0
        for (segment in segments) {
            val embed = segment.embed
            if (embed != null) {
                val label = when {
                    "image" in embed -> "[Image]"
                    "audio" in embed -> "[Audio]"
                    else -> "[Embedded content]"
                }
                add(offset to label)
            }
            offset += segment.length
        }
    }

    fun blocksIn(start: Int, end: Int): List<DeltaBlock> {
        val last = if (start == end) end else end - 1
        return blocks.filter { it.end >= start && it.start <= last }
    }

    fun applyBlock(start: Int, end: Int, format: BlockFormat): EditableDelta {
        val targets = blocksIn(start, end)
            .filter { it.format != format }
            .associate { it.end to it.attributes.withBlock(format) }
        return writeBlockAttributes(targets)
    }

    fun toggleChecklist(selection: TextRange, format: BlockFormat, sort: Boolean): Pair<EditableDelta, TextRange> {
        val marked = applyBlock(selection.min, selection.max, format)
        if (!sort || marked === this) return marked to selection
        val block = marked.blocksIn(selection.min, selection.max).singleOrNull() ?: return marked to selection
        return marked.sortChecklist(block, selection)
    }

    private fun sortChecklist(toggledBlock: DeltaBlock, selection: TextRange): Pair<EditableDelta, TextRange> {
        val toggled = blocks.indexOf(toggledBlock)
        var first = toggled
        var last = toggled
        while (first > 0 && blocks[first - 1].isChecklist) first--
        while (last < blocks.lastIndex && blocks[last + 1].isChecklist) last++

        val subtreeEnds = IntArray(last - first + 1) { last }
        val parents = ArrayDeque<Int>()
        for (index in first..last) {
            while (parents.lastOrNull()?.let { blocks[it].indent >= blocks[index].indent } == true) {
                subtreeEnds[parents.removeLast() - first] = index - 1
            }
            parents.addLast(index)
        }
        val pending = ArrayDeque<Int>()
        fun addSiblings(start: Int, end: Int) {
            val siblings = mutableListOf<Int>()
            var index = start
            while (index <= end) {
                siblings.add(index)
                index = subtreeEnds[index - first] + 1
            }
            pending.addAll(siblings.sortedWith(compareBy<Int>({ blocks[it].isChecked }, { it == toggled })).asReversed())
        }
        addSiblings(first, last)
        val order = buildList {
            while (pending.isNotEmpty()) {
                val next = pending.removeLast()
                add(next)
                addSiblings(next + 1, subtreeEnds[next - first])
            }
        }
        if (order.indices.all { order[it] == first + it }) return this to selection

        // Move the original operations with each line, including embeds and unknown metadata.
        val implicitEnd = blocks[last].end == text.length
        val source = if (implicitEnd) segments + plainSegment("\n", terminalAttributes) else segments
        val firstOffset = blocks[first].start
        val cuts = listOf(firstOffset) + (first..last).map { blocks[it].end + 1 }
        val pieces = List(cuts.size + 1) { mutableListOf<Segment>() }
        var piece = 0
        var offset = 0
        for (segment in source) {
            var from = 0
            do {
                while (piece < cuts.size && offset == cuts[piece]) piece++
                val count = minOf(segment.length - from, (cuts.getOrNull(piece) ?: Int.MAX_VALUE) - offset)
                pieces[piece].add(if (from == 0 && count == segment.length) segment
                    else segment.withText(checkNotNull(segment.body).substring(from, from + count)))
                from += count
                offset += count
            } while (from < segment.length)
        }
        val reordered = order.flatMap { pieces[it - first + 1] }.toMutableList()
        var tail = terminalAttributes
        if (implicitEnd) {
            val end = reordered.last()
            tail = null
            if (end.op.keys.all { it == "insert" || it == "attributes" } &&
                ("attributes" !in end.op || end.attributes != null)
            ) {
                val remaining = checkNotNull(end.body).dropLast(1)
                reordered.removeLast()
                if (remaining.isNotEmpty()) reordered.add(end.withText(remaining))
                tail = end.attributes
            }
        }
        val movedBefore = order.takeWhile { it != toggled }.sumOf { blocks[it].end - blocks[it].start + 1 }
        val shift = firstOffset + movedBefore - toggledBlock.start
        val next = EditableDelta(root, pieces.first() + reordered + pieces.last(), tail)
        return next to TextRange(
            (selection.start + shift).coerceAtMost(next.text.length),
            (selection.end + shift).coerceAtMost(next.text.length),
        )
    }

    fun uncheckAll(): EditableDelta = writeBlockAttributes(blocks.filter { it.isChecked }.associate {
        it.end to JsonObject(it.attributes.orEmpty() + ("list" to checkNotNull(BlockFormat.Checklist.value)))
    })

    fun deleteCheckedItems(): EditableDelta {
        // An encoded final newline already terminates the last stored line.
        val lines = if (text.endsWith('\n') && terminalAttributes == null) blocks.dropLast(1) else blocks
        val removed = lines.filter { it.isChecked }
        if (removed.isEmpty()) return this
        if (removed.size == lines.size) return EditableDelta(root, emptyList(), null.withBlock(BlockFormat.Checklist))

        val ancestors = mutableListOf<DeltaBlock>()
        val indentChanges = buildMap {
            for (line in lines) {
                if (line.attributes?.containsKey("list") != true) {
                    ancestors.clear()
                    continue
                }
                while (ancestors.lastOrNull()?.let { it.indent >= line.indent } == true)
                    ancestors.removeAt(ancestors.lastIndex)
                val indent = line.indent - ancestors.count { it.isChecked }
                if (!line.isChecked && indent != line.indent) {
                    val fields = line.attributes.orEmpty() - "indent"
                    put(line.end, JsonObject(if (indent == 0) fields else fields + ("indent" to JsonPrimitive(indent))))
                }
                ancestors.add(line)
            }
        }
        val retained = buildList {
            var start = 0
            for (line in removed) {
                if (start < line.start) add(TextRange(start, line.start))
                start = minOf(text.length, line.end + 1)
            }
            if (start < text.length) add(TextRange(start, text.length))
        }
        val formatted = writeBlockAttributes(indentChanges)
        var offset = 0
        var rangeIndex = 0
        val kept = buildList {
            for (segment in formatted.segments) {
                val end = offset + segment.length
                while (rangeIndex < retained.size && retained[rangeIndex].start < end) {
                    val range = retained[rangeIndex]
                    val from = maxOf(range.start, offset)
                    val to = minOf(range.end, end)
                    if (from < to) {
                        add(if (from == offset && to == end) segment
                            else segment.withText(checkNotNull(segment.body).substring(from - offset, to - offset)))
                    }
                    if (range.end > end) break
                    rangeIndex++
                }
                offset = end
            }
        }
        return EditableDelta(root, kept, formatted.terminalAttributes.takeUnless { lines.last().isChecked })
    }

    fun listIndentChanges(start: Int, end: Int, direction: Int): Map<Int, JsonObject?> = buildMap {
        val last = if (start == end) end else end - 1
        var previousIndent = 0
        var previousList = false
        for (block in blocks) {
            val indent = block.indent
            val list = block.isList
            var next = indent
            if (list && block.end >= start && block.start <= last) {
                if (direction < 0 && indent > 0) next--
                if (direction > 0 && previousList && indent < 3 && indent <= previousIndent) next++
            }
            if (next != indent) {
                val fields = block.attributes.orEmpty() - "indent"
                put(block.end, JsonObject(if (next == 0) fields else fields + ("indent" to JsonPrimitive(next))))
            }
            previousIndent = next
            previousList = list
        }
    }

    fun writeBlockAttributes(targets: Map<Int, JsonObject?>): EditableDelta {
        if (targets.isEmpty()) return this
        var offset = 0
        val updated = buildList {
            for (segment in segments) {
                val base = offset
                offset += segment.length
                val body = segment.body
                if (body == null || '\n' !in body || ("attributes" in segment.op && segment.attributes == null)) {
                    add(segment)
                    continue
                }
                var from = 0
                body.forEachIndexed { index, char ->
                    val position = base + index
                    if (char == '\n' && position in targets && targets[position] != segment.attributes) {
                        if (from < index) add(segment.withText(body.substring(from, index)))
                        add(segment.withAttributes("\n", targets[position]))
                        from = index + 1
                    }
                }
                if (from < body.length) add(if (from == 0) segment else segment.withText(body.substring(from)))
            }
        }
        val tail = if (text.length in targets) targets[text.length] else terminalAttributes
        return if (updated == segments && tail == terminalAttributes) this else EditableDelta(root, updated, tail)
    }

    fun formattedText(
        codeFont: FontFamily = FontFamily.Monospace,
        highlights: Map<String, SpanStyle> = emptyMap(),
    ) = buildAnnotatedString {
        for (segment in segments) {
            val attributes = segment.attributes
            val highlight = (attributes?.get("highlight") as? JsonPrimitive)?.content
            val paint = if (segment.body == null) null else highlights[highlight]
            fun enabled(key: String) = (attributes?.get(key) as? JsonPrimitive)?.booleanOrNull == true
            val decorations = buildList {
                if (enabled("underline") || attributes?.containsKey("link") == true) add(TextDecoration.Underline)
                if (enabled("strike")) add(TextDecoration.LineThrough)
            }
            withStyle(SpanStyle(
                color = paint?.color ?: Color.Unspecified,
                background = paint?.background ?: Color.Unspecified,
                fontWeight = if (enabled("bold")) FontWeight.Bold else null,
                fontStyle = if (enabled("italic")) FontStyle.Italic else null,
                fontFamily = if (enabled("code")) codeFont else null,
                textDecoration = TextDecoration.combine(decorations),
            )) {
                // One display character per embed keeps cursor offsets unchanged.
                append(segment.body ?: if (segment.embed?.containsKey("audio") == true) "♫" else "▧")
            }
        }
    }

    fun hasFormat(format: InlineFormat, start: Int, end: Int): Boolean {
        if (start == end) {
            val caret = if (start > 0 && text[start - 1] != '\n') start - 1 else start
            return caret < text.length && hasFormat(format, caret, caret + 1)
        }
        var offset = 0
        var foundText = false
        for (segment in segments) {
            val right = offset + segment.length
            val from = maxOf(start, offset) - offset
            val to = minOf(end, right) - offset
            if (from < to && segment.body?.substring(from, to)?.any { it != '\n' } == true) {
                if (!segment.attributes.hasFormat(format)) return false
                foundText = true
            }
            offset = right
        }
        return foundText
    }

    fun format(format: InlineFormat, start: Int, end: Int, enabled: Boolean): EditableDelta =
        mapInlineAttributes(start, end) { attributes -> attributes.withFormats(mapOf(format to enabled)) }

    fun clearFormatting(start: Int, end: Int): EditableDelta =
        mapInlineAttributes(start, end) { attributes ->
            if (attributes == null || attributes.keys.none { it in inlineKeys }) attributes
            else attributes.filterKeys { it !in inlineKeys }.takeIf { it.isNotEmpty() }?.let(::JsonObject)
        }

    fun setHighlight(start: Int, end: Int, name: String?): EditableDelta =
        mapInlineAttributes(start, end) { attributes ->
            if (name == null && attributes?.containsKey("highlight") != true) return@mapInlineAttributes attributes
            val fields = attributes.orEmpty() - "highlight"
            val updated = if (name == null) fields else fields + ("highlight" to JsonPrimitive(name))
            updated.takeIf { it.isNotEmpty() }?.let(::JsonObject)
        }

    fun linkTarget(start: Int, end: Int): NoteLinkTarget? {
        if (embeddedObject in text.substring(start, end)) return null
        val ranges = mutableListOf<NoteLinkTarget>()
        var offset = 0
        for (segment in segments) {
            val body = segment.body
            val url = (segment.attributes?.get("link") as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (body != null && url != null) {
                var position = offset
                for (part in body.split('\n')) {
                    if (part.isNotEmpty()) {
                        val previous = ranges.lastOrNull()
                        if (previous?.end == position && previous.url == url) {
                            ranges[ranges.lastIndex] = previous.copy(end = position + part.length)
                        } else ranges.add(NoteLinkTarget(position, position + part.length, url))
                    }
                    position += part.length + 1
                }
            }
            offset += segment.length
        }
        if (start != end) {
            val existing = ranges.firstOrNull { it.start <= start && it.end >= end }
            return NoteLinkTarget(start, end, existing?.url)
        }
        return ranges.firstOrNull { start in it.start until it.end }
            ?: ranges.firstOrNull { start == it.end }
            ?: NoteLinkTarget(start, end, null)
    }

    fun setLink(start: Int, end: Int, url: String?): EditableDelta =
        mapInlineAttributes(start, end) { attributes ->
            val fields = attributes.orEmpty() - "link"
            val updated = if (url == null) fields else fields + ("link" to JsonPrimitive(url))
            updated.takeIf { it.isNotEmpty() }?.let(::JsonObject)
        }

    private fun mapInlineAttributes(
        start: Int,
        end: Int,
        transform: (JsonObject?) -> JsonObject?,
    ): EditableDelta {
        val left = if (start > 0 && text.getOrNull(start)?.isLowSurrogate() == true &&
            text[start - 1].isHighSurrogate()) start - 1 else start
        val right = if (end > 0 && text.getOrNull(end)?.isLowSurrogate() == true &&
            text[end - 1].isHighSurrogate()) end + 1 else end
        var offset = 0
        val formatted = buildList {
            for (segment in segments) {
                val from = maxOf(left, offset) - offset
                val to = minOf(right, offset + segment.length) - offset
                offset += segment.length
                val body = segment.body
                if (body == null || from >= to ||
                    ("attributes" in segment.op && segment.attributes == null)) {
                    add(segment)
                    continue
                }
                val attributes = transform(segment.attributes)
                val selected = body.substring(from, to)
                if (attributes == segment.attributes || selected.all { it == '\n' }) {
                    add(segment)
                    continue
                }
                if (from > 0) add(segment.withText(body.substring(0, from)))
                selected.split('\n').forEachIndexed { index, part ->
                    if (index != 0) add(segment.withText("\n"))
                    if (part.isNotEmpty()) add(segment.withAttributes(part, attributes))
                }
                if (to < body.length) add(segment.withText(body.substring(to)))
            }
        }
        return if (formatted == segments) this else EditableDelta(root, formatted, terminalAttributes)
    }

    fun changeTo(
        next: String,
        formats: Map<InlineFormat, Boolean> = emptyMap(),
        selection: TextRange? = null,
    ): EditableDelta? {
        if (next == text) return this
        // The same newline may match on both sides of the edit. Use the actual selection when it explains the change.
        val selected = selection?.takeIf {
            val insertedLength = next.length - text.length + it.length
            it.min >= 0 && it.max <= text.length && insertedLength >= 0 &&
                next.regionMatches(0, text, 0, it.min) &&
                next.regionMatches(it.min + insertedLength, text, it.max, text.length - it.max)
        }
        val start = selected?.min ?: text.commonPrefixWith(next).length
        val end = selected?.max ?: (text.length - text.substring(start).commonSuffixWith(next.substring(start)).length)
        val insert = next.substring(start, next.length - (text.length - end))
        if (embeddedObject in insert || embeddedObject in text.substring(start, end)) return null

        val before = mutableListOf<Segment>()
        val after = mutableListOf<Segment>()
        var inherited: JsonObject? = null
        var preceding: JsonObject? = null
        var offset = 0
        for (segment in segments) {
            if (segment.length == 0) {
                if (offset <= start) before.add(segment) else after.add(segment)
                continue
            }
            val right = offset + segment.length
            if (right == start && segment.body != null && !segment.body.endsWith('\n')) {
                preceding = segment.attributes
            }
            if (offset <= start && start < right && segment.body != null && segment.body[start - offset] != '\n') {
                inherited = segment.attributes
            }
            if (right <= start) before.add(segment)
            else if (offset < start) before.add(segment.withText(checkNotNull(segment.body).substring(0, start - offset)))
            if (offset >= end) after.add(segment)
            else if (right > end) after.add(segment.withText(checkNotNull(segment.body).substring(end - offset)))
            offset = right
        }

        val block = if ('\n' in insert) blocksIn(start, start).first() else null
        val continuation = block?.continuation()
        val firstNewline = if (block?.end == text.length) block.attributes
            else block?.attributes?.filterKeys { it in blockKeys || it == "indent" }
                ?.takeIf { it.isNotEmpty() }?.let(::JsonObject)
        val tail = if (block?.end == text.length) continuation else terminalAttributes
        val inserted = buildList {
            insert.split('\n').forEachIndexed { index, part ->
                if (index > 0) add(plainSegment("\n", if (index == 1) firstNewline else continuation))
                if (part.isNotEmpty()) {
                    val attributes = if (index == 0) (inherited ?: preceding).withFormats(formats) else null
                    add(plainSegment(part, attributes))
                }
            }
        }
        val changed = if (inserted.size == 1 && block == null) {
            var run = inserted.single()
            before.lastOrNull()?.joinWith(run)?.let {
                before.removeAt(before.lastIndex)
                run = it
            }
            after.firstOrNull()?.let(run::joinWith)?.let {
                after.removeAt(0)
                run = it
            }
            EditableDelta(root, before + run + after, tail)
        } else EditableDelta(root, before + inserted + after, tail)
        if (block == null || block.end == text.length || block.end < end) return changed
        val following = when (block.format) {
            BlockFormat.Checked -> BlockFormat.Checklist
            BlockFormat.Heading1, BlockFormat.Heading2, BlockFormat.Heading3 ->
                if (start == block.end) BlockFormat.Paragraph else null
            else -> null
        }
        val newEnd = block.end + next.length - text.length
        return if (following != null) changed.applyBlock(newEnd, newEnd, following) else changed
    }

    fun encode(): String {
        val last = segments.lastOrNull()
        val terminated = when {
            terminalAttributes != null -> segments + plainSegment("\n", terminalAttributes)
            text.endsWith('\n') -> segments
            last?.body != null && last.op.keys == setOf("insert") ->
                segments.dropLast(1) + last.withText(last.body + "\n")
            else -> segments + plainSegment("\n")
        }
        return JsonObject(root + ("ops" to JsonArray(terminated.map { it.op }))).toString()
    }

    companion object {
        fun empty() = EditableDelta(JsonObject(emptyMap()), emptyList())

        private fun plainSegment(body: String, attributes: JsonObject? = null): Segment = Segment(
            JsonObject(buildMap {
                put("insert", JsonPrimitive(body))
                if (attributes != null) put("attributes", attributes)
            }),
            body,
        )

        fun read(raw: String?, preview: Boolean = false): EditableDelta? {
            if (raw.isNullOrEmpty()) return empty()
            val root = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
            val ops = root["ops"] as? JsonArray ?: return null
            val segments = ops.mapNotNull { element ->
                val op = element as? JsonObject
                val insert = op?.get("insert")
                when {
                    insert is JsonPrimitive && insert.isString && (preview || embeddedObject !in insert.content) ->
                        Segment(op, insert.content)
                    insert is JsonObject -> Segment(op, null, insert)
                    preview -> null
                    else -> return null
                }
            }
            return EditableDelta(root, segments)
        }
    }
}
