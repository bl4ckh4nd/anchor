package anchor

import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Regressions: missing block markers or styling, false diffs from renumbering,
// missed status-only changes, and loss of plain-text or embed previews.
class RevisionBlocksTest {
    private val headings = listOf(SpanStyle(fontSize = 26.sp), SpanStyle(fontSize = 22.sp), SpanStyle(fontSize = 18.sp))

    @Test
    fun previewKeepsQuillStructureAndEmbedNames() {
        val blocks = revisionBlocks(
            """{"ops":[{"insert":"Heading"},{"insert":"\n","attributes":{"header":2}},
            {"insert":"Done"},{"insert":"\n","attributes":{"list":"checked"}},
            {"insert":"Nested"},{"insert":"\n","attributes":{"list":"ordered","indent":1}},
            {"insert":"Quote"},{"insert":"\n","attributes":{"blockquote":true}},
            {"insert":"println()"},{"insert":"\n","attributes":{"code-block":"plain"}},
            {"insert":{"image":"https://example.test/image"}},{"insert":{"audio":"https://example.test/audio"}},{"insert":"\n"}]}""",
            headings,
        )
        assertEquals(listOf("Heading", "☑ Done", "\u00a0\u00a0a. Nested", "│ Quote", "println()", "[Image][Audio]"),
            blocks.filter { it.content.isNotEmpty() }.map { it.displayText().text })
        assertTrue(blocks.first().content.spanStyles.any { it.item.fontSize == 22.sp })
        assertTrue(blocks[4].content.spanStyles.any { it.item.fontFamily == FontFamily.Monospace })
        assertEquals(listOf("Legacy", "line"), revisionBlocks("Legacy\r\nline", headings).map { it.content.text })
    }

    @Test
    fun comparisonUsesStructureAndIgnoresRenumbering() {
        val earlier = revisionBlocks(
            """{"ops":[{"insert":"Keep"},{"insert":"\n","attributes":{"list":"ordered"}},
            {"insert":"Mark"},{"insert":"\n","attributes":{"list":"unchecked"}}]}""",
            headings,
        )
        val later = revisionBlocks(
            """{"ops":[{"insert":"New"},{"insert":"\n","attributes":{"list":"ordered"}},
            {"insert":"Keep"},{"insert":"\n","attributes":{"list":"ordered"}},
            {"insert":"Mark"},{"insert":"\n","attributes":{"list":"checked"}}]}""",
            headings,
        )
        val changes = compareRevisions(earlier, later)
        assertEquals(listOf(RevisionChange.Added, RevisionChange.Same, RevisionChange.Changed), changes.map { it.change })
        assertEquals("2. Keep", changes[1].before?.displayText()?.text)
        assertEquals("☐ Mark", changes[2].before?.displayText()?.text)
        assertEquals("☑ Mark", changes[2].after?.displayText()?.text)
    }
    @Test
    fun longUnchangedSectionsFoldWithContextAndCanBeOpened() {
        val lines = List(12) { index ->
            RevisionLine(if (index == 0 || index == 11) RevisionChange.Changed else RevisionChange.Same)
        }
        val folded = comparisonLineRows(lines, emptySet())
        assertEquals(
            listOf(ComparisonRow.Line(0), ComparisonRow.Line(1), ComparisonRow.Line(2),
                ComparisonRow.Fold(3, 9), ComparisonRow.Line(9), ComparisonRow.Line(10), ComparisonRow.Line(11)),
            folded,
        )
        assertEquals(lines.indices.map { ComparisonRow.Line(it) }, comparisonLineRows(lines, setOf(3)))
    }
}
