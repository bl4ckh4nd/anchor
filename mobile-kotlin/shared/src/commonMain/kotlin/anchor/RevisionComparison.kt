package anchor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp

internal enum class RevisionChange { Same, Removed, Added, Changed }

internal data class RevisionLine(
    val change: RevisionChange,
    val before: RenderedNoteBlock? = null,
    val after: RenderedNoteBlock? = null,
    val removed: List<IntRange> = emptyList(),
    val added: List<IntRange> = emptyList(),
)

private data class DiffStep(val change: RevisionChange, val index: Int, val revisedIndex: Int = index)

private fun <T> differences(before: List<T>, after: List<T>, maxCells: Int): List<DiffStep> = buildList {
    val width = after.size + 1
    if ((before.size + 1L) * width > maxCells) {
        before.indices.forEach { add(DiffStep(RevisionChange.Removed, it)) }
        after.indices.forEach { add(DiffStep(RevisionChange.Added, it)) }
        return@buildList
    }
    val common = IntArray((before.size + 1) * width)
    for (i in before.indices.reversed()) {
        for (j in after.indices.reversed()) {
            val cell = i * width + j
            common[cell] = if (before[i] == after[j]) common[cell + width + 1] + 1
                else maxOf(common[cell + width], common[cell + 1])
        }
    }
    var i = 0
    var j = 0
    while (i < before.size && j < after.size) {
        if (before[i] == after[j]) {
            add(DiffStep(RevisionChange.Same, i++, j++))
        } else if (common[(i + 1) * width + j] >= common[i * width + j + 1]) {
            add(DiffStep(RevisionChange.Removed, i++))
        } else {
            add(DiffStep(RevisionChange.Added, j++))
        }
    }
    while (i < before.size) add(DiffStep(RevisionChange.Removed, i++))
    while (j < after.size) add(DiffStep(RevisionChange.Added, j++))
}

private val tokens = Regex("\\s+|\\S+")

private fun changedLine(before: RenderedNoteBlock, after: RenderedNoteBlock): RevisionLine? {
    if (before.key == after.key) return RevisionLine(RevisionChange.Same, after)
    if (before.content.text == after.content.text) return RevisionLine(RevisionChange.Changed, before, after)
    val old = tokens.findAll(before.content.text).toList()
    val new = tokens.findAll(after.content.text).toList()
    val diff = differences(old.map { it.value }, new.map { it.value }, maxCells = 8_000)
    val common = diff.count { it.change == RevisionChange.Same && old[it.index].value.isNotBlank() }
    val words = old.count { it.value.isNotBlank() } + new.count { it.value.isNotBlank() }
    if (common * 5 < words) return null
    return RevisionLine(
        RevisionChange.Changed, before, after,
        removed = diff.filter { it.change == RevisionChange.Removed }.map { old[it.index].range },
        added = diff.filter { it.change == RevisionChange.Added }.map { new[it.index].range },
    )
}

internal fun compareRevisions(before: List<RenderedNoteBlock>, after: List<RenderedNoteBlock>): List<RevisionLine> = buildList {
    val old = before.filter { it.content.isNotBlank() || it.format != BlockFormat.Paragraph }
    val new = after.filter { it.content.isNotBlank() || it.format != BlockFormat.Paragraph }
    val keys = mutableMapOf<Triple<AnnotatedString, BlockFormat, Int>, Int>()
    val steps = differences(
        old.map { keys.getOrPut(it.key) { keys.size } },
        new.map { keys.getOrPut(it.key) { keys.size } },
        maxCells = 1_000_000,
    )
    var start = 0
    while (start < steps.size) {
        val step = steps[start]
        if (step.change == RevisionChange.Same) {
            add(RevisionLine(RevisionChange.Same, before = new[step.revisedIndex]))
            start++
            continue
        }
        var end = start + 1
        while (end < steps.size && steps[end].change != RevisionChange.Same) end++
        val group = steps.subList(start, end)
        val removed = group.filter { it.change == RevisionChange.Removed }
        val added = group.filter { it.change == RevisionChange.Added }
        for (i in 0 until maxOf(removed.size, added.size)) {
            val prior = removed.getOrNull(i)?.let { old[it.index] }
            val next = added.getOrNull(i)?.let { new[it.index] }
            val changed = if (prior != null && next != null) changedLine(prior, next) else null
            if (changed != null) {
                add(changed)
            } else {
                if (prior != null) add(RevisionLine(RevisionChange.Removed, before = prior))
                if (next != null) add(RevisionLine(RevisionChange.Added, after = next))
            }
        }
        start = end
    }
}

internal data class RevisionComparison(
    val target: String,
    val beforeTitle: String,
    val afterTitle: String,
    val lines: List<RevisionLine>,
) {
    val added = lines.count { it.change == RevisionChange.Added }
    val removed = lines.count { it.change == RevisionChange.Removed }
    val changed = lines.count { it.change == RevisionChange.Changed } + if (beforeTitle != afterTitle) 1 else 0
}

