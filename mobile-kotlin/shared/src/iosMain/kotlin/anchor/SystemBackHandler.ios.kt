package anchor

import androidx.compose.runtime.Composable

@Composable
internal actual fun SystemBackHandler(enabled: Boolean, onBack: () -> Unit) = Unit
