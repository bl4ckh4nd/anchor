package anchor

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp

@Composable
internal fun NoteBackgroundSheet(value: String?, onClose: () -> Unit, onChange: (String?) -> Unit) {
    val (patterns, colors) = noteBackgroundNames.entries.partition { notePalette(it.key)?.pattern != null }
    val choose: (String?) -> Unit = {
        onChange(it)
        onClose()
    }
    AnchorSheet(onDismiss = onClose, title = "Background") {
        Swatches("Color", colors, value, choose, circle = true)
        Swatches("Pattern", patterns, value, choose, circle = false)
    }
}

@Composable
private fun Swatches(
    label: String,
    options: List<Map.Entry<String?, String>>,
    value: String?,
    onChange: (String?) -> Unit,
    circle: Boolean,
) {
    val dark = LocalAnchorDarkTheme.current
    val scheme = MaterialTheme.colorScheme
    val shape = if (circle) CircleShape else MaterialTheme.shapes.small
    SectionLabel(label, Modifier.padding(top = 8.dp))
    FlowRow(
        modifier = Modifier.selectableGroup().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        options.forEach { (id, name) ->
            val palette = notePalette(id)
            val selected = id == value
            val edge = palette?.let { Color(if (dark) it.darkEdge else it.lightEdge) } ?: scheme.outlineVariant
            Box(
                Modifier.size(if (circle) 48.dp else 76.dp, 48.dp)
                    .selectable(selected = selected, role = Role.RadioButton, onClick = { onChange(id) })
                    .clearAndSetSemantics {
                        contentDescription = name
                        role = Role.RadioButton
                        this.selected = selected
                        onClick {
                            onChange(id)
                            true
                        }
                    }
                    .border(if (selected) 2.dp else 0.dp, if (selected) scheme.tertiary else Color.Transparent, shape)
                    .padding(4.dp)
                    .background(scheme.surface, shape)
                    .notePaper(palette, shape)
                    .border(1.dp, edge, shape),
                contentAlignment = Alignment.Center,
            ) {
                if (palette?.pattern == null) {
                    Text("Aa", color = scheme.onSurface, style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}