internal sealed interface ComparisonRow {
    data class Line(val index: Int) : ComparisonRow
    data class Fold(val from: Int, val until: Int) : ComparisonRow
}

internal fun comparisonLineRows(lines: List<RevisionLine>, opened: Set<Int>): List<ComparisonRow> = buildList {
    var i = 0
    while (i < lines.size) {
        if (lines[i].change != RevisionChange.Same) {
            add(ComparisonRow.Line(i++))
            continue
        }
        val start = i
        while (i < lines.size && lines[i].change == RevisionChange.Same) i++
        val from = start + if (start > 0) 2 else 0
        val hiddenEnd = i - if (i < lines.size) 2 else 0
        if (hiddenEnd - from > 2 && from !in opened) {
            for (index in start until from) add(ComparisonRow.Line(index))
            add(ComparisonRow.Fold(from, hiddenEnd))
            for (index in hiddenEnd until i) add(ComparisonRow.Line(index))
        } else {
            for (index in start until i) add(ComparisonRow.Line(index))
        }
    }
}

internal fun LazyListScope.comparisonRows(
    comparison: RevisionComparison,
    opened: Set<Int>,
    open: (Int) -> Unit,
) {
    item {
        val counts = if (comparison.added + comparison.removed + comparison.changed == 0) {
            "Same text"
        } else {
            "${comparison.added} added · ${comparison.removed} removed · ${comparison.changed} changed"
        }
        Text(counts, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
    }
    item {
        val before = AnnotatedString(comparison.beforeTitle.ifBlank { "Untitled" })
        if (comparison.beforeTitle == comparison.afterTitle) {
            Text(before, style = LocalNoteTypography.current.style(MaterialTheme.typography.titleLarge))
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                ComparisonText(before, "Previous title", added = false)
                ComparisonText(AnnotatedString(comparison.afterTitle.ifBlank { "Untitled" }), "Newer title", added = true)
            }
        }
    }
    items(
        comparisonLineRows(comparison.lines, opened),
        key = { row ->
            when (row) {
                is ComparisonRow.Line -> row.index
                is ComparisonRow.Fold -> "fold-${row.from}"
            }
        },
    ) { row ->
        when (row) {
            is ComparisonRow.Fold -> TextButton(onClick = { open(row.from) }) {
                Text("Show ${row.until - row.from} unchanged lines")
            }
            is ComparisonRow.Line -> {
                val line = comparison.lines[row.index]
                when (line.change) {
                    RevisionChange.Same -> SelectionContainer {
                        Text(checkNotNull(line.before).displayText(),
                            style = LocalNoteTypography.current.style(MaterialTheme.typography.bodyLarge))
                    }
                    RevisionChange.Removed -> ComparisonBlock(checkNotNull(line.before), "Removed", added = false)
                    RevisionChange.Added -> ComparisonBlock(checkNotNull(line.after), "Added", added = true)
                    RevisionChange.Changed -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        ComparisonBlock(checkNotNull(line.before), "Before", added = false, highlights = line.removed)
                        ComparisonBlock(checkNotNull(line.after), "After", added = true, highlights = line.added)
                    }
                }
            }
        }
    }
}

@Composable
private fun ComparisonBlock(
    block: RenderedNoteBlock,
    label: String,
    added: Boolean,
    highlights: List<IntRange>? = null,
) {
    ComparisonText(
        block.displayText(), label, added,
        highlights?.map { (it.first + block.prefix.length)..(it.last + block.prefix.length) },
    )
}

@Composable
private fun ComparisonText(
    content: AnnotatedString,
    label: String,
    added: Boolean,
    highlights: List<IntRange>? = null,
) {
    val tones = LocalAnchorTones.current
    val fill = (if (added) tones.addedInk else tones.removedInk).copy(alpha = 0.19f)
    val highlighted = buildAnnotatedString {
        append(content)
        val ranges = highlights ?: listOf(content.indices)
        for (range in ranges) {
            if (range.isEmpty()) continue
            addStyle(SpanStyle(
                background = if (highlights == null) Color.Unspecified else fill,
                textDecoration = if (added) TextDecoration.Underline else TextDecoration.LineThrough,
            ), range.first, range.last + 1)
        }
    }
    SelectionContainer(
        Modifier.fillMaxWidth()
            .background(if (highlights == null) fill else Color.Transparent, MaterialTheme.shapes.small)
            .padding(horizontal = 4.dp, vertical = 2.dp)
            .semantics { contentDescription = label },
    ) {
        Text(highlighted, style = LocalNoteTypography.current.style(MaterialTheme.typography.bodyLarge))
    }
}
