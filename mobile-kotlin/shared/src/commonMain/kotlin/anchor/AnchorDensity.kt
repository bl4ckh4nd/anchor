// Generated from design/tokens by design/build/build.mjs. Do not edit by hand.
package anchor

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal enum class AnchorDensity(
    val label: String,
    val space8: Dp,
    val space12: Dp,
    val space16: Dp,
    val listPreviewLines: Int,
    val gridPreviewLines: Int,
    val masonryPreviewLines: Int,
    val maxPictures: Int,
    val leadingScale: Float,
) {
    Standard("Standard", 8.dp, 12.dp, 16.dp, 2, 4, 6, 4, 1.000000f),
    Compact("Compact", 4.dp, 8.dp, 12.dp, 1, 3, 4, 2, 0.911765f),
}
