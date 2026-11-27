package anchor

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.staggeredgrid.LazyStaggeredGridItemInfo
import androidx.compose.foundation.lazy.staggeredgrid.LazyStaggeredGridState
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LocalPinnableContainer
import androidx.compose.ui.layout.PinnableContainer
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex

internal class NoteOrderDrag(private val grid: LazyStaggeredGridState) {
    private var source by mutableStateOf<String?>(null)
    private var offset by mutableStateOf(Offset.Zero)
    private var start = Rect.Zero
    private var placement by mutableStateOf<Offset?>(null)
    private var pin: PinnableContainer.PinnedHandle? = null
    var target by mutableStateOf<String?>(null)
        private set

    fun isDragging(key: String): Boolean = source == key

    fun begin(key: String, container: PinnableContainer?) {
        if (source != null) return
        start = grid.layoutInfo.visibleItemsInfo.firstOrNull { it.key == key }?.bounds() ?: return
        pin = container?.pin()
        source = key
        offset = Offset.Zero
        placement = null
        target = null
    }

    fun move(key: String, amount: Offset, group: Set<String>) {
        if (source != key) return
        offset += amount
        updateTarget(key, group)
    }

    suspend fun scrollAtEdge(key: String, group: Set<String>) {
        var previous = withFrameNanos { it }
        while (source == key) {
            val frame = withFrameNanos { it }
            val elapsed = (frame - previous).coerceAtMost(32_000_000L) / 1_000_000_000f
            previous = frame
            val layout = grid.layoutInfo
            val height = layout.viewportEndOffset - layout.viewportStartOffset
            if (height <= 0) continue
            val edge = height * 0.10f
            val center = (start.center + offset).y
            val pressure = when {
                center < layout.viewportStartOffset + edge && grid.canScrollBackward ->
                    (center - layout.viewportStartOffset - edge) / edge
                center > layout.viewportEndOffset - edge && grid.canScrollForward ->
                    (center - layout.viewportEndOffset + edge) / edge
                else -> continue
            }
            grid.scrollBy(pressure.coerceIn(-1f, 1f) * height * 1.5f * elapsed)
            if (source == key) updateTarget(key, group)
        }
    }

    private fun updateTarget(key: String, group: Set<String>) {
        val center = start.center + offset
        target = grid.layoutInfo.visibleItemsInfo
            .firstOrNull { it.key != key && it.key in group && it.bounds().contains(center) }
            ?.key as? String
    }

    fun end(key: String): String? {
        if (source != key) return null
        val drop = target
        source = null
        target = null
        offset = Offset.Zero
        pin?.release()
        pin = null
        return drop
    }

    fun cardModifier(key: String): Modifier {
        if (source != key) return Modifier
        return Modifier.zIndex(1f)
            .onPlaced { placement = it.positionInParent() }
            .graphicsLayer {
                // Grid item offsets exclude the uniform content padding. Pinned items may be placed outside the viewport.
                val padding = grid.layoutInfo.beforeContentPadding.toFloat()
                val origin = start.topLeft + Offset(padding, padding)
                val translation = origin + offset - (placement ?: origin)
                translationX = translation.x
                translationY = translation.y
            }
    }

    private fun LazyStaggeredGridItemInfo.bounds(): Rect =
        Rect(offset.x.toFloat(), offset.y.toFloat(), (offset.x + size.width).toFloat(), (offset.y + size.height).toFloat())
}

@Composable
internal fun NoteDragHandle(
    title: String,
    noteKey: String,
    drag: NoteOrderDrag,
    group: Set<String>,
    modifier: Modifier,
    enabled: Boolean,
    openActions: () -> Unit,
    onDrop: (String) -> Unit,
) {
    val drop by rememberUpdatedState(onDrop)
    val ink = MaterialTheme.colorScheme.onSurfaceVariant
    val container = LocalPinnableContainer.current
    if (enabled && drag.isDragging(noteKey)) {
        LaunchedEffect(drag, noteKey, group) { drag.scrollAtEdge(noteKey, group) }
    }
    val gesture = if (enabled) {
        Modifier.pointerInput(drag, noteKey, group, container) {
            try {
                detectDragGestures(
                    onDragStart = { drag.begin(noteKey, container) },
                    onDragEnd = { drag.end(noteKey)?.let(drop) },
                    onDragCancel = { drag.end(noteKey) },
                    onDrag = { change, amount ->
                        change.consume()
                        drag.move(noteKey, amount, group)
                    },
                )
            } finally {
                drag.end(noteKey)
            }
        }
    } else Modifier
    IconButton(
        onClick = openActions,
        enabled = enabled,
        modifier = modifier.size(48.dp).semantics { contentDescription = "Drag $title" }.then(gesture),
    ) {
        Canvas(Modifier.size(20.dp)) {
            for (row in -1..1) {
                for (column in -1..1 step 2) {
                    drawCircle(ink, 1.5.dp.toPx(), center + Offset(column * 3.dp.toPx(), row * 5.dp.toPx()))
                }
            }
        }
    }
}
